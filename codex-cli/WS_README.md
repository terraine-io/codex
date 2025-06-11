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
| `INSTRUCTIONS_FILE_PATH` | No | Path to file containing custom system instructions for the AI | `./system-prompt.txt` |
| `TOOL_USE_APPROVAL_MODE` | No | Tool usage approval policy | `suggest`, `auto-edit`, `full-auto` |
| `WORKING_DIRECTORY` | No | Working directory for the server | `/path/to/project` |
| `SESSION_STORE_PATH` | No | Directory for storing session logs | `./sessions` |
| `TODOS_STORE_PATH` | No | Directory for storing session todos files | `./todos` |
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

// Load instructions from file if specified
let instructions = '';
const instructionsFilePath = process.env.INSTRUCTIONS_FILE_PATH;
if (instructionsFilePath) {
  try {
    if (existsSync(instructionsFilePath)) {
      instructions = readFileSync(instructionsFilePath, 'utf-8');
      console.log(`✅ Loaded instructions from file: ${instructionsFilePath}`);
    } else {
      console.error(`❌ Instructions file not found: ${instructionsFilePath}`);
    }
  } catch (error) {
    console.error(`❌ Error reading instructions file: ${error.message}`);
  }
}

const config: AppConfig = {
  model,
  instructions,
  apiKey,
};

// Configure approval policy from environment variable
const approvalModeEnv = process.env.TOOL_USE_APPROVAL_MODE;
let approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default

if (approvalModeEnv) {
  if (approvalModeEnv === 'suggest' || approvalModeEnv === 'auto-edit' || approvalModeEnv === 'full-auto') {
    approvalPolicy = approvalModeEnv;
    console.log(`✅ Using tool approval mode: ${approvalPolicy}`);
  } else {
    console.error(`❌ Invalid TOOL_USE_APPROVAL_MODE: ${approvalModeEnv}`);
    console.error('Valid values are: suggest, auto-edit, full-auto');
    console.error('Using default: suggest');
  }
} else {
  console.log(`ℹ️  Using default tool approval mode: ${approvalPolicy}`);
}
```

### Tool Approval Modes

The `TOOL_USE_APPROVAL_MODE` environment variable controls how permissive the agent is when executing commands and making file changes. This significantly affects the user experience by reducing the number of approval prompts:

#### `suggest` (Default - Most Secure)
```bash
export TOOL_USE_APPROVAL_MODE="suggest"
```
- **Behavior**: Only "known safe" read-only commands are auto-approved
- **User Experience**: Requires approval for most file modifications and system commands
- **Use Case**: Maximum security, ideal for sensitive environments or when you want full control
- **Auto-approved commands**: `ls`, `cat`, `pwd`, `git status`, `grep`, `find` (without exec), etc.

#### `auto-edit` (Balanced)
```bash
export TOOL_USE_APPROVAL_MODE="auto-edit"
```
- **Behavior**: Safe commands + file edits within approved writable paths are auto-approved
- **User Experience**: Reduces approval prompts for file edits in your project directory
- **Use Case**: Good balance of productivity and safety for trusted projects
- **Auto-approved**: All `suggest` commands + `apply_patch` commands that only modify files within writable roots

#### `full-auto` (Most Permissive)
```bash
export TOOL_USE_APPROVAL_MODE="full-auto"
```
- **Behavior**: All commands are auto-approved but run in a security sandbox
- **User Experience**: Minimal approval prompts, maximum productivity
- **Use Case**: Trusted environments, rapid prototyping, or when using additional container security
- **Security**: Commands run with restricted network access and limited write permissions

**Important**: When using `full-auto` mode, ensure your environment has appropriate security measures in place, as the agent will execute commands without asking for permission.

### Session Task Planning

When a new session is created (i.e., when connecting to a session ID that doesn't have existing events), the server automatically creates a `<session_id>.md` file in the todos store directory (configured via `TODOS_STORE_PATH`). This file serves as a persistent task planning and tracking document for that specific session.

#### Todos File Features

- **Automatic Creation**: Created only for genuinely new sessions (not when resuming existing sessions)
- **Session-Specific**: Each session gets its own todos file named `<session_id>.md`
- **Separate Storage**: Stored in `TODOS_STORE_PATH` directory, separate from session logs
- **Persistent Tracking**: Todos persist independently of session logs and can be managed separately
- **Markdown Format**: Easy to read and edit both manually and programmatically
- **Task Tracking**: Provides structure for current and completed tasks
- **Agent Integration**: The agent can read and update this file to plan and track progress

**Note**: The todos file will only be created if `TODOS_STORE_PATH` is configured. If todos storage is disabled, no todos file will be created.

#### Example Session Todos File Structure

For session ID `a1b2c3d4e5f6789012345678901234567890abcd`, the file `a1b2c3d4e5f6789012345678901234567890abcd.md` would contain:

```markdown
# Terraine Session Todos

