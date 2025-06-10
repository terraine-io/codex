#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';
import { AgentLoopFactory, type IAgentLoop, type CommandConfirmation } from './src/utils/agent/index.js';
import type { ApplyPatchCommand, ApprovalPolicy } from './src/approvals.js';
import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import type { AppConfig } from './src/utils/config.js';
import { ReviewDecision } from './src/utils/agent/review.js';
import { ContextManager, createContextManager, type ContextInfo } from './context-managers.js';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { initLogger, debug } from './src/utils/logger/log.js';

// Load environment variables and configure working directory
function initializeEnvironment() {
  // Load .env file if it exists
  config();

  // Determine which provider will be used to check for appropriate API key
  const model = process.env.MODEL || 'codex-mini-latest';
  const provider = process.env.PROVIDER || AgentLoopFactory.detectProvider(model);

  // Check for required API key based on provider
  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('❌ Error: ANTHROPIC_API_KEY environment variable is not set');
      console.error('Please set your Anthropic API key:');
      console.error('  export ANTHROPIC_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://console.anthropic.com/');
      process.exit(1);
    }
    console.log('✅ ANTHROPIC_API_KEY is set');
  } else if (provider === 'google') {
    if (!process.env.GOOGLE_API_KEY && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      console.error('❌ Error: GOOGLE_API_KEY or GOOGLE_APPLICATION_CREDENTIALS environment variable is not set');
      console.error('Please set your Google API key:');
      console.error('  export GOOGLE_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://makersuite.google.com/app/apikey');
      process.exit(1);
    }
    console.log('✅ Google API key is set');
  } else {
    // Default to OpenAI
    if (!process.env.OPENAI_API_KEY) {
      console.error('❌ Error: OPENAI_API_KEY environment variable is not set');
      console.error('Please set your OpenAI API key:');
      console.error('  export OPENAI_API_KEY="your-api-key-here"');
      console.error('');
      console.error('You can get an API key from: https://platform.openai.com/account/api-keys');
      process.exit(1);
    }
    console.log('✅ OPENAI_API_KEY is set');
  }

  // Configure working directory if specified
  const workingDir = process.env.WORKING_DIRECTORY;
  if (workingDir) {
    const absolutePath = resolve(workingDir);

    if (!existsSync(absolutePath)) {
      console.error(`❌ Error: Working directory does not exist: ${absolutePath}`);
      console.error('Please create the directory or update WORKING_DIRECTORY in your .env file');
      process.exit(1);
    }

    try {
      process.chdir(absolutePath);
      console.log(`✅ Changed working directory to: ${absolutePath}`);
    } catch (error) {
      console.error(`❌ Error: Failed to change to working directory: ${error.message}`);
      process.exit(1);
    }
  } else {
    console.log(`ℹ️  Using current working directory: ${process.cwd()}`);
  }
}

// Message types for WebSocket communication
interface WSMessage {
  id: string;
  type: string;
  payload?: any;
}

interface UserInputMessage extends WSMessage {
  type: 'user_input';
  payload: {
    input: Array<ResponseInputItem>;
    previousResponseId?: string;
  };
}

interface ApprovalRequestMessage extends WSMessage {
  type: 'approval_request';
  payload: {
    command: Array<string>;
    applyPatch?: ApplyPatchCommand;
  };
}

interface ApprovalResponseMessage extends WSMessage {
  type: 'approval_response';
  payload: CommandConfirmation;
}

interface ResponseItemMessage extends WSMessage {
  type: 'response_item';
  payload: ResponseItem;
}

interface LoadingStateMessage extends WSMessage {
  type: 'loading_state';
  payload: { loading: boolean };
}

interface ErrorMessage extends WSMessage {
  type: 'error';
  payload: { message: string; details?: any };
}

interface AgentFinishedMessage extends WSMessage {
  type: 'agent_finished';
  payload: { responseId: string };
}

interface ContextInfoMessage extends WSMessage {
  type: 'context_info';
  payload: ContextInfo;
}

interface ContextCompactedMessage extends WSMessage {
  type: 'context_compacted';
  payload: {
    oldTokenCount: number;
    newTokenCount: number;
    reductionPercent: number;
    strategy: string;
  };
}

// Types for artifacts
interface ArtifactItem {
  file_path: string;
  overview: string;
}

