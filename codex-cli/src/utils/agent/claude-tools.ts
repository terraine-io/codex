/**
 * Claude-specific tool implementations
 */

import type { ClaudeTool, ClaudeToolUseContent, ClaudeToolResultContent } from "./claude-types.js";
import { handleExecCommand } from "./handle-exec-command.js";
import type { AppConfig } from "../config.js";
import type { ApprovalPolicy } from "../../approvals.js";
import type { CommandConfirmation } from "./agent-loop.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

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
 * AddTodo tool for adding new TODO items
 */
export const claudeAddTodoTool: ClaudeTool = {
  name: "AddTodo",
  description: "Add a new TODO item to the JSON-based task tracking file. Creates the file if it doesn't exist.",
  input_schema: {
    type: "object",
    properties: {
      task_description: {
        type: "string",
        description: "Brief description of the task to be completed"
      }
    },
    required: ["task_description"]
  }
};

/**
 * UpdateTodo tool for updating TODO status
 */
export const claudeUpdateTodoTool: ClaudeTool = {
  name: "UpdateTodo",
  description: "Update the status of an existing TODO item by its ID.",
  input_schema: {
    type: "object",
    properties: {
      todo_id: {
        type: "string",
        description: "The unique ID of the TODO item to update"
      },
      new_status: {
        type: "string",
        description: "The new status for the TODO item (e.g., 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')"
      }
    },
    required: ["todo_id", "new_status"]
  }
};

/**
 * ShowTodos tool for displaying all TODO items
 */
