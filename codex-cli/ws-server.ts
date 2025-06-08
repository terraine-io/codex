#!/usr/bin/env node

import { WebSocketServer, WebSocket } from 'ws';
import { AgentLoop, CommandConfirmation } from './src/utils/agent/agent-loop.js';
import type { ApplyPatchCommand, ApprovalPolicy } from './src/approvals.js';
import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import type { AppConfig } from './src/utils/config.js';
import { ReviewDecision } from './src/utils/agent/review.js';
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

class WebSocketAgentServer {
  private wss: WebSocketServer;
  private agentLoop: AgentLoop | null = null;
  private ws: WebSocket | null = null;
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

  private initializeAgentLoop() {
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
      model: 'gpt-4', // Default model
      instructions: '', // Default instructions
      apiKey: process.env.OPENAI_API_KEY,
    };

    const approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default

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
        // With disableResponseStorage: true, we don't need to track response IDs
        // but we still signal when the agent is finished
        this.sendMessage({
          id: randomUUID(),
          type: 'agent_finished',
          payload: { responseId },
        });
      },
    });
  }

  private async handleMessage(message: WSMessage) {
    switch (message.type) {
      case 'user_input':
        await this.handleUserInput(message as UserInputMessage);
        break;
        
      case 'approval_response':
        this.handleApprovalResponse(message as ApprovalResponseMessage);
        break;
        
      default:
        this.sendError(`Unknown message type: ${message.type}`);
    }
  }

  private async handleUserInput(message: UserInputMessage) {
    if (!this.agentLoop) {
      this.sendError('AgentLoop not initialized');
      return;
    }

    try {
      const { input } = message.payload;
      
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

  private cleanup() {
    if (this.agentLoop) {
      this.agentLoop.terminate();
      this.agentLoop = null;
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