# Logging Configuration

The WebSocket server supports configurable logging levels to control verbosity.

## Environment Variables

### LOG_LEVEL (Recommended)
Set the desired log level explicitly:

```bash
LOG_LEVEL=debug node dist/ws-server.js
LOG_LEVEL=trace node dist/ws-server.js  # Most verbose
```

### DEBUG (Backward Compatibility)
The legacy `DEBUG` environment variable is still supported:

```bash
DEBUG=true node dist/ws-server.js  # Equivalent to LOG_LEVEL=info
```

## Log Levels

### NONE (default)
- **Usage**: No logging environment variable set
- **Output**: No log files created, minimal console output

### ERROR
- **Usage**: `LOG_LEVEL=error`
- **Output**: Only critical errors

### WARN
- **Usage**: `LOG_LEVEL=warn` 
- **Output**: Warnings and errors

### INFO
- **Usage**: `LOG_LEVEL=info` or `DEBUG=true`
- **Output**: General information, warnings, and errors
- **Includes**: AgentLoop initialization, context management events

### DEBUG
- **Usage**: `LOG_LEVEL=debug`
- **Output**: Detailed debugging information
- **Includes**: API key sources, agent creation details, tool execution

### TRACE (Most Verbose)
- **Usage**: `LOG_LEVEL=trace`
- **Output**: All possible logging including detailed API interactions
- **Includes**: Full Claude API requests/responses, complete conversation state, message content

⚠️ **Warning**: TRACE level generates extensive output including full API payloads. Use only for detailed debugging.

## Examples

### Normal Usage (Silent)
```bash
node dist/ws-server.js
```

### Basic Debugging
```bash
LOG_LEVEL=debug node dist/ws-server.js
```

### Full API Debugging (Claude Integration)
```bash
LOG_LEVEL=trace node dist/ws-server.js
```

### Legacy Compatibility
```bash
DEBUG=true node dist/ws-server.js
```

## Log File Location

When logging is enabled, log files are created at:
- **macOS/Windows**: `$TMPDIR/oai-codex/codex-cli-TIMESTAMP.log`
- **Linux**: `~/.local/oai-codex/codex-cli-TIMESTAMP.log`

A symlink `codex-cli-latest.log` always points to the most recent log file.

### Viewing Logs
```bash
# macOS/Windows
tail -F "$TMPDIR/oai-codex/codex-cli-latest.log"

# Linux  
tail -F ~/.local/oai-codex/codex-cli-latest.log
```