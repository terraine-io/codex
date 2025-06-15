#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import { readFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync, writeFileSync, symlinkSync, lstatSync, rmSync, renameSync, readlinkSync, createWriteStream } from 'fs';
import { basename, join, resolve as resolvePath, extname } from 'path';
import { AgentLoopFactory, type IAgentLoop, type CommandConfirmation } from './src/utils/agent/index.js';
import type { ApplyPatchCommand, ApprovalPolicy } from './src/approvals.js';
import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import type { AppConfig } from './src/utils/config.js';
import { ReviewDecision } from './src/utils/agent/review.js';
import { ContextManager, createContextManager, type ContextInfo } from './context-managers.js';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { resolve } from 'path';
import { initLogger, debug } from './src/utils/logger/log.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { RestHandlers } from './ws-rest-handlers.js';

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
export interface ArtifactItem {
  artifact_id: string;
  file_path: string;
  overview: string;
}

export interface ArtifactsIndex {
  artifacts_root_path: string;
  artifacts: ArtifactItem[];
}

// Types for data connectors
export interface DataConnector {
  id: string;
  name: string;
  type: 'local_file' | 'gcs';
  config: {
    // Local file config
    file_path?: string; // Optional until file is uploaded
    filename?: string; // Filename to use when saving uploaded content
    file_type?: 'text' | 'csv' | 'json' | 'binary';
    encoding?: string;
    
    // GCS config
    gcs_url?: string; // GCS URL in format gs://bucket-name or gs://bucket-name/path/to/subroot
    local_mount_point_path?: string; // Local mount point where GCS bucket is mounted
  };
  status: 'pending_upload' | 'active' | 'inactive' | 'error';
  created_at: string;
  last_used?: string;
  metadata?: {
    file_size?: number;
    mime_type?: string;
    last_modified?: string;
  };
}

// Types for session management
export interface SessionEvent {
  timestamp: string;
  event_type: 'websocket_message_received' | 'websocket_message_sent';
  direction: 'incoming' | 'outgoing';
  message_data: any;
}

export interface SessionInfo {
  id: string;
  start_time: string;
  last_update_time: string;
  event_count: number;
}

// GCS utility functions
const execAsync = promisify(exec);

interface GCSConfig {
  bucketId: string;
  restrictToSubroot?: string;
}

export function parseGcsUrl(gcsUrl: string): GCSConfig | null {
  if (!gcsUrl.startsWith('gs://')) {
    return null;
  }
  
  const urlPart = gcsUrl.slice(5); // Remove 'gs://' prefix
  const parts = urlPart.split('/');
  
  if (parts.length === 0 || !parts[0]) {
    return null;
  }
  
  const bucketId = parts[0];
  const restrictToSubroot = parts.length > 1 ? parts.slice(1).join('/') : undefined;
  
  return {
    bucketId,
    restrictToSubroot
  };
}

export async function checkGcsfuseInstalled(): Promise<boolean> {
  try {
    await execAsync('gcsfuse -v');
    return true;
  } catch (error) {
    return false;
  }
}

export async function mountGcsBucket(config: GCSConfig, mountPoint: string): Promise<void> {
  const { bucketId, restrictToSubroot } = config;
  
  // Create mount point directory if it doesn't exist
  if (!existsSync(mountPoint)) {
    mkdirSync(mountPoint, { recursive: true });
  }
  
  let command: string;
  if (restrictToSubroot) {
    command = `gcsfuse --only-dir=${restrictToSubroot} --implicit-dirs ${bucketId} ${mountPoint}`;
  } else {
    command = `gcsfuse --implicit-dirs ${bucketId} ${mountPoint}`;
  }
  
  await execAsync(command);
}

export async function unmountGcsBucket(mountPoint: string): Promise<void> {
  try {
    await execAsync(`fusermount -u ${mountPoint}`);
  } catch (error) {
    // Ignore errors if mount point is not mounted
    console.warn(`Failed to unmount ${mountPoint}:`, error);
  }
}

