import { readFileSync } from 'fs';

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ClaudeTool } from './src/utils/agent/claude-types.js';

interface McpServerConfig {
    command: string;
    args: string[];
    env: {
      [key: string]: string;
    };
}

// {
//     "name": "append_execute_code_cell",
//     "description": "Append at the end of the notebook a code cell with the provided source and execute it.\n    \n    Args:\n        cell_source: Code source\n\n    Returns:\n        list[str]: List of outputs from the executed cell\n    ",
//     "inputSchema": {
//       "type": "object",
//       "properties": {
//         "cell_source": {
//           "title": "Cell Source",
//           "type": "string"
//         }
//       },
//       "required": [
//         "cell_source"
//       ],
//       "title": "append_execute_code_cellArguments"
//     }
//   },

export class JupyterMcpWrapper {
    mcpServerConfigJsonPath: string;
    client: Client;

    constructor(mcpServerConfigJsonPath: string) {
        this.mcpServerConfigJsonPath = mcpServerConfigJsonPath;
    }

    async initialize() {
        const configData = readFileSync(this.mcpServerConfigJsonPath, 'utf-8');
        const serverConfig: McpServerConfig = JSON.parse(configData);
    
        let transport = new StdioClientTransport(serverConfig);
        this.client = new Client({
            name: "jupyter",
            version: "1.0.0",
        });
        await this.client.connect(transport);    
    }

    async retrieveTools(): Promise<Array<ClaudeTool>> {
        const tools = await this.client.listTools();
        for (let t in tools.tools) {
            let tool = tools.tools[t];
            console.log(`retrieveTools [${tool.name}]`);
            for (let k in tool) {
                console.log(`retrieveTools [${tool.name}] -> [${k}]`)
                if (k == 'inputSchema') {
                    tool['input_schema'] = tool['inputSchema'];
                    delete tool['inputSchema'];
                }
            }
        }
        const mcpTools: Array<ClaudeTool> = tools.tools.map((t: any) => t as ClaudeTool);
        console.log('[JupyterMcpWrapper] Available tools: ', JSON.stringify(mcpTools, null, 2));

        return mcpTools
    }
}
