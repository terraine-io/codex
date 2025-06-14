# WebSocket AgentLoop Server

This WebSocket server provides web-based access to the Codex CLI's `AgentLoop` functionality, allowing you to interact with the AI agent over a WebSocket connection.

## Features

- **Real-time Communication**: Stream messages between client and AgentLoop
- **User Approval Handling**: Interactive approval flow for commands requiring user confirmation
- **Loading State Management**: Real-time feedback on agent processing status
- **Error Handling**: Comprehensive error reporting and graceful failure handling
- **Session Management**: Proper cleanup and state management for client connections

## Files

- `ws-server.ts` - Main WebSocket server implementation
- `ws-client-example.js` - Example Node.js client demonstrating usage (ES module syntax)
- `.env.example` - Example environment configuration file
- `build-ws-server.mjs` - Build script for the WebSocket server
- `WS_README.md` - This documentation file

## Setup

### Prerequisites

1. Ensure you have the Codex CLI dependencies installed:
   ```bash
   npm install
   ```

2. Configure environment variables:
   
   **Option A: Using environment variables**
   ```bash
   # For OpenAI (default provider)
   export OPENAI_API_KEY="your-api-key-here"
   
   # For Anthropic/Claude
   export ANTHROPIC_API_KEY="your-anthropic-key-here"
   export PROVIDER="anthropic"
   export MODEL="claude-3-5-sonnet-20241022"
   
   # For Google/Gemini  
   export GOOGLE_API_KEY="your-google-key-here"
   export PROVIDER="google"
   export MODEL="gemini-1.5-pro"
   
   export WORKING_DIRECTORY="/path/to/your/project"  # Optional
   ```
   
   **Option B: Using a .env file (recommended)**
   ```bash
   cp ws-server.env.example .env
   # Edit .env with your configuration
   ```
   
   **Note**: The server will automatically:
   - Load variables from a `.env` file if present
   - Auto-detect the provider based on the model name, or use the `PROVIDER` environment variable
   - Check for the appropriate API key based on provider:
     - OpenAI: `OPENAI_API_KEY`
     - Anthropic: `ANTHROPIC_API_KEY`
     - Google: `GOOGLE_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS`
   - Exit with an error if the required API key is not set
   - Change to `WORKING_DIRECTORY` if specified (can be relative or absolute path)

3. Install WebSocket dependencies:
   ```bash
   npm install ws @types/ws
   ```

### Running the Server

1. **Using npm scripts (recommended):**
   ```bash
   # Build the server
   node build-ws-server.mjs
   
   # Start the server
   npm run start:ws
   ```

2. **Manual build and run:**
   ```bash
   # Build the server
   node build-ws-server.mjs
   
   # Start the server
   node dist/ws-server.js
   ```

The server will start on port 8080 by default.

### Running the Example Client

In a separate terminal:
```bash
node ws-client-example.js
```

**Note**: The example client uses ES module syntax (`import`/`export`) since this project is configured as an ES module. If you're adapting this code for a CommonJS project, you'll need to convert the imports to `require()` statements and save the file with a `.cjs` extension.

## Message Protocol

The WebSocket communication uses JSON messages with the following structure:

```typescript
interface WSMessage {
  id: string;
  type: string;
  payload?: any;
}
```

### Message Types

#### Client to Server

**User Input**
```json
{
  "id": "uuid",
  "type": "user_input",
  "payload": {
    "input": [
      {
        "type": "message",
        "role": "user", 
        "content": [{"type": "input_text", "text": "Your message here"}]
      }
    ],
    "previousResponseId": "optional-response-id"
  }
}
```

**Approval Response**
```json
{
  "id": "uuid",
  "type": "approval_response",
  "payload": {
    "review": "YES|NO|NO_CONTINUE|ALWAYS|EXPLAIN",
    "applyPatch": {...},
    "customDenyMessage": "optional custom message"
  }
}
```

#### Server to Client

**Response Item** - Streaming AI responses
```json
{
  "id": "uuid",
  "type": "response_item",
  "payload": {
    "type": "message|function_call|function_call_output|reasoning",
    "role": "assistant|system|user",
    "content": [...],
    // ... other ResponseItem fields
  }
}
```

**Loading State** - Indicates when the agent is processing
```json
{
  "id": "uuid",
  "type": "loading_state",
  "payload": {"loading": true}
}
```

**Approval Request** - Requests user approval for commands
```json
{
  "id": "uuid",
  "type": "approval_request",
  "payload": {
    "command": ["git", "status"],
    "applyPatch": {...} // Optional, for file modifications
  }
}
```

**Agent Finished** - Indicates the agent has completed processing
```json
{
  "id": "uuid",
  "type": "agent_finished",
  "payload": {"responseId": "response-id"}
}
```