export const claudeShowTodosTool: ClaudeTool = {
  name: "ShowTodos",
  description: "Display all TODO items from the JSON-based task tracking file.",
  input_schema: {
    type: "object",
    properties: {},
    required: []
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
      
      case "AddTodo":
        return await executeClaudeAddTodoTool(toolUse, context);
      
      case "UpdateTodo":
        return await executeClaudeUpdateTodoTool(toolUse, context);
      
      case "ShowTodos":
        return await executeClaudeShowTodosTool(toolUse, context);
        
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
 * TODO item interface
 */
interface TodoItem {
  id: string;
  short_task_description: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * TODO file structure
 */
interface TodoFile {
  items: TodoItem[];
}

/**
 * Get the path to the TODO JSON file
 */
function getTodoFilePath(): string {
  // Use the symlink in working directory that points to current session's todos file
  const workingDir = process.env.WORKING_DIRECTORY || process.cwd();
  return join(workingDir, '.terraine', 'todos.json');
}

/**
 * Load TODO file, creating it if it doesn't exist
 */
function loadTodoFile(): TodoFile {
  const filePath = getTodoFilePath();
  
  if (!existsSync(filePath)) {
    // Create empty TODO file
    const emptyTodoFile: TodoFile = { items: [] };
    
    // Ensure directory exists
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    writeFileSync(filePath, JSON.stringify(emptyTodoFile, null, 2), 'utf-8');
    return emptyTodoFile;
  }
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    const todoFile = JSON.parse(content) as TodoFile;
    
    // Ensure the file has the correct structure
    if (!todoFile.items || !Array.isArray(todoFile.items)) {
      todoFile.items = [];
    }
    
    return todoFile;
  } catch (error) {
    console.error('Error reading TODO file, creating new one:', error);
    const emptyTodoFile: TodoFile = { items: [] };
    writeFileSync(filePath, JSON.stringify(emptyTodoFile, null, 2), 'utf-8');
    return emptyTodoFile;
  }
}

/**
 * Save TODO file
 */
function saveTodoFile(todoFile: TodoFile): void {
  const filePath = getTodoFilePath();
  writeFileSync(filePath, JSON.stringify(todoFile, null, 2), 'utf-8');
}

/**
 * Execute Claude AddTodo tool
 */
async function executeClaudeAddTodoTool(
  toolUse: ClaudeToolUseContent,
  context: ClaudeToolContext
): Promise<ClaudeToolResultContent> {
  const { input, id } = toolUse;
  
  // Validate input
  if (!input['task_description'] || typeof input['task_description'] !== 'string') {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: "Error: 'task_description' is required and must be a string",
      is_error: true
    };
  }
  
  const taskDescription = input['task_description'] as string;
  
  try {
    const todoFile = loadTodoFile();
    const now = new Date().toISOString();
    
    const newTodo: TodoItem = {
      id: randomUUID(),
      short_task_description: taskDescription,
      status: "PENDING",
      created_at: now,
      updated_at: now
    };
    
    todoFile.items.push(newTodo);
    saveTodoFile(todoFile);
    
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Successfully added TODO item with ID: ${newTodo.id}\nTask: ${taskDescription}\nStatus: PENDING`,
      is_error: false
    };
    
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Failed to add TODO: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

/**
 * Execute Claude UpdateTodo tool
 */
async function executeClaudeUpdateTodoTool(
  toolUse: ClaudeToolUseContent,
  context: ClaudeToolContext
): Promise<ClaudeToolResultContent> {
  const { input, id } = toolUse;
  
  // Validate input
  if (!input['todo_id'] || typeof input['todo_id'] !== 'string') {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: "Error: 'todo_id' is required and must be a string",
      is_error: true
    };
  }
  
  if (!input['new_status'] || typeof input['new_status'] !== 'string') {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: "Error: 'new_status' is required and must be a string",
      is_error: true
    };
  }
  
  const todoId = input['todo_id'] as string;
  const newStatus = input['new_status'] as string;
  
  try {
    const todoFile = loadTodoFile();
    const todoIndex = todoFile.items.findIndex(item => item.id === todoId);
    
    if (todoIndex === -1) {
      return {
        type: "tool_result",
        tool_use_id: id,
        content: `Error: TODO item with ID '${todoId}' not found`,
        is_error: true
      };
    }
    
    const oldStatus = todoFile.items[todoIndex].status;
    todoFile.items[todoIndex].status = newStatus;
    todoFile.items[todoIndex].updated_at = new Date().toISOString();
    
    saveTodoFile(todoFile);
    
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Successfully updated TODO item '${todoFile.items[todoIndex].short_task_description}'\nID: ${todoId}\nStatus: ${oldStatus} → ${newStatus}`,
      is_error: false
    };
    
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Failed to update TODO: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

/**
 * Execute Claude ShowTodos tool
 */
async function executeClaudeShowTodosTool(
  toolUse: ClaudeToolUseContent,
  context: ClaudeToolContext
): Promise<ClaudeToolResultContent> {
  const { id } = toolUse;
  
  try {
    const todoFile = loadTodoFile();
    
    if (todoFile.items.length === 0) {
      return {
        type: "tool_result",
        tool_use_id: id,
        content: "No TODO items found. The task list is empty.",
        is_error: false
      };
    }
    
    // Format the TODO items for display
    let output = `TODO Items (${todoFile.items.length} total):\n\n`;
    
    todoFile.items.forEach((item, index) => {
      output += `${index + 1}. [${item.status}] ${item.short_task_description}\n`;
      output += `   ID: ${item.id}\n`;
      output += `   Created: ${item.created_at}\n`;
      output += `   Updated: ${item.updated_at}\n\n`;
    });
    
    // Also include the raw JSON for programmatic access
    output += `\nRaw JSON data:\n${JSON.stringify(todoFile, null, 2)}`;
    
    return {
      type: "tool_result",
      tool_use_id: id,
      content: output,
      is_error: false
    };
    
  } catch (error) {
    return {
      type: "tool_result",
      tool_use_id: id,
      content: `Failed to show TODOs: ${error instanceof Error ? error.message : String(error)}`,
      is_error: true
    };
  }
}

/**
 * TODO tools instructions for Claude system prompt
 */
export const todoToolsInstructions = `
## TODO Management Tools

You have access to purpose-built TODO management tools for tracking tasks efficiently:

### AddTodo Tool
- **Purpose**: Add new TODO items to a structured JSON-based task list
- **Usage**: Call with a clear, concise task description
- **Auto-creates**: File and directory structure if they don't exist
- **Status**: All new TODOs start with "PENDING" status
- **Example**: AddTodo with task_description: "Implement user authentication"

### UpdateTodo Tool  
- **Purpose**: Update the status of existing TODO items
- **Usage**: Provide the todo_id and new_status
- **Common statuses**: "PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"
- **Example**: UpdateTodo with todo_id: "abc-123" and new_status: "COMPLETED"

### ShowTodos Tool
- **Purpose**: Display all current TODO items in both formatted and raw JSON
- **Usage**: No parameters required
- **Output**: Human-readable list plus raw JSON data for programmatic access

### Best Practices
- Use AddTodo when starting new tasks or breaking down complex work
- Update status regularly to track progress (PENDING → IN_PROGRESS → COMPLETED)
- Use ShowTodos frequently to review current task state
- Keep task descriptions concise but informative
- Use consistent status values for better organization

`;

/**
 * Get all available Claude tools
 */
export function getClaudeTools(): Array<ClaudeTool> {
  return [
    claudeShellTool,
    claudeAddTodoTool,
    claudeUpdateTodoTool,
    claudeShowTodosTool
  ];
}