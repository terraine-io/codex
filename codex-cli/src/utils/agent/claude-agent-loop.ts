/**
 * Claude/Anthropic implementation of IAgentLoop
 */

import type { IAgentLoop, AgentLoopCallbacks } from "./agent-loop-interface.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import type { ApprovalPolicy } from "../../approvals.js";
import type { AppConfig } from "../config.js";
import {
  ClaudeFormatConverter,
  type ClaudeMessage,
  type ClaudeCreateMessageRequest,
  type ClaudeCreateMessageResponse,
  type ClaudeStreamEvent,
  type ClaudeContent,
  type ClaudeToolUseContent
} from "./claude-types.js";
import { getClaudeTools, executeClaudeTool, type ClaudeToolContext } from "./claude-tools.js";
import { randomUUID } from "crypto";
import { log } from "../logger/log.js";

/**
 * Configuration specific to Claude AgentLoop
 */
export interface ClaudeAgentLoopConfig {
  model: string;
  instructions?: string;
  approvalPolicy: ApprovalPolicy;
  disableResponseStorage?: boolean;
  config?: AppConfig;
  additionalWritableRoots?: ReadonlyArray<string>;
}

/**
 * Claude/Anthropic implementation of AgentLoop
 */
export class ClaudeAgentLoop implements IAgentLoop {
  public readonly sessionId: string;
  
  private model: string;
  private instructions?: string;
  private approvalPolicy: ApprovalPolicy;
  private config: AppConfig;
  private additionalWritableRoots: ReadonlyArray<string>;
  private disableResponseStorage: boolean;
  
  // Anthropic client (will be dynamically imported)
  private anthropic: any = null;
  
  // Callbacks
  private onItem: (item: ResponseItem) => void;
  private onLoading: (loading: boolean) => void;
  private getCommandConfirmation: (
    command: Array<string>,
    applyPatch?: any
  ) => Promise<any>;
  private onLastResponseId: (lastResponseId: string) => void;
  
  // State management
  private generation = 0;
  private canceled = false;
  private terminated = false;
  private currentStream: any = null;
  private execAbortController: AbortController | null = null;
  private readonly hardAbort = new AbortController();
  
  // Conversation state (when disableResponseStorage is true)
  private transcript: Array<ResponseInputItem> = [];
  
  constructor(config: ClaudeAgentLoopConfig & AgentLoopCallbacks) {
    this.sessionId = randomUUID().replaceAll("-", "");
    
    this.model = config.model;
    this.instructions = config.instructions;
    this.approvalPolicy = config.approvalPolicy;
    this.disableResponseStorage = config.disableResponseStorage ?? false;
    
    this.config = config.config ?? {
      model: config.model,
      instructions: config.instructions ?? "",
    };
    
    this.additionalWritableRoots = config.additionalWritableRoots ?? [];
    
    // Store callbacks
    this.onItem = config.onItem;
    this.onLoading = config.onLoading;
    this.getCommandConfirmation = config.getCommandConfirmation;
    this.onLastResponseId = config.onLastResponseId;
    
    // Initialize Anthropic client
    this.initializeAnthropicClient();
  }
  
