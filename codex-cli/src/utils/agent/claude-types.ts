/**
 * Claude/Anthropic-specific types for request/response handling
 */

import type { ResponseInputItem, ResponseItem } from "openai/resources/responses/responses.mjs";

// Claude Message Types
export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: Array<ClaudeContent>;
}

export type ClaudeContent =
  | ClaudeTextContent
  | ClaudeToolUseContent
  | ClaudeToolResultContent;

export interface ClaudeTextContent {
  type: 'text';
  text: string;
}

export interface ClaudeToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ClaudeToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

// Claude API Request/Response Types
export interface ClaudeCreateMessageRequest {
  model: string;
  max_tokens: number;
  messages: Array<ClaudeMessage>;
  tools?: Array<ClaudeTool>;
  stream?: boolean;
  system?: string;
}

export interface ClaudeCreateMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<ClaudeContent>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Claude Tool Definition
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

// Claude Streaming Types
export interface ClaudeStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop';
  message?: ClaudeCreateMessageResponse;
  content_block?: ClaudeContent;
  delta?: {
    text?: string;
    partial_json?: string;
  };
  index?: number;
}

/**
 * Converter utilities between OpenAI ResponseInputItem/ResponseItem and Claude formats
 */
export class ClaudeFormatConverter {

  /**
   * Convert OpenAI ResponseInputItem array to Claude messages format
   */
  static convertInputToClaudeMessages(input: Array<ResponseInputItem>): Array<ClaudeMessage> {
    const messages: Array<ClaudeMessage> = [];

    for (const item of input) {
      switch (item.type) {
        case 'message':
          if (item.role === 'user' || item.role === 'assistant') {
            const content: Array<ClaudeContent> = [];

            if (Array.isArray(item.content)) {
              for (const contentItem of item.content) {
                if (contentItem.type === 'input_text') {
                  content.push({
                    type: 'text',
                    text: contentItem.text
                  });
                }
              }
            }

            if (content.length > 0) {
              messages.push({
                role: item.role,
                content
              });
            }
          }
          break;

        case 'function_call':
          // Convert function call to tool use format
          if (messages.length > 0 && messages[messages.length - 1]?.role === 'assistant') {
            const lastMessage = messages[messages.length - 1];
            if (lastMessage) {
              let args: Record<string, any> = {};

              try {
                args = item.arguments ? JSON.parse(item.arguments) : {};
              } catch (e) {
                console.warn('Failed to parse function arguments:', item.arguments);
              }

              lastMessage.content.push({
                type: 'tool_use',
                id: item.id || `call_${Date.now()}`,
                name: item.name,
                input: args
              });
            }
          }
          break;

        case 'function_call_output':
          // Convert function output to tool result
          // In Claude, tool results must be sent as user messages immediately after assistant tool use
          if (messages.length > 0) {
            const content: Array<ClaudeContent> = [{
              type: 'tool_result',
              tool_use_id: item.call_id || item.id || 'unknown',
              content: item.output || ''
            }];

            // Add as user message (tool results come from user in Claude)
            messages.push({
              role: 'user',
              content
            });
          }
          break;
      }
    }

    return messages;
  }

  /**
   * Convert Claude response content to OpenAI ResponseItem
   */
  static convertClaudeResponseToResponseItem(
    response: ClaudeCreateMessageResponse | ClaudeContent,
    id?: string
  ): ResponseItem {
    const responseId = id || `claude_${Date.now()}`;

    // Handle streaming content block
    if ('type' in response && response.type !== 'message') {
      const content = response as ClaudeContent;

      switch (content.type) {
        case 'text':
          return {
            id: responseId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: content.text,
              annotations: []
            }]
          };

        case 'tool_use':
          return {
            id: responseId,
            type: 'function_call',
            name: content.name,
            arguments: JSON.stringify(content.input),
            call_id: content.id
          };

        default:
          throw new Error(`Unsupported Claude content type: ${(content as any).type}`);
      }
    }

    // Handle full message response
    const message = response as ClaudeCreateMessageResponse;

    // If message contains only text, return as message
    if (message.content.every(c => c.type === 'text')) {
      return {
        id: responseId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: message.content.map(c => ({
          type: 'output_text' as const,
          text: (c as ClaudeTextContent).text,
          annotations: []
        }))
      };
    }

    // If message contains tool use, we'll need to emit multiple response items
    // For now, return the first content item
    const firstContent = message.content[0];
    if (firstContent) {
      return this.convertClaudeResponseToResponseItem(firstContent, responseId);
    }

    throw new Error('Empty Claude response content');
  }

  /**
   * Convert tool results to Claude messages format for next conversation turn
   */
  static convertToolResultsToClaudeMessages(
    toolResults: Array<ClaudeToolResultContent>
  ): Array<ClaudeMessage> {
    if (toolResults.length === 0) {
      return [];
    }

    // Claude requires tool results to be sent as user messages
    const content: Array<ClaudeContent> = toolResults.map(result => ({
      type: 'tool_result',
      tool_use_id: result.tool_use_id,
      content: result.content || '',
      is_error: result.is_error
    }));

    return [{
      role: 'user',
      content
    }];
  }
}