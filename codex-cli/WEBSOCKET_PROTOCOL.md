# WebSocket Protocol Documentation

This document describes the message protocol for communicating with the AgentLoop WebSocket server. All messages are exchanged as JSON objects over a WebSocket connection.

## Base Message Structure

All WebSocket messages follow this base structure:

```typescript
interface WSMessage {
  id: string;        // Unique identifier for the message (UUID recommended)
  type: string;      // Message type identifier
  payload?: any;     // Message-specific data
}
```

## Message Flow Overview

```
Client                          Server
  |                               |
  |-- user_input ----------------->|  (User sends message)
  |                               |
  |<-- loading_state --------------|  (Agent starts processing)
  |<-- response_item --------------|  (Streaming responses)
  |<-- response_item --------------|  (More responses...)
  |                               |
  |<-- approval_request ----------|  (Command needs approval)
  |-- approval_response ---------->|  (User decision)
  |                               |
  |<-- response_item --------------|  (Continue processing)
  |<-- agent_finished -------------|  (Processing complete)
  |                               |
  |-- user_input ----------------->|  (New conversation turn)
```

---

## Client → Server Messages

### 1. User Input Message

Sends user input to the AI agent for processing.

```typescript
interface UserInputMessage {
  id: string;
  type: "user_input";
  payload: {
    input: Array<ResponseInputItem>;
    previousResponseId?: string;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "user_input",
  "payload": {
    "input": [
      {
        "type": "message",
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": "Please check the git status and list the files in the current directory"
          }
        ]
      }
    ]
  }
}
```

**Fields:**
- `input`: Array of input items (typically contains a user message)
- `previousResponseId`: Optional ID from previous response (not used in current implementation due to stateless design)

### 2. Approval Response Message

Responds to an approval request from the server.

```typescript
interface ApprovalResponseMessage {
  id: string;
  type: "approval_response";
  payload: {
    review: "YES" | "NO" | "NO_CONTINUE" | "ALWAYS" | "EXPLAIN";
    applyPatch?: ApplyPatchCommand;
    customDenyMessage?: string;
    explanation?: string;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "type": "approval_response",
  "payload": {
    "review": "yes",
    "customDenyMessage": null
  }
}
```

**Review Options:**
- `"yes"`: Approve this specific command
- `"no-exit"`: Deny command and stop all processing
- `"no-continue"`: Deny command but allow agent to continue with other tasks
- `"always"`: Approve this command and auto-approve similar commands in future
- `"explain"`: Ask the agent to explain what this command does before deciding

---

## Server → Client Messages

### 1. Response Item Message

Streams individual response items from the AI agent.

```typescript
interface ResponseItemMessage {
  id: string;
  type: "response_item";
  payload: ResponseItem;
}
```

**Common Response Item Types:**

#### Assistant Message
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "type": "response_item",
  "payload": {
    "id": "resp_abc123",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "input_text",
        "text": "I'll check the git status and list the files for you."
      }
    ]
  }
}
```

#### Function Call (Tool Use)
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "type": "response_item",
  "payload": {
    "id": "call_abc123",
    "type": "function_call",
    "call_id": "call_abc123",
    "name": "shell",
    "arguments": "{\"command\": [\"git\", \"status\"]}"
  }
}
```

#### Function Call Output
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "type": "response_item",
  "payload": {
    "id": "output_abc123",
    "type": "function_call_output",
    "call_id": "call_abc123",
    "output": "{\"output\": \"On branch main\\nnothing to commit, working tree clean\", \"metadata\": {\"exit_code\": 0, \"duration_seconds\": 0.1}}"
  }
}
```

#### Reasoning (for models that support it)
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440005",
  "type": "response_item",
  "payload": {
    "id": "reasoning_abc123",
    "type": "reasoning",
    "content": [
      {
        "type": "input_text",
        "text": "The user wants me to check git status and list files. I should run git status first, then ls to show the directory contents."
      }
    ],
    "duration_ms": 1500
  }
}
```