Session ID: `a1b2c3d4e5f6789012345678901234567890abcd`
Created: 2025-01-09T12:34:56.789Z

This file helps the agent plan and track tasks for the current session.

## Current Tasks

- [ ] No tasks yet - add your goals here

## Completed Tasks

(Tasks will be moved here when completed)

---

*This file was auto-created for session tracking. You can edit it manually or let the agent update it.*
```

#### Usage Tips

1. **Pre-populate**: Edit the file before starting your conversation to give the agent clear objectives
2. **Collaboration**: The agent can read your manual edits and update the file as work progresses
3. **Progress Tracking**: Use it to track what's been accomplished across multiple conversation turns
4. **Planning**: Help the agent break down complex tasks into manageable steps

## Session Management

The WebSocket server creates a fresh `AgentLoop` instance for each client connection. This ensures:

- **Clean State**: Each client gets a fresh conversation context
- **No Cross-Session Contamination**: Function calls from previous sessions don't affect new connections
- **Stateless Operation**: Uses `disableResponseStorage: true` to avoid server-side state issues
- **Reliable Reconnection**: Clients can disconnect and reconnect without encountering stale function call errors

### Session Logging

When `SESSION_STORE_PATH` is configured, the server logs all WebSocket events to JSONL files for auditing and analysis:

- **File Format**: Each session creates a file named `<session_id>.jsonl`
- **Session IDs**: UUIDs with dashes removed (e.g., `a1b2c3d4e5f6789012345678901234567890abcd`)
- **Event Logging**: All incoming and outgoing WebSocket messages are logged with timestamps

#### Session Event Structure

Each line in a session JSONL file contains a JSON object with this structure:

```typescript
interface SessionEvent {
  timestamp: string;           // ISO 8601 timestamp
  event_type: string;         // Type of event (see below)
  direction: 'incoming' | 'outgoing';  // Message direction
  message_data: any;          // The actual WebSocket message content
}
```

#### Event Types

**Session Lifecycle Events**
```json
{
  "timestamp": "2025-01-09T12:34:56.789Z",
  "event_type": "websocket_message_received",
  "direction": "incoming",
  "message_data": {"event": "session_started"}
}
```

```json
{
  "timestamp": "2025-01-09T12:45:30.123Z",
  "event_type": "websocket_message_received",
  "direction": "incoming",
  "message_data": {"event": "session_ended"}
}
```

**User Input Events**
```json
{
  "timestamp": "2025-01-09T12:35:01.456Z",
  "event_type": "websocket_message_received",
  "direction": "incoming",
  "message_data": {
    "id": "msg-123",
    "type": "user_input",
    "payload": {
      "input": [{"type": "input_text", "text": "Hello, can you help me?"}]
    }
  }
}
```

**Agent Response Events**
```json
{
  "timestamp": "2025-01-09T12:35:02.789Z",
  "event_type": "websocket_message_sent",
  "direction": "outgoing",
  "message_data": {
    "id": "resp-456",
    "type": "response_item",
    "payload": {
      "type": "message",
      "role": "assistant",
      "content": [{"type": "input_text", "text": "Hello! I'd be happy to help you."}]
    }
  }
}
```

**Approval Request Events**
```json
{
  "timestamp": "2025-01-09T12:36:15.234Z",
  "event_type": "websocket_message_sent",
  "direction": "outgoing",
  "message_data": {
    "id": "approval-789",
    "type": "approval_request",
    "payload": {
      "command": ["git", "status"],
      "applyPatch": null
    }
  }
}
```

**Approval Response Events**
```json
{
  "timestamp": "2025-01-09T12:36:20.567Z",
  "event_type": "websocket_message_received",
  "direction": "incoming",
  "message_data": {
    "id": "approval-response-abc",
    "type": "approval_response",
    "payload": {"review": "YES"}
  }
}
```

**Loading State Events**
```json
{
  "timestamp": "2025-01-09T12:35:05.890Z",
  "event_type": "websocket_message_sent",
  "direction": "outgoing",
  "message_data": {
    "id": "loading-def",
    "type": "loading_state",
    "payload": {"loading": true}
  }
}
```

**Error Events**
```json
{
  "timestamp": "2025-01-09T12:37:00.123Z",
  "event_type": "websocket_message_sent",
  "direction": "outgoing",
  "message_data": {
    "id": "error-ghi",
    "type": "error",
    "payload": {
      "message": "Command execution failed",
      "details": {"exitCode": 1}
    }
  }
}
```

### Session Resumption

The WebSocket server supports automatic session resumption. When a client connects to an existing session ID (via `/ws/{session_id}`), the server automatically loads the conversation history and restores the context without making unnecessary API calls.

#### How Session Resumption Works

1. **Client Connection**: Client connects to `/ws/{existing_session_id}`
2. **Event Loading**: Server loads all events from `{session_id}.jsonl`
3. **Transcript Reconstruction**: Events are filtered and converted back to conversation format
4. **Context Restoration**: AgentLoop is initialized with historical context (no API calls made)
5. **Seamless Continuation**: New user inputs include full conversation context when sent to LLM API

#### Messages Loaded into Transcript

The following message types are restored to maintain conversation context:

**✅ Loaded Messages:**
- **User Input Messages**: `websocket_message_received` with `type: 'user_input'`
  - Contains the actual user messages that need to be part of conversation context
- **Response Items**: `websocket_message_sent` with `type: 'response_item'`
  - Assistant messages (`role: 'assistant'`)
  - Tool calls and function calls
  - Tool results and outputs
  - Explanation messages (generated when user requests command explanations)
  - All other response items generated by the AgentLoop

**❌ NOT Loaded Messages:**
- **System/Control Events**: `session_started`, `session_connected`, `session_ended`
  - These don't represent conversation content
- **UI/State Messages**: `loading_state`, `context_info`, `context_compacted`, `agent_finished`
  - These are UI state updates, not conversation content
- **Approval Flow Messages**: `approval_request`, `approval_response`
  - These are interaction metadata, not part of the AI conversation
- **Error Messages**: `error`
  - Errors are typically transient and shouldn't persist in conversation history
- **Message Fragments**: Individual streaming chunks are filtered out
  - Only complete, combined messages are restored

#### Filtering Logic

The server uses this filtering approach to reconstruct the transcript:

```typescript
// Skip non-message events
if (event.event_type !== 'websocket_message_received' && 
    event.event_type !== 'websocket_message_sent') {
  continue;
}

