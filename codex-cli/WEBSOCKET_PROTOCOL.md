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
    review: "yes" | "no-exit" | "no-continue" | "always" | "explain";
    applyPatch?: ApplyPatchCommand;
    customDenyMessage?: string;
    explanation?: string;
  };
}
```

### 3. Get Context Info Message

Requests current context window usage information.

```typescript
interface GetContextInfoMessage {
  id: string;
  type: "get_context_info";
  payload?: {};
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "type": "get_context_info"
}
```

### 4. Manual Compact Message

Requests manual context compaction.

```typescript
interface ManualCompactMessage {
  id: string;
  type: "manual_compact";
  payload?: {};
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "type": "manual_compact"
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

#### Local Shell Command
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440005",
  "type": "response_item",
  "payload": {
    "id": "shell_abc123",
    "type": "local_shell_call",
    "action": {
      "command": ["git", "status"]
    },
    "status": "completed"
  }
}
```

#### Local Shell Command Output
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440006",
  "type": "response_item",
  "payload": {
    "id": "shell_output_abc123",
    "type": "local_shell_call_output",
    "output": "{\"output\": \"On branch main\\nnothing to commit, working tree clean\", \"metadata\": {\"exit_code\": 0, \"duration_seconds\": 0.1}}"
  }
}
```

#### Reasoning (for models that support it)
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440007",
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
  "id": "550e8400-e29b-41d4-a716-446655440008",
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

### 5. Context Info Message

Reports current context window usage information.

```typescript
interface ContextInfoMessage {
  id: string;
  type: "context_info";
  payload: {
    tokenCount: number;
    usagePercent: number;
    transcriptLength: number;
    maxTokens: number;
    strategy: string;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440011",
  "type": "context_info",
  "payload": {
    "tokenCount": 45231,
    "usagePercent": 35.4,
    "transcriptLength": 87,
    "maxTokens": 128000,
    "strategy": "ThresholdContextManager"
  }
}
```

### 6. Context Compacted Message

Reports that context has been automatically or manually compacted.

```typescript
interface ContextCompactedMessage {
  id: string;
  type: "context_compacted";
  payload: {
    oldTokenCount: number;
    newTokenCount: number;
    reductionPercent: number;
    strategy: string;
  };
}
```

**Example:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440012",
  "type": "context_compacted",
  "payload": {
    "oldTokenCount": 98234,
    "newTokenCount": 12456,
    "reductionPercent": 87.3,
    "strategy": "ThresholdContextManager"
  }
}
```

### 7. Error Message

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
6. **Streaming Messages**: Handle streaming assistant messages by tracking message IDs and assembling chunks
7. **Approval Suppression**: Suppress display of `local_shell_call` and `local_shell_call_output` items during pending approval states

#### Message Streaming Implementation

For streaming assistant messages, maintain state to properly assemble message chunks:

```javascript
class MessageStateManager {
  constructor() {
    this.activeMessages = new Map(); // Track by message ID
  }
  
  handleStreamingMessage(item) {
    const messageId = item.id;
    const role = item.role;
    
    // Extract text content from this chunk
    let chunkText = '';
    if (Array.isArray(item.content)) {
      chunkText = item.content.map(content => content.text || content).join('');
    } else if (item.content) {
      chunkText = item.content;
    }
    
    if (role === 'assistant') {
      if (!this.activeMessages.has(messageId)) {
        // First chunk - show prefix only if we have content
        this.activeMessages.set(messageId, { 
          text: chunkText, 
          role: 'assistant',
          hasShownPrefix: false
        });
        
        if (chunkText.trim()) {
          this.showAssistantPrefix();
          this.activeMessages.get(messageId).hasShownPrefix = true;
          this.appendText(chunkText);
        }
      } else {
        // Subsequent chunk
        const existing = this.activeMessages.get(messageId);
        
        if (!existing.hasShownPrefix && chunkText.trim()) {
          this.showAssistantPrefix();
          existing.hasShownPrefix = true;
        }
        
        if (chunkText) {
          this.appendText(chunkText);
          existing.text += chunkText;
        }
      }
    }
  }
  
  finalizeActiveMessages() {
    // Add newline after completed assistant messages
    for (const [messageId, message] of this.activeMessages) {
      if (message.role === 'assistant' && message.hasShownPrefix && message.text.trim()) {
        this.addNewline();
      }
    }
    this.activeMessages.clear();
  }
}
```

#### Approval State Management

Handle approval requests by suppressing shell command display:

```javascript
handleResponseItem(item) {
  // Suppress shell commands during pending approval
  if (this.pendingApproval && 
      (item.type === 'local_shell_call' || item.type === 'local_shell_call_output')) {
    this.suppressedItems.push(item);
    return; // Don't display until approval is resolved
  }
  
  // Normal processing...
}

processSuppressedItems() {
  // Display suppressed items after approval
  const items = this.suppressedItems;
  this.suppressedItems = [];
  
  items.forEach(item => {
    this.handleResponseItem(item);
  });
}
```

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

## Provider Support

The WebSocket server supports multiple AI providers:

- **OpenAI**: GPT-4, GPT-3.5-turbo, and other OpenAI models
- **Anthropic**: Claude 3.5 Sonnet, Claude 3 Opus, and other Claude models  
- **Google**: Gemini 1.5 Pro, Gemini 1.5 Flash, and other Gemini models

Provider selection is automatic based on model name, or can be explicitly set via the `PROVIDER` environment variable. Each provider requires its corresponding API key to be configured.

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