#### System Message
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440006",
  "type": "response_item",
  "payload": {
    "id": "sys_abc123",
    "type": "message",
    "role": "system",
    "content": [
      {
        "type": "input_text",
        "text": "⚠️ Network error while contacting OpenAI. Please check your connection and try again."
      }
    ]
  }
}
```

### 2. Loading State Message

Indicates when the agent is actively processing.

```typescript
interface LoadingStateMessage {
  id: string;
  type: "loading_state";
  payload: {
    loading: boolean;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440007",
  "type": "loading_state",
  "payload": {
    "loading": true
  }
}
```

**Usage:**
- `loading: true`: Agent is thinking/processing
- `loading: false`: Agent has finished processing

### 3. Approval Request Message

Requests user approval for a command that requires permission.

```typescript
interface ApprovalRequestMessage {
  id: string;
  type: "approval_request";
  payload: {
    command: Array<string>;
    applyPatch?: ApplyPatchCommand;
  };
}
```

**Example - Shell Command:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440008",
  "type": "approval_request",
  "payload": {
    "command": ["rm", "-rf", "node_modules"]
  }
}
```

**Example - File Modification:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440009",
  "type": "approval_request",
  "payload": {
    "command": ["apply_patch", "*** Begin Patch..."],
    "applyPatch": {
      "patch": "*** Begin Patch\n*** Update File: src/app.ts\n@@ -1,3 +1,4 @@\n import express from 'express';\n+import cors from 'cors';\n const app = express();\n*** End Patch"
    }
  }
}
```

### 4. Agent Finished Message

Indicates the agent has completed processing and is ready for new input.

```typescript
interface AgentFinishedMessage {
  id: string;
  type: "agent_finished";
  payload: {
    responseId: string;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440010",
  "type": "agent_finished",
  "payload": {
    "responseId": "resp_def456"
  }
}
```

### 5. Error Message

Reports errors that occur during processing.

```typescript
interface ErrorMessage {
  id: string;
  type: "error";
  payload: {
    message: string;
    details?: any;
  };
}
```

**Examples:**

**Connection Error:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440011",
  "type": "error",
  "payload": {
    "message": "AgentLoop not initialized",
    "details": null
  }
}
```

**API Error:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440012",
  "type": "error",
  "payload": {
    "message": "Failed to process user input",
    "details": {
      "error": "Rate limit exceeded",
      "code": 429
    }
  }
}
```

---

## Message Sequences

### Basic User Query

```
Client → Server: user_input
Server → Client: loading_state (loading: true)
Server → Client: response_item (assistant message)
Server → Client: response_item (function_call)
Server → Client: response_item (function_call_output)
Server → Client: response_item (assistant message)
Server → Client: loading_state (loading: false)
Server → Client: agent_finished
```

### Query Requiring Approval

```
Client → Server: user_input
Server → Client: loading_state (loading: true)
Server → Client: response_item (assistant message)
Server → Client: approval_request
Client → Server: approval_response
Server → Client: response_item (function_call)
Server → Client: response_item (function_call_output)
Server → Client: response_item (assistant message)
Server → Client: loading_state (loading: false)
Server → Client: agent_finished
```

### Error Scenario

```
Client → Server: user_input
Server → Client: loading_state (loading: true)
Server → Client: error
Server → Client: loading_state (loading: false)
```

---

## Implementation Guidelines

### Client Implementation

1. **Message Handling**: Implement handlers for each message type
2. **UI Updates**: Update UI based on loading states and response items
3. **Approval Flow**: Present approval requests to users with clear options
4. **Error Handling**: Display errors gracefully and allow recovery
5. **State Management**: Track conversation state and response IDs

### Connection Management

1. **Reconnection**: Implement automatic reconnection on connection loss
2. **Heartbeat**: Consider implementing ping/pong for connection health
3. **Cleanup**: Properly clean up resources on disconnect

### Message Validation

```typescript
function isValidMessage(data: any): data is WSMessage {
  return (
    typeof data === 'object' &&
    typeof data.id === 'string' &&
    typeof data.type === 'string'
  );
}
```

### Error Handling Best Practices

1. **Graceful Degradation**: Continue operation when possible after errors
2. **User Feedback**: Always inform users of error states
3. **Retry Logic**: Implement appropriate retry mechanisms
4. **Logging**: Log errors for debugging and monitoring

---

## Security Considerations

1. **Input Validation**: Validate all incoming messages
2. **Command Approval**: Always require approval for potentially dangerous commands
3. **Rate Limiting**: Implement rate limiting to prevent abuse
4. **Authentication**: Consider adding authentication for production use
5. **Sanitization**: Sanitize user input before processing

---

## Testing

### Unit Tests

Test individual message handlers:

```typescript
// Example test structure
describe('Message Handlers', () => {
  test('handles user_input message', async () => {
    const message = {
      id: 'test-id',
      type: 'user_input',
      payload: { input: [...], previousResponseId: 'resp_123' }
    };
    
    await handleMessage(message);
    // Assert expected behavior
  });
});
```

### Integration Tests

Test complete message flows:

```typescript
// Example integration test
test('complete approval flow', async () => {
  // Send user input that requires approval
  // Verify approval request is sent
  // Send approval response
  // Verify command execution and completion
});
```

### Load Testing

Test with multiple concurrent connections and high message volumes to ensure stability.

---

This protocol provides a robust foundation for building web-based clients that interact with the AgentLoop system while maintaining security and user control over potentially dangerous operations.