// Skip system events like session_started, session_connected, etc.
if (event.message_data?.event) {
  continue;
}

// Load user inputs and response items only
if (event.event_type === 'websocket_message_received' && 
    event.message_data?.type === 'user_input') {
  // Load user input
}

if (event.event_type === 'websocket_message_sent' && 
    event.message_data?.type === 'response_item') {
  // Load AI responses, tool calls, explanations, etc.
}
```

This ensures that only actual conversation content is restored, while filtering out control messages, UI updates, and system events that aren't relevant for maintaining conversation context with the LLM.

### REST API for Session Management

The server provides REST endpoints for accessing session data:

**GET /sessions** - List all sessions
```json
{
  "sessions": [
    {
      "id": "a1b2c3d4e5f6789012345678901234567890abcd",
      "start_time": "2025-01-09T12:34:56.789Z",
      "last_update_time": "2025-01-09T12:45:30.123Z",
      "event_count": 42
    }
  ]
}
```

**POST /sessions** - Create a new session
- Creates a new empty session with a generated ID
- Returns `201 Created` with session info
```json
{
  "id": "b2c3d4e5f6g7890123456789012345678901bcde",
  "start_time": "2025-01-09T13:00:00.000Z",
  "last_update_time": "2025-01-09T13:00:00.000Z", 
  "event_count": 1
}
```

**GET /sessions/{sessionId}** - Get session data
- Returns full session data including all events
- Returns `404 Not Found` if session doesn't exist

**DELETE /sessions/{sessionId}** - Archive a session
- Archives the session file and associated todos file by moving them to hidden files with ISO timestamps
- Session file: `{sessionId}.jsonl` → `.{sessionId}-{timestamp}.jsonl`
- Todos file: `{sessionId}.md` → `.{sessionId}-{timestamp}.md` (if exists)
- Returns `204 No Content` on success
- Returns `404 Not Found` if session doesn't exist
- Returns `409 Conflict` if trying to delete an active session

**POST /sessions/{sessionId}:switch** - Switch to a session context
- Switches the agent's context to the specified session
- Creates a symbolic link `.terraine-todos.md` in the working directory pointing to the session's todos file
- Creates the session's todos file if it doesn't exist
- Overwrites any existing symbolic link (but protects regular files)
- Returns `200 OK` with session switch details on success
- Returns `404 Not Found` if session doesn't exist
- Returns `409 Conflict` if `.terraine-todos.md` exists as a regular file
- Returns `503 Service Unavailable` if todos storage is not configured

#### REST API Usage Examples

```bash
# Create a new session
curl -X POST http://localhost:8080/sessions

