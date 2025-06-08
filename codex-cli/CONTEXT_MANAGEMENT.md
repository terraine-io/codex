# Context Window Management

This WebSocket server implementation includes flexible context window management strategies to handle long-running conversations that might exceed the model's token limits.

## Strategy Pattern Architecture

The system uses an abstract `ContextManager` base class with pluggable strategies:

- **`ThresholdContextManager`**: Auto-compacts when usage exceeds a configurable threshold
- **`DummyContextManager`**: Never auto-compacts, provides manual control only
- **Extensible**: Easy to add new strategies (sliding window, importance-based, etc.)

## How It Works

The context manager mirrors the AgentLoop's conversation transcript and monitors token usage in real-time. When the context approaches the model's limit, it automatically:

1. **Generates a summary** of the conversation using OpenAI's API
2. **Terminates the current AgentLoop** to clear its internal state  
3. **Creates a new AgentLoop** with fresh state
4. **Seeds the new AgentLoop** with the compacted summary

This provides a clean restart while preserving conversation context in a compressed form.

## Features

### Automatic Compaction
- Monitors token usage continuously via AgentLoop callbacks
- Triggers compaction when usage exceeds configured threshold (default: 80%)
- Uses existing `generateCompactSummary()` utility from the Codex CLI
- Provides detailed logging and client notifications

### Manual Control
- `/context` command: View current context usage statistics
- `/compact` command: Manually trigger context compaction
- Real-time usage percentage and token counts

### Configuration
Set these environment variables in your `.env` file:

```bash
# Context management strategy (default: threshold)
CONTEXT_STRATEGY=threshold  # or 'dummy'

# Context compaction threshold (0.0 to 1.0, default: 0.8)
# Only used with threshold strategy
CONTEXT_COMPACTION_THRESHOLD=0.8

# Model and instructions (affects context limits)
MODEL=gpt-4
INSTRUCTIONS=Your custom instructions here
```

### Strategy Selection

#### Threshold Strategy (`CONTEXT_STRATEGY=threshold`)
- **Automatic compaction**: Triggers when usage exceeds threshold (default: 80%)
- **Production-ready**: Handles long conversations seamlessly
- **Configurable**: Adjust threshold based on use case
- **Use case**: Production deployments, long-running sessions

#### Dummy Strategy (`CONTEXT_STRATEGY=dummy`)
- **No auto-compaction**: Manual control only
- **Warning system**: Alerts at 90%+ usage
- **Testing-friendly**: Predictable behavior for debugging
- **Use case**: Development, testing, scenarios requiring manual control

## WebSocket Protocol Extensions

### Client → Server Messages

#### Get Context Info
```json
{
  "id": "unique-id",
  "type": "get_context_info"
}
```

#### Manual Compact
```json
{
  "id": "unique-id", 
  "type": "manual_compact"
}
```

### Server → Client Messages

#### Context Info Response
```json
{
  "id": "unique-id",
  "type": "context_info",
  "payload": {
    "tokenCount": 45231,
    "usagePercent": 35.4,
    "transcriptLength": 87,
    "maxTokens": 128000
  }
}
```

#### Context Compacted Notification
```json
{
  "id": "unique-id",
  "type": "context_compacted", 
  "payload": {
    "oldTokenCount": 98234,
    "newTokenCount": 12456,
    "reductionPercent": 87.3
  }
}
```

## Architecture

### ContextManager Architecture
- **Abstract base class**: Provides common functionality (transcript tracking, token counting)
- **Strategy pattern**: Pluggable compaction behaviors via concrete implementations
- **Factory function**: `createContextManager(strategy, config)` for easy instantiation
- **Mirrors transcript**: Tracks all ResponseItems via AgentLoop callbacks
- **Token estimation**: Uses same approximation as AgentLoop (~4 chars/token)
- **Event-driven**: Triggers compaction via callback when conditions are met

### WebSocketAgentServer Integration  
- **Callback integration**: Connects ContextManager to AgentLoop via `onItem`
- **AgentLoop recreation**: Handles termination and recreation with seed data
- **Client communication**: Sends context info and compaction notifications

### Key Design Decisions

1. **Strategy pattern**: Easy to add new compaction behaviors without changing core logic
2. **External management**: Context tracking is separate from AgentLoop internals
3. **AgentLoop recreation**: Clean solution that works with existing codebase
4. **Callback-based**: Leverages existing AgentLoop callback system
5. **Configurable**: Both strategy selection and parameters via environment variables

## Usage Example

```javascript
// Client sends a long conversation...
// Context usage reaches 85%
// ContextManager automatically triggers compaction
// → Server creates summary: "Working on React app, fixed 3 bugs..."
// → AgentLoop terminated and recreated with summary as context
// → Client receives compaction notification
// → Conversation continues with clean context
```

## Benefits

- **Unlimited conversations**: Never hit context window limits
- **Preserves context**: Important information retained via AI summarization  
- **Transparent operation**: Automatic with minimal user disruption
- **Configurable**: Tune compaction thresholds for different use cases
- **Monitoring**: Real-time visibility into context usage

## Limitations

- **Summary quality**: Dependent on model's summarization capabilities
- **Loss of detail**: Some conversation nuance may be lost in summarization
- **API costs**: Summarization requires additional OpenAI API calls
- **Latency**: Brief pause during AgentLoop recreation and seeding

## Future Enhancements

- **Sliding window**: Keep recent turns in full detail, summarize older ones
- **Smart summaries**: Context-aware summarization (code vs. chat vs. debugging)
- **Compression options**: Different strategies (truncation, summarization, importance-based)
- **Persistence**: Save/restore context across server restarts