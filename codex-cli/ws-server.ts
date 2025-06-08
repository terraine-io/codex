#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
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

class WebSocketAgentServer {
  private wss: WebSocketServer;
  private agentLoop: IAgentLoop | null = null;
  private ws: WebSocket | null = null;
  private contextManager: ContextManager | null = null;
  private pendingApprovalRequest: {
    resolve: (confirmation: CommandConfirmation) => void;
    reject: (error: Error) => void;
    command: Array<string>;
    applyPatch?: ApplyPatchCommand;
  } | null = null;
  // Note: lastResponseId is not needed when disableResponseStorage: true

  constructor(port: number = 8080) {
    this.wss = new WebSocketServer({ port });
    this.setupWebSocketServer();
    console.log(`WebSocket server started on port ${port}`);
  }

  private setupWebSocketServer() {
    this.wss.on('connection', (ws) => {
      console.log('Client connected - initializing new session');
      this.ws = ws;

      // Initialize AgentLoop when client connects
      this.initializeAgentLoop();

      ws.on('message', async (data) => {
        try {
          const message: WSMessage = JSON.parse(data.toString());
          await this.handleMessage(message);
        } catch (error) {
          console.error('Error handling message:', error);
          this.sendError('Invalid message format', error);
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected');
        this.cleanup();
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
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
        console.log(`📨 SERVER: Received response item type: ${item.type}${item.type === 'local_shell_call' ? ` (command: ${(item as any).action?.command?.join(' ')})` : ''}`);
        
        // Add to context manager first for tracking
        this.contextManager?.addItem(item);
        
        console.log(`📤 SERVER: Sending response item to client: ${item.type}`);
        // Then send to client
        this.sendMessage({
          id: randomUUID(),
          type: 'response_item',
          payload: item,
        });
      },

      // Callback for loading state changes
      onLoading: (loading: boolean) => {
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
    
    this.ws = null;
  }

  public close() {
    this.cleanup();
    this.wss.close();
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