# List all sessions
curl http://localhost:8080/sessions

# Get specific session data
curl http://localhost:8080/sessions/a1b2c3d4e5f6789012345678901234567890abcd

# Archive a session
curl -X DELETE http://localhost:8080/sessions/a1b2c3d4e5f6789012345678901234567890abcd

# Switch to a session context
curl -X POST http://localhost:8080/sessions/a1b2c3d4e5f6789012345678901234567890abcd:switch
```

#### Session Context Switching

The session switching feature allows you to work with one session at a time while easily switching between different sessions. When you switch to a session:

1. **Symbolic Link Creation**: A `.terraine-todos.md` symlink is created in your working directory
2. **Points to Session Todos**: The symlink points to the specific session's todos file in `TODOS_STORE_PATH`
3. **Agent Access**: The agent can easily access the current session's todos via the well-known filename
4. **Context Isolation**: Only one session's todos are "active" at a time

**Example workflow:**
```bash
# Switch to session abc123
curl -X POST http://localhost:8080/sessions/abc123:switch

# Now .terraine-todos.md -> todos/abc123.md
# Agent can read/write .terraine-todos.md to work with this session's tasks

# Switch to a different session
curl -X POST http://localhost:8080/sessions/def456:switch

# Now .terraine-todos.md -> todos/def456.md  
# Agent context has switched to the new session
```

## Development

To extend the server:

1. Add new message types to the protocol
2. Implement handlers in the `handleMessage` method
3. Update the client example to demonstrate new features
4. Add proper TypeScript types for new message formats

The server is designed to be extensible and can be easily modified to support additional features or different communication patterns.