interface ArtifactsIndex {
  artifacts_root_path: string;
  artifacts: ArtifactItem[];
}

// Types for session management
interface SessionEvent {
  timestamp: string;
  event_type: 'websocket_message_received' | 'websocket_message_sent';
  direction: 'incoming' | 'outgoing';
  message_data: any;
}

interface SessionInfo {
  session_id: string;
  start_time: string;
  last_activity: string;
  event_count: number;
}

class WebSocketAgentServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private agentLoop: IAgentLoop | null = null;
  private ws: WebSocket | null = null;
  private contextManager: ContextManager | null = null;
  private pendingApprovalRequest: {
    resolve: (confirmation: CommandConfirmation) => void;
    reject: (error: Error) => void;
    command: Array<string>;
    applyPatch?: ApplyPatchCommand;
  } | null = null;
  private allowedOrigins: Set<string>;
  private currentSessionId: string | null = null;
  private sessionStorePath: string | null = null;
  private messageFragments: Map<string, ResponseItem[]> = new Map();

  // Fragment collection for turn-based message logging:
  // Collects streaming message fragments during a conversation turn and combines
  // them into complete messages for session logging while preserving real-time
  // streaming to the client.
  private currentTurnFragments: ResponseItem[] = [];
  // Note: lastResponseId is not needed when disableResponseStorage: true

  constructor(port: number = 8080) {
    // Parse allowed origins from environment variable
    this.allowedOrigins = this.parseAllowedOrigins();

    // Initialize session storage
    this.initializeSessionStorage();

    // Create HTTP server first
    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    // Create WebSocket server using the HTTP server
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info) => this.verifyClient(info)
    });

    this.setupWebSocketServer();

    // Start the HTTP server
    this.httpServer.listen(port, () => {
      console.log(`HTTP/WebSocket server started on port ${port}`);
      console.log(`✅ CORS origin validation enabled for: ${Array.from(this.allowedOrigins).join(', ')}`);
    });
  }

  private parseAllowedOrigins(): Set<string> {
    const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;

    if (!allowedOriginsEnv || allowedOriginsEnv.trim() === '') {
      // Default to localhost:8081 for security
      return new Set(['http://localhost:8081']);
    }

    // Split by comma and trim whitespace
    const origins = allowedOriginsEnv
      .split(',')
      .map(origin => origin.trim())
      .filter(origin => origin.length > 0);

    if (origins.length === 0) {
      // Default to localhost:8081 for security
      return new Set(['http://localhost:8081']);
    }

    return new Set(origins);
  }

  private verifyClient(info: { origin: string; secure: boolean; req: any }): boolean {
    const { origin } = info;

    // Allow connections without origin (e.g., from non-browser clients like curl, Postman, etc.)
    if (!origin) {
      console.log('🔓 WebSocket connection allowed: No origin header (likely non-browser client)');
      return true;
    }

    // Check if the origin is in the allowed list
    if (this.allowedOrigins.has(origin)) {
      console.log(`✅ WebSocket connection allowed from origin: ${origin}`);
      return true;
    }

    console.log(`❌ WebSocket connection rejected from origin: ${origin}`);
    console.log(`   Allowed origins: ${Array.from(this.allowedOrigins).join(', ')}`);
    return false;
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    console.log(`🌐 Incoming HTTP request: ${req.method} ${req.url}`);
    console.log(`   Headers: ${JSON.stringify(req.headers, null, 2)}`);

    // Check if this is a WebSocket upgrade request - if so, let the WebSocket server handle it
    if (req.headers.upgrade === 'websocket') {
      console.log('⬆️  WebSocket upgrade request detected, skipping HTTP handling');
      return; // Let the WebSocket server handle this
    }

    const origin = req.headers.origin;

    // Set CORS headers
    this.setCorsHeaders(res, origin);

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Parse URL and route to appropriate handler
    if (!req.url) {
      this.sendHttpError(res, 400, 'Bad Request: No URL provided');
      return;
    }

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      this.routeHttpRequest(req.method || 'GET', url.pathname, req, res);
    } catch (error) {
      console.error('Error parsing URL:', error);
      this.sendHttpError(res, 400, 'Bad Request: Invalid URL');
    }
  }

  private setCorsHeaders(res: ServerResponse, origin?: string): void {
    // Check if origin is allowed (same logic as WebSocket)
    if (origin && this.allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      console.log(`✅ HTTP CORS allowed for origin: ${origin}`);
    } else if (!origin) {
      // Allow non-browser clients (no origin header)
      res.setHeader('Access-Control-Allow-Origin', '*');
      console.log('🔓 HTTP request allowed: No origin header (likely non-browser client)');
    } else {
      // Origin not allowed - don't set CORS headers
      console.log(`❌ HTTP CORS rejected for origin: ${origin}`);
      console.log(`   Allowed origins: ${Array.from(this.allowedOrigins).join(', ')}`);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  }

  private routeHttpRequest(method: string, pathname: string, req: IncomingMessage, res: ServerResponse): void {
    console.log(`📡 HTTP ${method} ${pathname}`);

    if (method === 'GET' && pathname === '/sessions') {
      this.handleGetSessions(req, res);
    } else if (method === 'GET' && pathname === '/artifacts') {
      this.handleGetArtifacts(req, res);
    } else {
      this.sendHttpError(res, 404, 'Not Found');
    }
  }

  private handleGetSessions(req: IncomingMessage, res: ServerResponse): void {
    try {
      const sessions = this.loadSessionsList();
      this.sendJsonResponse(res, 200, { sessions });
    } catch (error) {
      console.error('Error handling /sessions request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading sessions');
    }
  }

  private loadSessionsList(): SessionInfo[] {
    if (!this.sessionStorePath) {
      return []; // No session storage configured
    }

    try {
      if (!existsSync(this.sessionStorePath)) {
        return [];
      }

      const files = readdirSync(this.sessionStorePath);
      const sessionFiles = files.filter(file => file.endsWith('.jsonl'));

      const sessions: SessionInfo[] = [];

      for (const file of sessionFiles) {
        try {
          const sessionId = file.replace('.jsonl', '');
          const filePath = join(this.sessionStorePath, file);
          const stats = statSync(filePath);

          // Read first and last lines to get start time and event count
          const content = readFileSync(filePath, 'utf-8');
          const lines = content.trim().split('\n').filter(line => line.length > 0);

          if (lines.length === 0) {
            continue; // Skip empty files
          }

          const firstEvent: SessionEvent = JSON.parse(lines[0]);
          const lastEvent: SessionEvent = JSON.parse(lines[lines.length - 1]);

          const sessionInfo: SessionInfo = {
            session_id: sessionId,
            start_time: firstEvent.timestamp,
            last_activity: lastEvent.timestamp,
            event_count: lines.length
          };

          sessions.push(sessionInfo);
        } catch (error) {
          console.error(`Error processing session file ${file}:`, error.message);
          // Continue with other files
        }
      }

      // Sort by start time (newest first)
      sessions.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

      return sessions;

    } catch (error) {
      console.error('Error loading sessions list:', error);
      return [];
    }
  }

  private handleGetArtifacts(req: IncomingMessage, res: ServerResponse): void {
    try {
      const artifactsIndex = this.loadArtifactsIndex();

      if (!artifactsIndex) {
        // Return empty list if no index file is configured or available
        this.sendJsonResponse(res, 200, { artifacts: [] });
        return;
      }

      // Add relative_file_path to each artifact and rename overview to overview_md
      const enrichedArtifacts = artifactsIndex.artifacts.map(artifact => ({
        file_path: artifact.file_path,
        overview_md: artifact.overview,
        relative_file_path: basename(artifact.file_path)
      }));

      // Return the artifacts from the index file
      this.sendJsonResponse(res, 200, {
        artifacts: enrichedArtifacts,
        artifacts_root_path: artifactsIndex.artifacts_root_path
      });

    } catch (error) {
      console.error('Error handling /artifacts request:', error);
      this.sendHttpError(res, 500, 'Internal server error while loading artifacts');
    }
  }

  private sendJsonResponse(res: ServerResponse, statusCode: number, data: any): void {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(statusCode);
    res.end(JSON.stringify(data, null, 2));
  }

  private sendHttpError(res: ServerResponse, statusCode: number, message: string): void {
    this.sendJsonResponse(res, statusCode, { error: message });
  }

  private initializeSessionStorage(): void {
    const sessionStorePath = process.env.SESSION_STORE_PATH;

    if (!sessionStorePath) {
      console.log('⚠️  SESSION_STORE_PATH not configured, session logging disabled');
      return;
    }

    try {
      // Create directory if it doesn't exist
      if (!existsSync(sessionStorePath)) {
        mkdirSync(sessionStorePath, { recursive: true });
        console.log(`📁 Created session store directory: ${sessionStorePath}`);
      }

      this.sessionStorePath = sessionStorePath;
      console.log(`✅ Session logging enabled, storing in: ${sessionStorePath}`);

    } catch (error) {
      console.error(`❌ Failed to initialize session storage: ${error.message}`);
      this.sessionStorePath = null;
    }
  }

  private generateSessionId(): string {
    return randomUUID().replace(/-/g, '');
  }

  private startNewSession(): void {
    if (!this.sessionStorePath) {
      return; // Session logging not configured
    }

    this.currentSessionId = this.generateSessionId();
    const sessionEvent: SessionEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'websocket_message_received',
      direction: 'incoming',
      message_data: { event: 'session_started' }
    };

    this.logSessionEvent(sessionEvent);
    console.log(`🆔 Started new session: ${this.currentSessionId}`);
  }

  private logSessionEvent(event: SessionEvent): void {
    if (!this.sessionStorePath || !this.currentSessionId) {
      return;
    }

    try {
      const sessionFile = join(this.sessionStorePath, `${this.currentSessionId}.jsonl`);
      const eventLine = JSON.stringify(event) + '\n';
      appendFileSync(sessionFile, eventLine);
    } catch (error) {
      console.error(`❌ Failed to log session event: ${error.message}`);
    }
  }

  private endSession(): void {
    if (!this.currentSessionId || !this.sessionStorePath) {
      return;
    }

    const sessionEvent: SessionEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'websocket_message_received',
      direction: 'incoming',
      message_data: { event: 'session_ended' }
    };

    this.logSessionEvent(sessionEvent);
    console.log(`🔚 Ended session: ${this.currentSessionId}`);
    this.currentSessionId = null;
  }

  private logIncomingMessage(message: WSMessage): void {
    if (!this.currentSessionId) {
      return;
    }

    const sessionEvent: SessionEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'websocket_message_received',
      direction: 'incoming',
      message_data: message
    };

    this.logSessionEvent(sessionEvent);
  }

  private logOutgoingMessage(message: WSMessage): void {
    if (!this.currentSessionId) {
      return;
    }

    const sessionEvent: SessionEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'websocket_message_sent',
      direction: 'outgoing',
      message_data: message
    };

    this.logSessionEvent(sessionEvent);
  }

  private loadArtifactsIndex(): ArtifactsIndex | null {
    const artifactsIndexPath = process.env.ARTIFACTS_INDEX_PATH;

    if (!artifactsIndexPath) {
      console.log('⚠️  ARTIFACTS_INDEX_PATH not configured, returning empty artifacts list');
      return null;
    }

    if (!existsSync(artifactsIndexPath)) {
      console.error(`❌ Artifacts index file not found: ${artifactsIndexPath}`);
      return null;
    }

    try {
      const fileContent = readFileSync(artifactsIndexPath, 'utf-8');
      const artifactsIndex: ArtifactsIndex = JSON.parse(fileContent);

      // Validate the structure
      if (!artifactsIndex.artifacts_root_path || !Array.isArray(artifactsIndex.artifacts)) {
        console.error('❌ Invalid artifacts index structure');
        return null;
      }

      console.log(`✅ Loaded ${artifactsIndex.artifacts.length} artifacts from ${artifactsIndexPath}`);
      return artifactsIndex;

    } catch (error) {
      console.error(`❌ Error reading artifacts index file: ${error.message}`);
      return null;
    }
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws) => {
      console.log('Client connected - initializing new session');
      this.ws = ws;

      // Start new session for logging
      this.startNewSession();

      // Initialize AgentLoop when client connects
      this.initializeAgentLoop();

      ws.on('message', async (data) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());

          // Log incoming message
          this.logIncomingMessage(message);

          await this.handleMessage(message);
        } catch (error) {
          console.error('Error handling message:', error);
          this.sendError('Invalid message format', error);
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected');
        this.endSession();
        this.cleanup();
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.endSession();
        this.cleanup();
      });
    });
  }

  private initializeAgentLoop(seedInput?: Array<ResponseInputItem>) {
    // Clean up any existing agent loop and reset state
    if (this.agentLoop) {
      console.log('Terminating existing AgentLoop');
      this.agentLoop.terminate();
    }

    // Reset all session state for new client
    this.pendingApprovalRequest = null;
    console.log('Creating new AgentLoop with fresh state');

    // Determine provider from environment or auto-detect from model
    const model = process.env.MODEL || 'codex-mini-latest';
    const provider = (process.env.PROVIDER as 'openai' | 'anthropic' | 'google') ||
                    AgentLoopFactory.detectProvider(model);

    // Choose the appropriate API key based on provider
    let apiKey: string;
    if (provider === 'anthropic') {
      apiKey = process.env.ANTHROPIC_API_KEY || '';
    } else if (provider === 'google') {
      apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    } else {
      apiKey = process.env.OPENAI_API_KEY || '';
    }

    // Default configuration - you can modify this based on your needs
    const config: AppConfig = {
      model, // Use same default as TUI for better tool behavior
      instructions: process.env.INSTRUCTIONS || '', // Allow instructions override via env
      apiKey,
    };

    const approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default

    // Initialize context manager if not exists or reset if recreating
    if (!this.contextManager) {
      // Initialize context manager using factory
      const strategy = process.env.CONTEXT_STRATEGY || 'threshold';
      this.contextManager = createContextManager(strategy, {
        model: config.model || 'codex-mini-latest',
        compactionThreshold: parseFloat(process.env.CONTEXT_COMPACTION_THRESHOLD || '0.8'),
        config
      });

      console.log(`Using context management strategy: ${this.contextManager.getStrategyName()}`);

      // Set up auto-compaction callback
      this.contextManager.onCompactionNeeded = async (transcript) => {
        await this.handleAutoCompaction();
      };
    } else {
      // Clear context manager state for fresh start
      this.contextManager.clear();
    }

    console.log(`🤖 SERVER: Creating AgentLoop with provider: ${provider}, model: ${model}`);

    this.agentLoop = AgentLoopFactory.create({
      model,
      provider,
      config,
      instructions: config.instructions,
      approvalPolicy,
      additionalWritableRoots: [process.cwd()],
      disableResponseStorage: true,

      // Callback for streaming response items back to client
      onItem: (item: ResponseItem) => {
        // console.log(`📨 SERVER: Received response item type: ${item.type}, id: ${item.id}${item.type === 'local_shell_call' ? ` (command: ${(item as any).action?.command?.join(' ')})` : ''}`);

        // Add to context manager first for tracking
        this.contextManager?.addItem(item);

        // STREAMING FRAGMENT COLLECTION:
        // Collect message fragments for session logging while continuing to stream to client.
        // This allows us to log complete messages instead of individual fragments.
        if (item.type === 'message') {
          this.currentTurnFragments.push(item);
        }

        // console.log(`📤 SERVER: Sending response item to client: ${item.type}`);
        // Then send to client
        this.sendMessage({
          id: randomUUID(),
          type: 'response_item',
          payload: item,
        });
      },

      // Callback for loading state changes
      onLoading: (loading: boolean) => {
        // TURN START: Clear fragments when starting a new conversation turn
        // This ensures we collect only fragments belonging to the current turn
        if (loading) {
          this.currentTurnFragments = [];
        }

        this.sendMessage({
          id: randomUUID(),
          type: 'loading_state',
          payload: { loading },
        });
      },

      // Callback for approval requests - this is where we handle user interaction
      getCommandConfirmation: async (
        command: Array<string>,
        applyPatch?: ApplyPatchCommand
      ): Promise<CommandConfirmation> => {
        console.log(`🔒 SERVER: Requesting approval for command: ${command.join(' ')}`);
        return new Promise((resolve, reject) => {
          // Store the pending request
          this.pendingApprovalRequest = {
            resolve,
            reject,
            command,
            applyPatch,
          };

          console.log(`📤 SERVER: Sending approval request to client`);
          // Send approval request to client
          this.sendMessage({
            id: randomUUID(),
            type: 'approval_request',
            payload: {
              command,
              applyPatch,
            },
          });
          console.log(`⏳ SERVER: Waiting for approval response...`);
        });
      },

      // Callback for tracking response IDs
      onLastResponseId: (responseId: string) => {
        // TURN END: Log collected message fragments as a complete message
        // This combines all streaming fragments from this turn into a single
        // session log entry, avoiding multiple partial message entries
        this.logCollectedTurnFragments(responseId);

        // Send context info with agent finished message
        const contextInfo = this.contextManager?.getContextInfo();

        this.sendMessage({
          id: randomUUID(),
          type: 'agent_finished',
          payload: { responseId },
        });

        // Send current context info
        if (contextInfo) {
          this.sendMessage({
            id: randomUUID(),
            type: 'context_info',
            payload: contextInfo,
          });
        }
      },
    });

    // If we have seed input (from compaction), run it to initialize the transcript
    if (seedInput && seedInput.length > 0) {
      console.log('Seeding new AgentLoop with compacted context...');
      // Run the seed input to initialize the AgentLoop's internal transcript
      this.agentLoop.run(seedInput).catch(error => {
        console.error('Error seeding AgentLoop:', error);
        this.sendError('Failed to seed AgentLoop with compacted context', error);
      });
    }
  }

  /**
   * Logs collected streaming fragments as a complete message for session storage.
   *
   * FRAGMENT COLLECTION WORKFLOW:
   * 1. Turn Start: onLoading(true) → Clear currentTurnFragments
   * 2. Streaming: onItem() called with message fragments → Add to currentTurnFragments
   * 3. Turn End: onLastResponseId() → Combine fragments and log as complete message
   * 4. Continue streaming to client: Individual fragments still sent to client in real-time
   *
   * This approach ensures session logs contain complete messages instead of multiple
   * partial message events, while preserving the real-time streaming experience for clients.
   */
  private logCollectedTurnFragments(responseId: string): void {
    if (this.currentTurnFragments.length === 0) {
      return; // No fragments to log for this turn
    }

    // Combine all message fragments into a single complete message
    const completeMessage = this.combineMessageFragments(this.currentTurnFragments);

    if (completeMessage) {
      // Log the complete message instead of individual fragments
      const sessionEvent: SessionEvent = {
        timestamp: new Date().toISOString(),
        event_type: 'websocket_message_sent',
        direction: 'outgoing',
        message_data: {
          id: randomUUID(),
          type: 'response_item',
          payload: completeMessage,
        }
      };

      this.logSessionEvent(sessionEvent);
    }

    // Clear the fragments for the next turn
    this.currentTurnFragments = [];
  }

  /**
   * Combines streaming message fragments into a single complete message.
   * Takes multiple message fragments with partial text content and merges
   * them into one message with the full combined text.
   */
  private combineMessageFragments(fragments: ResponseItem[]): ResponseItem | null {
    if (fragments.length === 0) {
      return null;
    }

    // Use the first fragment as the base and combine content from all fragments
    const baseMessage = { ...fragments[0] };

    // Combine all text content from fragments
    let combinedText = '';
    for (const fragment of fragments) {
      if (fragment.content && Array.isArray(fragment.content)) {
        for (const contentItem of fragment.content) {
          if (contentItem.type === 'output_text') {
            combinedText += contentItem.text || '';
          }
        }
      }
    }

    // Update the content with the combined text
    if (baseMessage.content && Array.isArray(baseMessage.content)) {
      baseMessage.content = [{
        type: 'output_text',
        text: combinedText,
        annotations: []
      }];
    }

    return baseMessage;
  }

  private async handleMessage(message: WSMessage) {
    switch (message.type) {
      case 'user_input':
        await this.handleUserInput(message as UserInputMessage);
        break;

      case 'approval_response':
        await this.handleApprovalResponse(message as ApprovalResponseMessage);
        break;

      case 'get_context_info':
        this.handleGetContextInfo();
        break;

      case 'manual_compact':
        await this.handleManualCompaction();
        break;

      default:
        this.sendError(`Unknown message type: ${message.type}`);
    }
  }

  private async handleUserInput(message: UserInputMessage) {
    if (!this.agentLoop || !this.contextManager) {
      this.sendError('AgentLoop not initialized');
      return;
    }

    try {
      const { input } = message.payload;

      // Add user input to context manager for tracking
      this.contextManager.addUserInput(input);

      // Check if we're approaching context limits before processing
      const contextInfo = this.contextManager.getContextInfo();
      if (contextInfo.usagePercent > 90) {
        console.log(`Context usage high (${contextInfo.usagePercent.toFixed(1)}%), considering auto-compaction`);
      }

      // Since we're using disableResponseStorage: true, we don't need previousResponseId
      // Each request is self-contained and doesn't rely on server-side conversation state
      await this.agentLoop.run(input);

    } catch (error) {
      console.error('Error running AgentLoop:', error);
      this.sendError('Failed to process user input', error);
    }
  }

  private async handleApprovalResponse(message: ApprovalResponseMessage) {
    if (!this.pendingApprovalRequest) {
      this.sendError('No pending approval request');
      return;
    }

    try {
      console.log(`✅ SERVER: Received approval response: ${message.payload.review}`);

      // Handle explanation request specially
      if (message.payload.review === 'explain') {
        console.log(`🤔 SERVER: Handling explanation request`);

        try {
          // Generate explanation using AI model
          const explanation = await this.generateCommandExplanation(this.pendingApprovalRequest.command);

          // Send explanation message back to client
          this.sendMessage({
            id: randomUUID(),
            type: 'response_item',
            payload: {
              id: randomUUID(),
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'input_text',
                text: explanation
              }]
            }
          });

        } catch (error) {
          console.error('Failed to generate explanation:', error);
          this.sendMessage({
            id: randomUUID(),
            type: 'response_item',
            payload: {
              id: randomUUID(),
              type: 'message',
              role: 'assistant',
              content: [{
                type: 'input_text',
                text: `Unable to generate explanation for command "${this.pendingApprovalRequest.command.join(' ')}" due to an error. Please make a decision on whether to approve this command.`
              }]
            }
          });
        }

        // Send a new approval request (don't resolve the promise yet)
        this.sendMessage({
          id: randomUUID(),
          type: 'approval_request',
          payload: {
            command: this.pendingApprovalRequest.command,
            applyPatch: this.pendingApprovalRequest.applyPatch,
          },
        });

        console.log(`📤 SERVER: Sent explanation and renewed approval request`);
        return; // Don't resolve the approval yet
      }

      console.log(`🚀 SERVER: Resolving approval promise - command can now execute`);

      // Resolve the pending approval request with the user's decision
      this.pendingApprovalRequest.resolve(message.payload);
      this.pendingApprovalRequest = null;

      console.log(`📝 SERVER: Approval resolved, AgentLoop should continue execution`);
    } catch (error) {
      console.error('Error handling approval response:', error);
      this.sendError('Failed to process approval response', error);
    }
  }

  private sendMessage(message: WSMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // FRAGMENT LOGGING FILTER:
      // Skip logging individual message fragments to avoid duplicate entries.
      // Message fragments are collected and logged as complete messages when
      // the conversation turn ends (see logCollectedTurnFragments).
      // Non-message items (function calls, loading states, etc.) are logged immediately.
      const shouldLogFragment = message.type === 'response_item' &&
                                 message.payload?.type === 'message';

      if (!shouldLogFragment) {
        this.logOutgoingMessage(message);
      }

      this.ws.send(JSON.stringify(message));
    }
  }

  private sendError(message: string, details?: any) {
    this.sendMessage({
      id: randomUUID(),
      type: 'error',
      payload: { message, details },
    });
  }

  private async handleAutoCompaction(): Promise<void> {
    if (!this.contextManager) {
      console.error('Cannot compact: ContextManager not initialized');
      return;
    }

    try {
      console.log('🗜️ Performing automatic context compaction...');

      const oldTokenCount = this.contextManager.getTokenCount();

      // Generate compacted summary
      const summaryItem = await this.contextManager.compact();

      // Get seed input for new AgentLoop
      const seedInput = this.contextManager.getCompactedSeedInput();

      // Recreate AgentLoop with compacted context
      this.initializeAgentLoop(seedInput);

      const newTokenCount = this.contextManager.getTokenCount();
      const reductionPercent = ((oldTokenCount - newTokenCount) / oldTokenCount) * 100;

      // Notify client about successful compaction
      this.sendMessage({
        id: randomUUID(),
        type: 'context_compacted',
        payload: {
          oldTokenCount,
          newTokenCount,
          reductionPercent,
          strategy: this.contextManager.getStrategyName()
        }
      });

      console.log(`✅ Context compacted: ${oldTokenCount} → ${newTokenCount} tokens (${reductionPercent.toFixed(1)}% reduction)`);

    } catch (error) {
      console.error('❌ Auto-compaction failed:', error);

      // Send error to client
      this.sendError('Automatic context compaction failed', {
        error: error.message,
        context: 'auto_compaction'
      });
    }
  }

  private async handleManualCompaction(): Promise<void> {
    console.log('🗜️ Manual context compaction requested');
    await this.handleAutoCompaction();
  }

  private handleGetContextInfo(): void {
    if (!this.contextManager) {
      this.sendError('ContextManager not initialized');
      return;
    }

    const contextInfo = this.contextManager.getContextInfo();
    this.sendMessage({
      id: randomUUID(),
      type: 'context_info',
      payload: contextInfo,
    });
  }

  private async generateCommandExplanation(command: Array<string>): Promise<string> {
    try {
      console.log(`🤖 SERVER: Generating explanation for command: ${command.join(' ')}`);

      // Create OpenAI client (reuse the same configuration as AgentLoop)
      const OpenAI = (await import('openai')).default;
      const oai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: 30000, // 30 second timeout for explanation
      });

      // Format the command for display
      const commandForDisplay = command.join(' ');

      // Create explanation request (same prompt as TUI)
      const response = await oai.chat.completions.create({
        model: 'gpt-4', // Use a reliable model for explanations
        messages: [
          {
            role: 'system',
            content: 'You are an expert in shell commands and terminal operations. Your task is to provide detailed, accurate explanations of shell commands that users are considering executing. Break down each part of the command, explain what it does, identify any potential risks or side effects, and explain why someone might want to run it. Be specific about what files or systems will be affected. If the command could potentially be harmful, make sure to clearly highlight those risks.',
          },
          {
            role: 'user',
            content: `Please explain this shell command in detail: \`${commandForDisplay}\`\n\nProvide a structured explanation that includes:\n1. A brief overview of what the command does\n2. A breakdown of each part of the command (flags, arguments, etc.)\n3. What files, directories, or systems will be affected\n4. Any potential risks or side effects\n5. Why someone might want to run this command\n\nBe specific and technical - this explanation will help the user decide whether to approve or reject the command.`,
          },
        ],
      });

      const explanation = response.choices[0]?.message.content || 'Unable to generate explanation.';
      console.log(`✅ SERVER: Generated explanation (${explanation.length} chars)`);
      return explanation;

    } catch (error) {
      console.error('❌ SERVER: Error generating command explanation:', error);
      throw error;
    }
  }

  private cleanup() {
    // End session if still active
    if (this.currentSessionId) {
      this.endSession();
    }

    if (this.agentLoop) {
      this.agentLoop.terminate();
      this.agentLoop = null;
    }

    if (this.contextManager) {
      this.contextManager.clear();
      this.contextManager = null;
    }

    if (this.pendingApprovalRequest) {
      this.pendingApprovalRequest.reject(new Error('Connection closed'));
      this.pendingApprovalRequest = null;
    }

    // Clear any remaining message fragments
    this.messageFragments.clear();
    this.currentTurnFragments = [];

    this.ws = null;
  }

  public close() {
    this.cleanup();
    this.wss.close();
    this.httpServer.close();
  }

  // Public methods for monitoring and control
  public getContextInfo(): ContextInfo | null {
    return this.contextManager?.getContextInfo() || null;
  }

  public async manualCompact(): Promise<void> {
    await this.handleManualCompaction();
  }
}

// Initialize environment and working directory before starting server
initializeEnvironment();

// Initialize logger and show current log level
const logger = initLogger();
if (logger.isLoggingEnabled()) {
  const logLevel = process.env.LOG_LEVEL || process.env.DEBUG || 'none';
  debug(`🐛 Logging enabled with level: ${logLevel.toUpperCase()}`);
}

// Example usage
const server = new WebSocketAgentServer(8080);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down server...');
  server.close();
  process.exit(0);
});