  /**
   * Initialize Anthropic client with dynamic import
   */
  private async initializeAnthropicClient(): Promise<void> {
    try {
      // Dynamic import to avoid requiring Anthropic SDK unless actually used
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      
      const apiKey = this.config.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
      
      if (!apiKey) {
        throw new Error('ANTHROPIC_API_KEY is required for Claude models');
      }
      
      this.anthropic = new Anthropic({
        apiKey,
        // Add timeout and other config as needed
      });
      
      log('Claude/Anthropic client initialized successfully');
      
    } catch (error) {
      console.error('Failed to initialize Anthropic client:', error);
      
      if (error instanceof Error && error.message.includes('Cannot resolve module')) {
        throw new Error(
          'Anthropic SDK not found. Please install it with: npm install @anthropic-ai/sdk'
        );
      }
      
      throw new Error(`Failed to initialize Claude provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Execute agent conversation turn
   */
  public async run(
    input: Array<ResponseInputItem>,
    previousResponseId: string = ""
  ): Promise<void> {
    if (this.terminated) {
      throw new Error("ClaudeAgentLoop has been terminated");
    }
    
    // Ensure client is initialized
    if (!this.anthropic) {
      await this.initializeAnthropicClient();
    }
    
    const thisGeneration = ++this.generation;
    this.canceled = false;
    this.currentStream = null;
    this.execAbortController = new AbortController();
    
    log(`ClaudeAgentLoop.run(): Starting generation ${thisGeneration}`);
    
    try {
      this.onLoading(true);
      
      // Update transcript if using local storage
      if (this.disableResponseStorage) {
        this.transcript.push(...input);
      }
      
      // Convert input to Claude message format
      const messages = ClaudeFormatConverter.convertInputToClaudeMessages(
        this.disableResponseStorage ? this.transcript : input
      );
      
      // Prepare Claude API request
      const request: ClaudeCreateMessageRequest = {
        model: this.model,
        max_tokens: 4096, // Claude requires explicit max_tokens
        messages,
        tools: getClaudeTools(),
        stream: true,
        ...(this.instructions ? { system: this.instructions } : {})
      };
      
      log(`Claude request: ${JSON.stringify({ model: request.model, messageCount: messages.length, hasTools: !!request.tools })}`);
      
      // Make streaming request to Claude
      const stream = this.anthropic.messages.stream(request);
      this.currentStream = stream;
      
      let responseId = `claude_${Date.now()}`;
      let currentContent: Array<ClaudeContent> = [];
      
      // Process streaming response
      stream.on('text', (text: string) => {
        if (this.canceled || thisGeneration !== this.generation) return;
        
        // Emit text as response item
        this.emitResponseItem({
          id: responseId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text }]
        });
      });
      
      stream.on('contentBlock', (block: ClaudeContent) => {
        if (this.canceled || thisGeneration !== this.generation) return;
        
        currentContent.push(block);
        
        // Handle tool use
        if (block.type === 'tool_use') {
          this.handleToolUse(block as ClaudeToolUseContent);
        }
      });
      
      stream.on('message', (message: ClaudeCreateMessageResponse) => {
        if (this.canceled || thisGeneration !== this.generation) return;
        
        responseId = message.id;
        
        // Store response in transcript if using local storage
        if (this.disableResponseStorage) {
          // Convert Claude response to ResponseInputItem format for transcript
          const responseItem: ResponseInputItem = {
            type: 'message',
            role: 'assistant',
            content: message.content.map(c => 
              c.type === 'text' 
                ? { type: 'input_text', text: (c as any).text }
                : { type: 'input_text', text: `[${c.type}]` }
            )
          };
          this.transcript.push(responseItem);
        }
      });
      
      stream.on('end', () => {
        if (this.canceled || thisGeneration !== this.generation) return;
        
        this.onLoading(false);
        this.onLastResponseId(responseId);
        log(`ClaudeAgentLoop.run(): Completed generation ${thisGeneration}`);
      });
      
      stream.on('error', (error: any) => {
        if (this.canceled || thisGeneration !== this.generation) return;
        
        console.error('Claude stream error:', error);
        this.onLoading(false);
        
        // Emit error as response item
        this.emitResponseItem({
          id: responseId,
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'input_text',
            text: `Error: ${error.message || 'Unknown error occurred'}`
          }]
        });
      });
      
      // Handle abort signal
      if (this.hardAbort.signal.aborted || this.canceled) {
        stream.abort();
        this.onLoading(false);
        return;
      }
      
    } catch (error) {
      this.onLoading(false);
      console.error('ClaudeAgentLoop.run() error:', error);
      
      // Emit error as response item
      this.emitResponseItem({
        id: `error_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'input_text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }]
      });
    }
  }
  
  /**
   * Handle tool use from Claude
   */
  private async handleToolUse(toolUse: ClaudeToolUseContent): Promise<void> {
    try {
      // Emit function call item
      this.emitResponseItem({
        id: toolUse.id,
        type: 'function_call',
        name: toolUse.name,
        arguments: JSON.stringify(toolUse.input),
        call_id: toolUse.id
      });
      
      // Execute tool
      const toolContext: ClaudeToolContext = {
        config: this.config,
        approvalPolicy: this.approvalPolicy,
        getCommandConfirmation: this.getCommandConfirmation,
        additionalWritableRoots: this.additionalWritableRoots,
        abortSignal: this.execAbortController?.signal
      };
      
      const result = await executeClaudeTool(toolUse, toolContext);
      
      // Emit function call output
      this.emitResponseItem({
        id: `output_${toolUse.id}`,
        type: 'function_call_output',
        call_id: toolUse.id,
        output: result.content || '',
        metadata: result.is_error ? { error: true } : {}
      });
      
      // Add tool result to transcript for next turn
      if (this.disableResponseStorage) {
        this.transcript.push({
          type: 'function_call_output',
          call_id: toolUse.id,
          output: result.content || ''
        });
      }
      
    } catch (error) {
      console.error('Error handling tool use:', error);
      
      // Emit error output
      this.emitResponseItem({
        id: `error_${toolUse.id}`,
        type: 'function_call_output',
        call_id: toolUse.id,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { error: true }
      });
    }
  }
  
  /**
   * Emit response item with generation check
   */
  private emitResponseItem(item: ResponseItem): void {
    if (!this.canceled && !this.hardAbort.signal.aborted) {
      this.onItem(item);
    }
  }
  
  /**
   * Cancel current operation
   */
  public cancel(): void {
    if (this.terminated) return;
    
    this.canceled = true;
    this.execAbortController?.abort();
    
    if (this.currentStream && this.currentStream.abort) {
      this.currentStream.abort();
    }
    
    this.generation += 1;
    log(`ClaudeAgentLoop.cancel(): generation bumped to ${this.generation}`);
  }
  
  /**
   * Terminate agent (makes instance unusable)
   */
  public terminate(): void {
    if (this.terminated) return;
    
    this.terminated = true;
    this.hardAbort.abort();
    this.cancel();
  }
}