#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
import { AgentLoop, CommandConfirmation } from './src/utils/agent/agent-loop.js';
import type { ApplyPatchCommand, ApprovalPolicy } from './src/approvals.js';
import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import type { AppConfig } from './src/utils/config.js';
import { ReviewDecision } from './src/utils/agent/review.js';
import { ContextManager, type ContextInfo } from './context-manager.js';
import { randomUUID } from 'crypto';
import { config } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

// Load environment variables and configure working directory
function initializeEnvironment() {
  // Load .env file if it exists
  config();
  
  // Check for required API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Error: OPENAI_API_KEY environment variable is not set');
    console.error('Please set your OpenAI API key:');
    console.error('  export OPENAI_API_KEY="your-api-key-here"');
    console.error('');
    console.error('You can get an API key from: https://platform.openai.com/account/api-keys');
    process.exit(1);
  }
  
  console.log('✅ OPENAI_API_KEY is set');
  
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
  };
}

class WebSocketAgentServer {
  private wss: WebSocketServer;
  private agentLoop: AgentLoop | null = null;
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
    
    // Default configuration - you can modify this based on your needs
    const config: AppConfig = {
      model: process.env.MODEL || 'gpt-4', // Allow model override via env
      instructions: process.env.INSTRUCTIONS || '', // Allow instructions override via env
      apiKey: process.env.OPENAI_API_KEY,
    };

    const approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default

    // Initialize context manager if not exists or reset if recreating
    if (!this.contextManager) {
      this.contextManager = new ContextManager({
        model: config.model || 'gpt-4',
        compactionThreshold: parseFloat(process.env.CONTEXT_COMPACTION_THRESHOLD || '0.8'),
        config
      });

      // Set up auto-compaction callback
      this.contextManager.onCompactionNeeded = async (transcript) => {
        await this.handleAutoCompaction();
      };
    } else {
      // Clear context manager state for fresh start
      this.contextManager.clear();
    }

    this.agentLoop = new AgentLoop({
      model: config.model || 'gpt-4',
      provider: 'openai',
      config,
      instructions: config.instructions,
      approvalPolicy,
      additionalWritableRoots: [process.cwd()],
      disableResponseStorage: true,
      
      // Callback for streaming response items back to client
      onItem: (item: ResponseItem) => {
        // Add to context manager first for tracking
        this.contextManager?.addItem(item);
        
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
        return new Promise((resolve, reject) => {
          // Store the pending request
          this.pendingApprovalRequest = {
            resolve,
            reject,
            command,
            applyPatch,
          };

          // Send approval request to client
          this.sendMessage({
            id: randomUUID(),
            type: 'approval_request',
            payload: {
              command,
              applyPatch,
            },
          });
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
        this.handleApprovalResponse(message as ApprovalResponseMessage);
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

  private handleApprovalResponse(message: ApprovalResponseMessage) {
    if (!this.pendingApprovalRequest) {
      this.sendError('No pending approval request');
      return;
    }

    try {
      console.log('Processing approval response:', message.payload.review);
      // Resolve the pending approval request with the user's decision
      this.pendingApprovalRequest.resolve(message.payload);
      this.pendingApprovalRequest = null;
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
          reductionPercent
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