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
- `WS_README.md` - This documentation file

## Setup

### Prerequisites

1. Ensure you have the Codex CLI dependencies installed:
   ```bash
   npm install
   ```

2. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY="your-api-key-here"
   ```
   
   **Note**: The server will automatically check for this environment variable on startup and exit with an error if it's not set.

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

The server can be customized by modifying the `AgentLoop` initialization in `ws-server.ts`:

```typescript
const config: AppConfig = {
  model: 'gpt-4', // or 'gpt-3.5-turbo', 'codex', etc.
  instructions: 'Custom system instructions',
  apiKey: process.env.OPENAI_API_KEY,
};

const approvalPolicy: ApprovalPolicy = 'suggest'; // 'suggest', 'auto-edit', 'full-auto'
```

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
