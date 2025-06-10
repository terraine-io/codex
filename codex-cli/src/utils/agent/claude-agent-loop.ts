/**
 * Claude/Anthropic implementation of IAgentLoop
 */

import type { IAgentLoop, AgentLoopCallbacks } from "./agent-loop-interface.js";
import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";
import type { ApprovalPolicy } from "../../approvals.js";
import type { AppConfig } from "../config.js";
import {
  ClaudeFormatConverter,
  type ClaudeCreateMessageRequest,
  type ClaudeCreateMessageResponse,
  type ClaudeContent,
  type ClaudeToolUseContent,
  type ClaudeToolResultContent
} from "./claude-types.js";
import { getClaudeTools, executeClaudeTool, type ClaudeToolContext } from "./claude-tools.js";
import { applyPatchToolInstructions } from "./apply-patch.js";
import { randomUUID } from "crypto";
import { log, debug, trace, isLevelEnabled, LogLevel } from "../logger/log.js";

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

  // Claude-specific conversation state for proper message pairing
  private claudeMessages: Array<{ role: 'user' | 'assistant', content: any[] }> = [];

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
      const { default: Anthropic } = await import('@anthropic-ai/sdk') as any;

      // Let Anthropic SDK handle API key automatically from environment
      // unless explicitly provided in config
      const clientConfig: any = {};

      if (this.config.apiKey) {
        debug(`🔑 Using Claude API key from config: ${this.config.apiKey.substring(0, 10)}...`);
        clientConfig.apiKey = this.config.apiKey;
      } else {
        debug(`🔑 Using Claude API key from ANTHROPIC_API_KEY environment variable`);
        // Let SDK use environment variable automatically
      }

      this.anthropic = new Anthropic(clientConfig);

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
   * Initialize agent with historical transcript (for session resumption)
   * This populates the internal conversation state without making API calls
   */
  public initializeTranscript(transcript: Array<ResponseInputItem>): void {
    if (this.terminated) {
      throw new Error("ClaudeAgentLoop has been terminated");
    }

    console.log(`🔄 Initializing ClaudeAgentLoop with ${transcript.length} historical items`);

    // Clear existing state
    this.transcript = [];
    this.claudeMessages = [];

    // Populate transcript for compatibility
    this.transcript.push(...transcript);

    // Convert transcript to Claude messages format
    for (const item of transcript) {
      if (item.type === 'message') {
        if (item.role === 'user') {
          // Handle user messages
          let contentItems: any[] = [];
          if (typeof item.content === 'string') {
            contentItems = [{ type: 'input_text', text: item.content }];
          } else if (Array.isArray(item.content)) {
            contentItems = item.content;
          }

          const content = contentItems.map(c => ({
            type: 'text' as const,
            text: c.type === 'input_text' ? c.text : `[${c.type}]`
          }));

          this.claudeMessages.push({
            role: 'user',
            content
          });

        } else if (item.role === 'assistant') {
          // Handle assistant messages
          let content: any[] = [];
          if (typeof item.content === 'string') {
            content = [{ type: 'text', text: item.content }];
          } else if (Array.isArray(item.content)) {
            content = item.content.map(c => {
              if (c.type === 'output_text') {
                return { type: 'text', text: c.text || '' };
              }
              return c; // Tool use content should already be in correct format
            });
          }

          this.claudeMessages.push({
            role: 'assistant',
            content
          });
        }
      }
      // Handle tool calls and other types if needed in the future
    }

    console.log(`✅ Initialized ClaudeAgentLoop with ${this.claudeMessages.length} Claude messages`);
  }

  /**
   * Execute agent conversation turn with multi-turn loop
   */
  public async run(
    input: Array<ResponseInputItem>,
    _previousResponseId: string = ""
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

      // Initialize conversation state with user input
      let currentMessages = this.prepareInitialMessages(input);

      // Multi-turn conversation loop - continue until no more tool calls
      while (currentMessages.length > 0) {
        if (this.canceled || this.hardAbort.signal.aborted) {
          this.onLoading(false);
          return;
        }

        log(`ClaudeAgentLoop: Starting turn with ${currentMessages.length} messages`);

        // Make API request to Claude
        const newToolResults = await this.executeClaudeTurn(currentMessages, thisGeneration);

        if (this.canceled || this.hardAbort.signal.aborted) {
          this.onLoading(false);
          return;
        }

        // If we got tool results, prepare them for the next turn
        if (newToolResults.length > 0) {
          // Add tool results to conversation state
          if (this.disableResponseStorage) {
            // Add tool results as user messages for Claude format
            for (const toolResult of newToolResults) {
              this.claudeMessages.push({
                role: 'user',
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolResult.tool_use_id,
                  content: toolResult.content || ''
                }]
              });
            }
            // Continue with current conversation state
            currentMessages = this.claudeMessages;
          } else {
            // When not using local storage, convert tool results for next turn
            currentMessages = ClaudeFormatConverter.convertToolResultsToClaudeMessages(newToolResults);
          }
          trace(`🔄 Continuing conversation with ${newToolResults.length} tool results`);
        } else {
          // No tool calls - conversation is complete
          currentMessages = [];
        }
      }

      this.onLoading(false);
      log(`ClaudeAgentLoop.run(): Completed generation ${thisGeneration}`);
    } catch (error) {
      this.onLoading(false);
      console.error('ClaudeAgentLoop.run() error:', error);

      // Emit error as response item
      this.emitResponseItem({
        id: `error_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        status: 'incomplete',
        content: [{
          type: 'output_text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          annotations: []
        }]
      });
    }
  }

  /**
   * Prepare initial messages from input
   */
  private prepareInitialMessages(input: Array<ResponseInputItem>): Array<{ role: 'user' | 'assistant', content: any[] }> {
    if (this.disableResponseStorage) {
      // Add new user input to Claude messages
      for (const item of input) {
        if (item.type === 'message' && item.role === 'user') {
          // Handle both string and array content types
          let contentItems: any[] = [];
          if (typeof item.content === 'string') {
            contentItems = [{ type: 'input_text', text: item.content }];
          } else if (Array.isArray(item.content)) {
            contentItems = item.content;
          }

          const content = contentItems.map(c => ({
            type: 'text' as const,
            text: c.type === 'input_text' ? c.text : `[${c.type}]`
          }));

          const userMessage = {
            role: 'user' as const,
            content
          };

          this.claudeMessages.push(userMessage);
          trace(`👤 ADDED USER MESSAGE: ${JSON.stringify(userMessage, null, 2)}`);
        }
      }

      // Also keep transcript for compatibility
      this.transcript.push(...input);

      return this.claudeMessages;
    } else {
      return ClaudeFormatConverter.convertInputToClaudeMessages(input);
    }
  }

  /**
   * Execute a single turn with Claude API
   */
  private async executeClaudeTurn(
    messages: Array<{ role: 'user' | 'assistant', content: any[] }>,
    thisGeneration: number
  ): Promise<Array<ClaudeToolResultContent>> {
    if (isLevelEnabled(LogLevel.TRACE)) {
      trace(`📋 FULL CONVERSATION STATE (${messages.length} messages):`);
      messages.forEach((msg, i) => {
        trace(`  Message ${i} (${msg.role}): ${JSON.stringify(msg.content, null, 4)}`);
      });
    }

    // Prepare system instructions, including apply_patch instructions for Claude models
    const systemInstructions = [
      applyPatchToolInstructions, // Always include for Claude models
      this.instructions
    ].filter(Boolean).join('\n\n');

    // Prepare Claude API request
    const request: ClaudeCreateMessageRequest = {
      model: this.model,
      max_tokens: 4096,
      messages,
      tools: getClaudeTools(),
      stream: true,
      ...(systemInstructions ? { system: systemInstructions } : {})
    };

    if (isLevelEnabled(LogLevel.TRACE)) {
      trace(`🚀 CLAUDE REQUEST: ${JSON.stringify(request, null, 2)}`);
    }

    return new Promise((resolve, reject) => {
      let responseId = `claude_${Date.now()}`;
      let finalMessage: ClaudeCreateMessageResponse | null = null;

      try {
        // Make streaming request to Claude
        const stream = this.anthropic.messages.stream(request);
        this.currentStream = stream;

        // Process streaming response
        stream.on('text', (text: string) => {
          if (this.canceled || thisGeneration !== this.generation) return;

          // Emit text as response item
          this.emitResponseItem({
            id: responseId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }]
          });
        });

        stream.on('contentBlock', (block: ClaudeContent) => {
          if (this.canceled || thisGeneration !== this.generation) return;

          // For tool_use blocks, just emit them as function calls
          // We'll handle tool execution after the full message is received
          if (block.type === 'tool_use') {
            this.emitResponseItem({
              id: block.id,
              type: 'function_call',
              name: block.name,
              arguments: JSON.stringify(block.input),
              call_id: block.id
            });
          }
        });

        stream.on('message', (message: ClaudeCreateMessageResponse) => {
          if (this.canceled || thisGeneration !== this.generation) return;

          if (isLevelEnabled(LogLevel.TRACE)) {
            trace(`📨 CLAUDE RESPONSE: ${JSON.stringify(message, null, 2)}`);
          }

          responseId = message.id;
          finalMessage = message;
          this.onLastResponseId(responseId);

          // Store response in Claude messages format for proper conversation flow
          if (this.disableResponseStorage && this.claudeMessages) {
            // Replace or update the last assistant message to ensure we have the complete message
            const lastMessageIndex = this.claudeMessages.length - 1;
            if (lastMessageIndex >= 0 && this.claudeMessages[lastMessageIndex]?.role === 'assistant') {
              // Update existing assistant message with complete content
              this.claudeMessages[lastMessageIndex] = {
                role: 'assistant',
                content: message.content
              };
            } else {
              // Add new assistant message
              this.claudeMessages.push({
                role: 'assistant',
                content: message.content
              });
            }

            if (isLevelEnabled(LogLevel.TRACE)) {
              trace(`💾 UPDATED CLAUDE MESSAGES (${this.claudeMessages.length} total)`);
            }
          }
        });

        stream.on('end', async () => {
          if (this.canceled || thisGeneration !== this.generation) {
            resolve([]);
            return;
          }

          // Process tool calls after the complete message is received
          const toolResults: Array<ClaudeToolResultContent> = [];

          if (finalMessage) {
            // Find all tool_use blocks in the message
            const toolUseBlocks = finalMessage.content.filter(
              (block): block is ClaudeToolUseContent => block.type === 'tool_use'
            );

            // Execute all tools sequentially to maintain proper order
            for (const toolUse of toolUseBlocks) {
              if (this.canceled || thisGeneration !== this.generation) break;

              try {
                const toolResult = await this.handleToolUseSync(toolUse);
                if (toolResult) {
                  toolResults.push(toolResult);
                }
              } catch (error) {
                console.error(`Error executing tool ${toolUse.name}:`, error);
                // Add error result to maintain tool_use/tool_result pairing
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  is_error: true
                });
              }
            }
          }

          log(`ClaudeAgentLoop: Turn completed with ${toolResults.length} tool results`);
          // If no tool results, we should stop loading immediately to show input prompt

          if (toolResults.length === 0) {
            this.onLoading(false);
          }

          resolve(toolResults);
        });

        stream.on('error', (error: any) => {
          if (this.canceled || thisGeneration !== this.generation) {
            resolve([]);
            return;
          }

          console.error('\n❌ CLAUDE ERROR:', error);
          this.emitResponseItem({
            id: responseId,
            type: 'message',
            role: 'assistant',
            status: 'incomplete',
            content: [{
              type: 'output_text',
              text: `Error: ${error.message || 'Unknown error occurred'}`,
              annotations: []
            }]
          });

          reject(error);
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle tool use from Claude (synchronous version for multi-turn loop)
   */
  private async handleToolUseSync(toolUse: ClaudeToolUseContent): Promise<ClaudeToolResultContent | null> {
    try {
      // Execute tool (function call item already emitted during streaming)
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
        output: result.content || ''
      });

      // Return result for continuation in multi-turn loop
      return result;

    } catch (error) {
      console.error('Error handling tool use:', error);

      // Emit error output
      this.emitResponseItem({
        id: `error_${toolUse.id}`,
        type: 'function_call_output',
        call_id: toolUse.id,
        output: `Error: ${error instanceof Error ? error.message : String(error)}`
      });

      // Return error result
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
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