async function getActiveMounts(gcsMountRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('mount');
    const mountLines = stdout.split('\n');
    const gcsMounts: string[] = [];
    
    for (const line of mountLines) {
      if (line.includes('gcsfuse') && line.includes(gcsMountRoot)) {
        // Extract mount point from mount line
        const parts = line.split(' on ');
        if (parts.length >= 2) {
          const mountPoint = parts[1].split(' ')[0];
          gcsMounts.push(mountPoint);
        }
      }
    }
    
    return gcsMounts;
  } catch (error) {
    console.warn('Failed to get active mounts:', error);
    return [];
  }
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
  private todosStorePath: string | null = null;
  private connectorsStorePath: string | null = null;
  private uploadedFilesPath: string | null = null;
  private messageFragments: Map<string, ResponseItem[]> = new Map();
  private restHandlers: RestHandlers;

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
    
    // Initialize todos storage
    this.initializeTodosStorage();
    
    // Initialize connectors storage (including GCS)
    this.initializeConnectorsStorageAsync();

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
    const { origin, req } = info;

    // Validate WebSocket URL path format: /ws/{session_id}
    const url = req.url;
    if (!url || !this.validateWebSocketPath(url)) {
      console.log(`❌ WebSocket connection rejected: Invalid path format '${url}'. Expected: /ws/{session_id}`);
      return false;
    }

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

  private validateWebSocketPath(url: string): boolean {
    // Expected format: /ws/{session_id}
    const pathPattern = /^\/ws\/([a-zA-Z0-9]+)$/;
    return pathPattern.test(url);
  }

  private extractSessionIdFromPath(url: string): string | null {
    // Extract session ID from /ws/{session_id} format
    const pathPattern = /^\/ws\/([a-zA-Z0-9]+)$/;
    const match = url.match(pathPattern);
    return match ? match[1] : null;
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    console.log(`🌐 Incoming HTTP request: ${req.method} ${req.url}`);

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
      this.restHandlers.handleListSessions(req, res);
    } else if (method === 'POST' && pathname === '/sessions') {
      this.restHandlers.handleCreateSession(req, res);
    } else if (method === 'GET' && pathname.startsWith('/sessions/')) {
      const sessionId = pathname.substring('/sessions/'.length);
      this.restHandlers.handleGetSession(sessionId, req, res);
    } else if (method === 'DELETE' && pathname.startsWith('/sessions/')) {
      const sessionId = pathname.substring('/sessions/'.length);
      this.restHandlers.handleDeleteSession(sessionId, req, res);
    } else if (method === 'POST' && pathname.includes(':switch')) {
      // Handle POST /sessions/{session_id}:switch
      const match = pathname.match(/^\/sessions\/([^:]+):switch$/);
      if (match) {
        const sessionId = match[1];
        this.restHandlers.handleSwitchSession(sessionId, req, res);
      } else {
        this.sendHttpError(res, 400, 'Invalid switch session path format');
      }
    } else if (method === 'GET' && pathname === '/artifacts') {
      this.restHandlers.handleGetArtifacts(req, res);
    } else if (method === 'GET' && pathname.startsWith('/artifacts/')) {
      const artifactId = pathname.substring('/artifacts/'.length);
      this.restHandlers.handleGetArtifact(artifactId, req, res);
    } else if (method === 'GET' && pathname === '/connectors') {
      this.restHandlers.handleListConnectors(req, res);
    } else if (method === 'POST' && pathname === '/connectors') {
      this.restHandlers.handleCreateConnector(req, res);
    } else if (method === 'GET' && pathname.startsWith('/connectors/')) {
      const pathParts = pathname.split('/');
      if (pathParts.length === 3) {
        // GET /connectors/{id}
        const connectorId = pathParts[2];
        this.restHandlers.handleGetConnector(connectorId, req, res);
      } else if (pathParts.length === 4 && pathParts[3] === 'content') {
        // GET /connectors/{id}/content
        const connectorId = pathParts[2];
        this.restHandlers.handleGetConnectorContent(connectorId, req, res);
      } else {
        this.sendHttpError(res, 404, 'Not Found');
      }
    } else if (method === 'DELETE' && pathname.startsWith('/connectors/')) {
      const pathParts = pathname.split('/');
      if (pathParts.length === 3) {
        const connectorId = pathParts[2];
        this.restHandlers.handleDeleteConnector(connectorId, req, res);
      } else {
        this.sendHttpError(res, 404, 'Not Found');
      }
    } else if (method === 'POST' && pathname.includes(':upload')) {
      // Handle POST /connectors/{connector_id}:upload
      const match = pathname.match(/^\/connectors\/([^:]+):upload$/);
      if (match) {
        const connectorId = match[1];
        this.restHandlers.handleUploadToConnector(connectorId, req, res);
      } else {
        this.sendHttpError(res, 400, 'Invalid upload path format');
      }
    } else {
      this.sendHttpError(res, 404, 'Not Found');
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

  private initializeTodosStorage(): void {
    const todosStorePath = process.env.TODOS_STORE_PATH;

    if (!todosStorePath) {
      console.log('⚠️  TODOS_STORE_PATH not configured, todos creation disabled');
      return;
    }

    try {
      // Create directory if it doesn't exist
      if (!existsSync(todosStorePath)) {
        mkdirSync(todosStorePath, { recursive: true });
        console.log(`📁 Created todos store directory: ${todosStorePath}`);
      }

      this.todosStorePath = todosStorePath;
      console.log(`✅ Todos creation enabled, storing in: ${todosStorePath}`);

    } catch (error) {
      console.error(`❌ Failed to initialize todos storage: ${error.message}`);
      this.todosStorePath = null;
    }
  }

  private async initializeConnectorsStorageAsync(): Promise<void> {
    const workingDir = process.env.WORKING_DIRECTORY;
    const connectorsStorePath = join(workingDir, '.terraine', 'connectors.jsonl');
    const uploadedFilesPath = join(workingDir, '.terraine', 'uploads');

    if (!connectorsStorePath) {
      console.log('⚠️  CONNECTORS_STORE_PATH not configured, connectors disabled');
      return;
    }

    try {
      // Create connectors directory if it doesn't exist
      const connectorsDir = resolve(connectorsStorePath).replace(/[^/]+$/, '');
      if (!existsSync(connectorsDir)) {
        mkdirSync(connectorsDir, { recursive: true });
      }

      this.connectorsStorePath = connectorsStorePath;
      console.log(`✅ Connectors enabled, storing in: ${connectorsStorePath}`);

      // Initialize uploaded files directory if configured
      if (uploadedFilesPath) {
        if (!existsSync(uploadedFilesPath)) {
          mkdirSync(uploadedFilesPath, { recursive: true });
          console.log(`📁 Created uploaded files directory: ${uploadedFilesPath}`);
        }
        this.uploadedFilesPath = uploadedFilesPath;
        console.log(`✅ File uploads enabled, storing in: ${uploadedFilesPath}`);
      } else {
        console.log('⚠️  UPLOADED_FILES_PATH not configured, file uploads disabled');
      }

      // Initialize GCS functionality
      await this.initializeGcs();

      // Initialize REST handlers after all storage paths are set
      this.restHandlers = new RestHandlers(
        this.connectorsStorePath,
        this.uploadedFilesPath,
        this.sessionStorePath,
        this.todosStorePath
      );

    } catch (error) {
      console.error(`❌ Failed to initialize connectors storage: ${error.message}`);
      this.connectorsStorePath = null;
      this.uploadedFilesPath = null;
      
      // Still initialize REST handlers even if storage failed
      this.restHandlers = new RestHandlers(
        this.connectorsStorePath,
        this.uploadedFilesPath,
        this.sessionStorePath,
        this.todosStorePath
      );
    }
  }

  private async initializeGcs(): Promise<void> {
    try {
      // Check if gcsfuse is installed
      const gcsfuseInstalled = await checkGcsfuseInstalled();
      if (!gcsfuseInstalled) {
        console.log('⚠️  gcsfuse not found in PATH, GCS connectors disabled');
        return;
      }

      console.log('✅ gcsfuse found, GCS connectors enabled');

      // Set up GCS mount root
      const gcsMountRoot = join(process.cwd(), '.terraine', 'gcs');
      if (!existsSync(gcsMountRoot)) {
        mkdirSync(gcsMountRoot, { recursive: true });
        console.log(`📁 Created GCS mount root: ${gcsMountRoot}`);
      }

      // Check for and unmount any existing mounts
      const activeMounts = await getActiveMounts(gcsMountRoot);
      for (const mountPoint of activeMounts) {
        console.log(`🔄 Unmounting existing GCS mount: ${mountPoint}`);
        await unmountGcsBucket(mountPoint);
      }

      // Synchronize existing GCS connectors from connectors.jsonl
      await this.synchronizeGcsConnectors();

    } catch (error) {
      console.warn(`⚠️  GCS initialization failed: ${error.message}`);
    }
  }

  private async synchronizeGcsConnectors(): Promise<void> {
    if (!this.connectorsStorePath || !existsSync(this.connectorsStorePath)) {
      return;
    }

    try {
      const content = readFileSync(this.connectorsStorePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.trim());

      const gcsMountRoot = join(process.cwd(), '.terraine', 'gcs');

      for (const line of lines) {
        const connector = JSON.parse(line) as DataConnector;
        
        if (connector.type === 'gcs' && connector.status === 'active' && connector.config.gcs_url) {
          const gcsConfig = parseGcsUrl(connector.config.gcs_url);
          if (gcsConfig) {
            const mountPoint = connector.config.local_mount_point_path;
            if (mountPoint && existsSync(mountPoint)) {
              // Check if already mounted
              const activeMounts = await getActiveMounts(gcsMountRoot);
              if (!activeMounts.includes(mountPoint)) {
                console.log(`🔄 Re-mounting GCS connector: ${connector.name}`);
                await mountGcsBucket(gcsConfig, mountPoint);
              }
            }
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️  Failed to synchronize GCS connectors: ${error.message}`);
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

  private startSessionWithId(sessionId: string): void {
    if (!this.sessionStorePath) {
      return; // Session logging not configured
    }

    this.currentSessionId = sessionId;
    const sessionEvent: SessionEvent = {
      timestamp: new Date().toISOString(),
      event_type: 'websocket_message_received',
      direction: 'incoming',
      message_data: { event: 'session_connected', session_id: sessionId }
    };

    this.logSessionEvent(sessionEvent);
    console.log(`🆔 Connected to session: ${this.currentSessionId}`);
  }

  private loadSessionEvents(sessionId: string): SessionEvent[] {
    if (!this.sessionStorePath) {
      console.log('⚠️  Session storage not configured, starting fresh session');
      return [];
    }

    try {
      const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);
      
      if (!existsSync(sessionFile)) {
        console.log(`📝 No existing session file found for ${sessionId}, starting fresh`);
        return [];
      }

      // Read the entire session file
      const content = readFileSync(sessionFile, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      if (lines.length === 0) {
        console.log(`📝 Empty session file for ${sessionId}, starting fresh`);
        return [];
      }

      // Parse all events
      const events: SessionEvent[] = [];
      for (const line of lines) {
        try {
          const event: SessionEvent = JSON.parse(line);
          events.push(event);
        } catch (parseError) {
          console.error(`❌ Error parsing event in session ${sessionId}:`, parseError);
          // Continue with other events instead of failing completely
        }
      }

      console.log(`📚 Loaded ${events.length} events from session ${sessionId}`);
      return events;

    } catch (error) {
      console.error(`❌ Error loading session events for ${sessionId}:`, error);
      return [];
    }
  }

  private reconstructTranscriptFromEvents(events: SessionEvent[]): Array<ResponseInputItem> {
    const transcript: Array<ResponseInputItem> = [];

    for (const event of events) {
      // Skip non-message events
      if (event.event_type !== 'websocket_message_received' && 
          event.event_type !== 'websocket_message_sent') {
        continue;
      }

      // Skip system events like session_started, session_connected, etc.
      if (event.message_data?.event) {
        continue;
      }

      // Process user input messages
      if (event.event_type === 'websocket_message_received' && 
          event.message_data?.type === 'user_input') {
        const userInput = event.message_data.payload?.input;
        if (userInput && Array.isArray(userInput)) {
          transcript.push(...userInput);
        }
      }

      // Process response items (assistant messages, tool calls, explanation messages, etc.)
      if (event.event_type === 'websocket_message_sent' && 
          event.message_data?.type === 'response_item') {
        const responseItem = event.message_data.payload;
        if (responseItem) {
          // Convert response item to input item format for transcript
          const inputItem: ResponseInputItem = {
            id: responseItem.id,
            type: responseItem.type,
            role: responseItem.role,
            status: responseItem.status,
            content: responseItem.content,
            ...(responseItem.action && { action: responseItem.action }),
            ...(responseItem.result && { result: responseItem.result })
          };
          transcript.push(inputItem);
        }
      }
    }

    console.log(`🔄 Reconstructed transcript with ${transcript.length} items`);
    return transcript;
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

  private createTodosFile(): void {
    if (!this.todosStorePath) {
      console.log('⚠️  Cannot create todos file: TODOS_STORE_PATH not configured');
      return;
    }

    if (!this.currentSessionId) {
      console.log('⚠️  Cannot create todos file: no current session ID');
      return;
    }

    try {
      const todosFilePath = join(this.todosStorePath, `${this.currentSessionId}.md`);
      
      // Only create if it doesn't already exist
      if (!existsSync(todosFilePath)) {
        const todosTemplate = '# terraine.ai TODOs';

        writeFileSync(todosFilePath, todosTemplate, 'utf-8');
        console.log(`📝 Created todos file: ${todosFilePath}`);
      } else {
        console.log(`📝 Todos file already exists: ${todosFilePath}`);
      }
    } catch (error) {
      console.error(`❌ Failed to create todos file: ${error.message}`);
      // Don't fail the session if todos file creation fails
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

  private loadConnectors(): DataConnector[] {
    if (!this.connectorsStorePath) {
      return [];
    }

    try {
      if (!existsSync(this.connectorsStorePath)) {
        return [];
      }

      const content = readFileSync(this.connectorsStorePath, 'utf-8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);

      const connectors: DataConnector[] = [];
      for (const line of lines) {
        try {
          const connector: DataConnector = JSON.parse(line);
          connectors.push(connector);
        } catch (parseError) {
          console.error(`Error parsing connector line: ${parseError.message}`);
        }
      }

      return connectors;
    } catch (error) {
      console.error(`Error loading connectors: ${error.message}`);
      return [];
    }
  }

  private detectFileType(filePath: string, mimeType?: string): string {
    return detectFileType(filePath, mimeType);
  }

  private getFileMetadata(filePath: string): { file_size: number; mime_type: string; last_modified: string } | null {
    return getFileMetadata(filePath);
  }

  private setupWebSocketServer() {
    console.log(`CODEX_UNSAFE_ALLOW_NO_SANDBOX=${process.env.CODEX_UNSAFE_ALLOW_NO_SANDBOX}`);
    this.wss.on('connection', (ws, req) => {
      // Extract session ID from WebSocket path
      const sessionId = this.extractSessionIdFromPath(req.url || '');
      if (!sessionId) {
        console.log('❌ WebSocket connection rejected: Could not extract session ID');
        ws.close(1008, 'Invalid session ID in path');
        return;
      }

      console.log(`Client connected to session: ${sessionId}`);
      this.ws = ws;

      // Use the session ID from the URL path
      this.startSessionWithId(sessionId);

      // Load existing session events and reconstruct transcript for resumption
      const sessionEvents = this.loadSessionEvents(sessionId);
      const resumeTranscript = this.reconstructTranscriptFromEvents(sessionEvents);

      // Create todos file for new sessions (when no events exist)
      if (sessionEvents.length === 0) {
        this.createTodosFile();
      }

      // Initialize AgentLoop when client connects, with session resumption if available
      this.initializeAgentLoop(undefined, resumeTranscript.length > 0 ? resumeTranscript : undefined);

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

  private initializeAgentLoop(seedInput?: Array<ResponseInputItem>, resumeTranscript?: Array<ResponseInputItem>) {
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

    // Load instructions from file if specified
    let instructions = '';
    const instructionsFilePath = process.env.INSTRUCTIONS_FILE_PATH;
    if (instructionsFilePath) {
      try {
        if (existsSync(instructionsFilePath)) {
          instructions = readFileSync(instructionsFilePath, 'utf-8');
          console.log(`✅ Loaded instructions from file: ${instructionsFilePath}`);
        } else {
          console.error(`❌ Instructions file not found: ${instructionsFilePath}`);
          console.error('Please create the file or update INSTRUCTIONS_FILE_PATH in your .env file');
        }
      } catch (error) {
        console.error(`❌ Error reading instructions file: ${error.message}`);
        console.error('Using empty instructions');
      }
    }

    // Default configuration - you can modify this based on your needs
    const config: AppConfig = {
      model, // Use same default as TUI for better tool behavior
      instructions,
      apiKey,
    };

    // Configure approval policy from environment variable
    const approvalModeEnv = process.env.TOOL_USE_APPROVAL_MODE;
    let approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default
    
    if (approvalModeEnv) {
      if (approvalModeEnv === 'suggest' || approvalModeEnv === 'auto-edit' || approvalModeEnv === 'full-auto') {
        approvalPolicy = approvalModeEnv;
        console.log(`✅ Using tool approval mode: ${approvalPolicy}`);
      } else {
        console.error(`❌ Invalid TOOL_USE_APPROVAL_MODE: ${approvalModeEnv}`);
        console.error('Valid values are: suggest, auto-edit, full-auto');
        console.error('Using default: suggest');
      }
    } else {
      console.log(`ℹ️  Using default tool approval mode: ${approvalPolicy}`);
    }

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
    
    // If we have a resume transcript (from session resumption), initialize the transcript
    if (resumeTranscript && resumeTranscript.length > 0) {
      console.log(`🔄 Resuming session with ${resumeTranscript.length} items from previous conversation...`);
      // Initialize the transcript without making API calls
      if (this.agentLoop.initializeTranscript) {
        this.agentLoop.initializeTranscript(resumeTranscript);
      } else {
        console.warn('⚠️  AgentLoop implementation does not support initializeTranscript - session resumption unavailable');
      }
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
      // However, standalone explanation messages should be logged immediately.
      // Non-message items (function calls, loading states, etc.) are logged immediately.
      const isStreamingFragment = message.type === 'response_item' &&
                                   message.payload?.type === 'message' &&
                                   this.isStreamingResponse();

      if (!isStreamingFragment) {
        this.logOutgoingMessage(message);
      }

      this.ws.send(JSON.stringify(message));
    }
  }

  private isStreamingResponse(): boolean {
    // Explanation messages are sent during approval handling, not during streaming responses
    // We can detect this by checking if we have a pending approval request
    return this.pendingApprovalRequest === null;
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

export function loadArtifactsIndex(): ArtifactsIndex | null {
  const workingDir = process.env.WORKING_DIRECTORY;
  const artifactsIndexPath = join(workingDir, '.terraine', 'artifact_catalog.json');

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

// Exported helper functions for RestHandlers
export function updateConnectorLastUsed(connectorId: string, connectorsStorePath: string | null): void {
  if (!connectorsStorePath) {
    return;
  }

  try {
    const content = readFileSync(connectorsStorePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const connectors: DataConnector[] = lines.map(line => JSON.parse(line));
    
    const connector = connectors.find(c => c.id === connectorId);
    
    if (connector) {
      connector.last_used = new Date().toISOString();
      
      // Rewrite the file with updated connector
      const updatedContent = connectors.map(c => JSON.stringify(c)).join('\n') + '\n';
      writeFileSync(connectorsStorePath, updatedContent);
    }
  } catch (error) {
    console.error(`Error updating connector last used: ${error.message}`);
  }
}

export function updateConnectorInStorage(connectorId: string, updates: Partial<DataConnector>, connectorsStorePath: string | null): boolean {
  if (!connectorsStorePath) {
    return false;
  }

  try {
    const content = readFileSync(connectorsStorePath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const connectors: DataConnector[] = lines.map(line => JSON.parse(line));
    
    const connectorIndex = connectors.findIndex(c => c.id === connectorId);
    
    if (connectorIndex === -1) {
      return false; // Connector not found
    }

    // Apply updates
    connectors[connectorIndex] = { ...connectors[connectorIndex], ...updates };
      
    // Rewrite the file with updated connector
    const updatedContent = connectors.map(c => JSON.stringify(c)).join('\n') + '\n';
    writeFileSync(connectorsStorePath, updatedContent);
    return true;
  } catch (error) {
    console.error(`Error updating connector: ${error.message}`);
    return false;
  }
}

export function detectFileType(filePath: string, mimeType?: string): string {
  const ext = extname(filePath).toLowerCase();
  
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text';
  if (mimeType && mimeType.startsWith('text/')) return 'text';
  
  return 'binary';
}

export function getFileMetadata(filePath: string): { file_size: number; mime_type: string; last_modified: string } | null {
  try {
    const stats = statSync(filePath);
    const ext = extname(filePath).toLowerCase();
    
    let mimeType = 'application/octet-stream';
    if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.csv') mimeType = 'text/csv';
    else if (ext === '.json') mimeType = 'application/json';
    else if (ext === '.md') mimeType = 'text/markdown';
    else if (ext === '.log') mimeType = 'text/plain';
    
    return {
      file_size: stats.size,
      mime_type: mimeType,
      last_modified: stats.mtime.toISOString()
    };
  } catch (error) {
    console.error(`Error getting file metadata: ${error.message}`);
    return null;
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
