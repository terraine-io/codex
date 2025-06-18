import { readFileSync } from 'fs';

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    type ClaudeTool,
    type ClaudeToolUseContent,
    type ClaudeToolResultContent,
} from './claude-types.js';
import { type ClaudeToolContext } from "./claude-tools.js";

interface McpServerConfig {
    command: string;
    args: string[];
    env: {
        [key: string]: string;
    };
}

export class JupyterMcpWrapper {
    mcpServerConfigJsonPath: string;
    client: Client;
    tools: Array<ClaudeTool> | null = null;

    constructor(mcpServerConfigJsonPath: string) {
        this.mcpServerConfigJsonPath = mcpServerConfigJsonPath;
        this.client = new Client({
            name: "codex-mcp-client",
            version: "1.0.0",
        });
    }

    async initialize() {
        const configData = readFileSync(this.mcpServerConfigJsonPath, 'utf-8');
        const serverConfig: McpServerConfig = JSON.parse(configData);

        let transport = new StdioClientTransport(serverConfig);
        await this.client.connect(transport);
    }

    async retrieveTools(): Promise<Array<ClaudeTool>> {
        if (this.tools) {
            return this.tools;
        }
        const tools = await this.client.listTools();
        for (const tool of tools.tools) {
            console.log(`[mcp-wrapper] Retrieved tool: ${tool.name}`);
            // Convert MCP tool format to Claude tool format
            if ('inputSchema' in tool) {
                (tool as any)['input_schema'] = tool.inputSchema;
                delete (tool as any)['inputSchema'];
            }
        }
        const mcpTools: Array<ClaudeTool> = tools.tools.map((t: any) => t as ClaudeTool);
        console.log(`[mcp-wrapper] Converted ${mcpTools.length} MCP tools to Claude format`);
        
        // Cache tools for future calls
        this.tools = mcpTools;

        return mcpTools;
    }


    /**
     * Execute a MCP tool use request
     */
    async call(
        toolUse: ClaudeToolUseContent,
        _context: ClaudeToolContext
    ): Promise<ClaudeToolResultContent> {
        const { name, input, id } = toolUse;

        try {
            const result = await this.client.callTool({
                name: name,
                arguments: input,
            });

            console.log(`[mcp-wrapper] Tool '${name}' executed successfully`);

            // Convert MCP CallToolResult to Claude format
            // MCP result has 'content' array and optional 'isError' field
            let claudeContent: string;
            
            if (result.content && Array.isArray(result.content) && result.content.length > 0) {
                // Convert MCP content blocks to text
                claudeContent = result.content.map((block: any) => {
                    if (block.type === 'text') {
                        return block.text;
                    } else if (block.type === 'resource') {
                        // Handle embedded resources
                        return `Resource: ${block.resource.uri}`;
                    } else {
                        // Handle other content types
                        return JSON.stringify(block);
                    }
                }).join('\n');
            } else {
                // Fallback to structured content or empty result
                claudeContent = result.structuredContent 
                    ? JSON.stringify(result.structuredContent, null, 2)
                    : 'Tool executed successfully (no output)';
            }

            return {
                type: "tool_result",
                tool_use_id: id,
                content: claudeContent,
                is_error: Boolean(result.isError)
            };
        } catch (error) {
            console.error(`Error executing MCP tool '${name}':`, error);

            // Clean error message for the LLM (Approach A)
            let errorMessage: string;
            if (error instanceof Error) {
                // Extract meaningful error information without MCP protocol details
                if (error.message.includes('Invalid params')) {
                    errorMessage = `Invalid parameters provided to tool '${name}'`;
                } else if (error.message.includes('Method not found')) {
                    errorMessage = `Tool '${name}' is not available`;
                } else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
                    errorMessage = `Tool '${name}' timed out`;
                } else {
                    errorMessage = `Tool '${name}' failed: ${error.message}`;
                }
            } else {
                errorMessage = `Tool '${name}' failed with unknown error`;
            }

            return {
                type: "tool_result",
                tool_use_id: id,
                content: errorMessage,
                is_error: true
            };
        }
    }
}
