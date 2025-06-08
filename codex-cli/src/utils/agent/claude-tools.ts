/**
 * Claude-specific tool implementations
 */

import type { ClaudeTool, ClaudeToolUseContent, ClaudeToolResultContent } from "./claude-types.js";
import { handleExecCommand } from "./handle-exec-command.js";
import type { AppConfig } from "../config.js";
import type { ApprovalPolicy } from "../../approvals.js";
import type { CommandConfirmation } from "./agent-loop.js";

/**
 * Shell tool for Claude - equivalent to the OpenAI shell tool
 */
export const claudeShellTool: ClaudeTool = {
  name: "shell",
  description: "Execute shell commands and return their output. Use this to run commands, read files, write files, and perform system operations.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description: "The shell command as an array of strings (e.g., ['ls', '-la'])"
      },
      workdir: {
        type: "string", 
        description: "Working directory for the command (optional)"
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (optional)"
      }
    },
    required: ["command"]
  }
};

/**
 * Tool execution context for Claude
 */
export interface ClaudeToolContext {
  config: AppConfig;
  approvalPolicy: ApprovalPolicy;
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch?: any
  ) => Promise<CommandConfirmation>;
  additionalWritableRoots: ReadonlyArray<string>;
  abortSignal?: AbortSignal;
}

/**
 * Execute a Claude tool use request
 */
export async function executeClaudeTool(
  toolUse: ClaudeToolUseContent,
  context: ClaudeToolContext
): Promise<ClaudeToolResultContent> {
  const { name, id } = toolUse;
  
  try {
    switch (name) {
      case "shell":
        return await executeClaudeShellTool(toolUse, context);
        
      default:
        return {
          type: "tool_result",
          tool_use_id: id,
          content: `Error: Unknown tool '${name}'`,
          is_error: true
        };
    }
  } catch (error) {
    console.error(`Error executing Claude tool '${name}':`, error);
    
    return {
      type: "tool_result", 
      tool_use_id: id,
      content: `Error executing tool '${name}': ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

/**
 * Execute Claude shell tool
 */
async function executeClaudeShellTool(
  toolUse: ClaudeToolUseContent,
  context: ClaudeToolContext
): Promise<ClaudeToolResultContent> {
  const { input, id } = toolUse;
  
  // Validate input
  if (!Array.isArray(input['command'])) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: "Error: 'command' must be an array of strings",
      is_error: true
    };
  }
  
  const command = input['command'] as string[];
  const workdir = input['workdir'] as string | undefined;
  const timeout = input['timeout'] as number | undefined;
  
  try {
    // Use the existing handleExecCommand function
    const result = await handleExecCommand(
      {
        cmd: command,
        workdir,
        timeoutInMillis: timeout
      },
      context.config,
      context.approvalPolicy,
      context.additionalWritableRoots,
      context.getCommandConfirmation,
      context.abortSignal
    );
    
    if (!result) {
      return {
        type: "tool_result",
        tool_use_id: id,
        content: "Command was cancelled or denied",
        is_error: false
      };
    }
    
    // Format output similar to OpenAI function call output
    const output = {
      output: result.outputText,
      metadata: result.metadata || {}
    };
    
    return {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify(output),
      is_error: false
    };
    
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Shell command failed: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

/**
 * Get all available Claude tools
 */
export function getClaudeTools(): Array<ClaudeTool> {
  return [
    claudeShellTool
    // Additional tools can be added here
  ];
}