**Error** - Error messages
```json
{
  "id": "uuid",
  "type": "error",
  "payload": {
    "message": "Error description",
    "details": {...} // Optional additional details
  }
}
```

## Usage Flow

1. **Client Connection**: Client connects to WebSocket server
2. **AgentLoop Initialization**: Server creates new AgentLoop instance
3. **User Input**: Client sends user message via `user_input` message
4. **Agent Processing**: Server processes input through AgentLoop
5. **Response Streaming**: Server streams response items back to client
6. **Approval Handling**: If command requires approval:
   - Server sends `approval_request` to client
   - Client displays approval UI to user
   - Client sends `approval_response` back to server
   - Server continues processing based on user decision
7. **Completion**: Server sends `agent_finished` when processing is complete
8. **Control Transfer**: Client can send new input to continue conversation

## Approval Decisions

When the agent requests approval for a command, the client can respond with:

- `YES` - Approve this specific command
- `NO` - Deny command and stop processing
- `NO_CONTINUE` - Deny command but continue with other tasks
- `ALWAYS` - Approve this command and similar ones in the future
- `EXPLAIN` - Ask the agent to explain what the command does

## Configuration Options

### Environment Variables

The server supports the following environment variables (can be set via `.env` file):

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `OPENAI_API_KEY` | Conditional | Your OpenAI API key (required for OpenAI provider) | `sk-...` |
| `ANTHROPIC_API_KEY` | Conditional | Your Anthropic API key (required for Anthropic provider) | `sk-ant-...` |
| `GOOGLE_API_KEY` | Conditional | Your Google API key (required for Google provider) | `AIza...` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Conditional | Path to Google service account JSON (alternative to API key) | `/path/to/service-account.json` |
| `PROVIDER` | No | AI provider to use | `openai`, `anthropic`, `google` |
| `MODEL` | No | Model to use | `gpt-4`, `claude-3-5-sonnet-20241022`, `gemini-1.5-pro` |
| `INSTRUCTIONS` | No | Custom system instructions for the AI | `You are a helpful coding assistant.` |
| `WORKING_DIRECTORY` | No | Working directory for the server | `/path/to/project` |
| `CONTEXT_STRATEGY` | No | Context management strategy | `threshold`, `dummy` |
| `CONTEXT_COMPACTION_THRESHOLD` | No | Auto-compaction threshold (0.0-1.0) | `0.8` |
| `LOG_LEVEL` | No | Logging level | `trace`, `debug`, `info`, `warn`, `error` |

### Code Configuration

The server can also be customized by modifying the `AgentLoop` initialization in `ws-server.ts`:

```typescript
// Provider is auto-detected from model name or set explicitly
const model = process.env.MODEL || 'codex-mini-latest';
const provider = process.env.PROVIDER || AgentLoopFactory.detectProvider(model);

// API key is selected based on provider
let apiKey: string;
if (provider === 'anthropic') {
  apiKey = process.env.ANTHROPIC_API_KEY || '';
} else if (provider === 'google') {
  apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
} else {
  apiKey = process.env.OPENAI_API_KEY || '';
}

const config: AppConfig = {
  model,
  instructions: process.env.INSTRUCTIONS || '',
  apiKey,
};

const approvalPolicy: ApprovalPolicy = 'suggest'; // 'suggest', 'auto-edit', 'full-auto'
```

## Session Management

The WebSocket server creates a fresh `AgentLoop` instance for each client connection. This ensures:

- **Clean State**: Each client gets a fresh conversation context
- **No Cross-Session Contamination**: Function calls from previous sessions don't affect new connections
- **Stateless Operation**: Uses `disableResponseStorage: true` to avoid server-side state issues
- **Reliable Reconnection**: Clients can disconnect and reconnect without encountering stale function call errors

## Security Considerations

- The server runs with the same permissions as the user who starts it
- File operations are constrained to the current working directory by default
- Commands requiring approval will prompt the user before execution
- Consider running in a sandboxed environment for production use

## Example Use Cases

1. **Web IDE Integration**: Embed the WebSocket client in a web-based IDE
2. **Chat Interface**: Create a web chat interface for the AI agent
3. **API Gateway**: Use as a bridge between web applications and the AgentLoop
4. **Remote Development**: Access the agent from remote environments

## Troubleshooting

**Connection Issues**
- Ensure the server is running on the correct port
- Check that no firewall is blocking the connection
- Verify WebSocket support in your client

**Authentication Errors**
- Verify your OpenAI API key is set correctly
- Check API quota and billing status

**Command Approval Issues**
- Ensure proper approval response format
- Check that the client handles approval requests correctly

## Development

To extend the server:

1. Add new message types to the protocol
2. Implement handlers in the `handleMessage` method
3. Update the client example to demonstrate new features
4. Add proper TypeScript types for new message formats

The server is designed to be extensible and can be easily modified to support additional features or different communication patterns.
