# Codex CLI - Codebase Understanding

## Overview
Codex CLI is an AI-powered command-line interface that provides LLMs with structured access to execute commands, modify files, and interact with development environments. The system supports multiple LLM providers (OpenAI, Claude, Google) through a unified interface.

**Note**: This codebase was forked from OpenAI's Codex repository and contains extensive TUI (Terminal User Interface) components. However, the primary focus of current development is on the **WebSocket server implementation** (`ws-server.ts`) and its associated backend components (agent loops, tools, approval systems, etc.). The TUI portions are not actively maintained or of primary interest.

## Core Architecture

### AgentLoop System (`src/utils/agent/`)
- **Multi-Provider Support**: Separate implementations for different LLM providers
  - `agent-loop.ts` - OpenAI implementation 
  - `claude-agent-loop.ts` - Claude/Anthropic implementation
  - `agent-loop-factory.ts` - Auto-detection and provider routing
- **Unified Interface**: `IAgentLoop` ensures consistent behavior across providers
- **Tool Integration**: LLMs access functionality through structured tool calls

### Command Execution Pipeline
1. **Command Detection** (`handle-exec-command.ts:deriveCommandKey()`)
   - Identifies command types (apply_patch, read_chunk, regular shell)
2. **Safety Assessment** (`approvals.ts:canAutoApprove()`)
   - Evaluates commands against approval policies
3. **Execution Routing** (`handle-exec-command.ts:execCommand()`)
   - Routes to specialized handlers or sandboxed execution
4. **Sandboxing** (`src/utils/agent/sandbox/`)
   - macOS Seatbelt and Linux Landlock security

## Key Components

### File Operations
- **apply_patch** (`apply-patch.ts`): Custom diff format for file modifications
  - Context-based matching (no line numbers)
  - Unicode normalization for robustness
  - Supports add, update, delete, move operations
- **read_chunk** (`exec.ts:execReadChunk()`): Efficient file chunk reading
  - Line-numbered output with EOF detection
  - Path traversal protection

### Approval System (`approvals.ts`)
- **Policies**: `suggest` (conservative) → `auto-edit` (balanced) → `full-auto` (permissive)
- **Safety Assessments**: Structured evaluation of command safety
- **Auto-Approval Logic**: Different rules for different command types
- **Path Validation**: Prevents directory traversal attacks

### Session Management
- **WebSocket Server** (`ws-server.ts`): Web-based access to AgentLoop
- **Session Persistence**: JSONL event logging with resumption capability
- **Context Management**: Automatic compaction and memory management
- **Todos Integration**: Per-session task tracking files

## Adding New Shell Commands

Pattern established by `apply_patch` and `read_chunk`:

1. **Command Detection**: Add to `deriveCommandKey()` in `handle-exec-command.ts`
2. **Execution Function**: Implement in `exec.ts` with defensive error handling
3. **Approval Logic**: Add type and validation in `approvals.ts`
4. **Routing**: Update `execCommand()` to handle the new command type
5. **Tool Instructions**: Export instructions for LLM consumption
6. **Provider Integration**: Add instructions to both agent loops

## Important Patterns

### Tool Instructions
- **OpenAI**: Added to model-specific instructions (gpt-4.1 models)
- **Claude**: Always included in system instructions
- **Format**: Detailed documentation with examples, error handling, security notes

### Error Handling
- **Defensive Programming**: All exec functions return structured results, never throw
- **Exit Codes**: 0 for success, non-zero for errors with descriptive stderr
- **Logging**: Comprehensive logging with configurable levels

### Security
- **Path Resolution**: `resolvePathAgainstWorkdir()` prevents traversal
- **Sandboxing**: Platform-specific containment for untrusted commands
- **Read-Only Operations**: Auto-approved regardless of policy
- **Write Operations**: Subject to approval policies and path restrictions

## Configuration
- **Environment Variables**: API keys, approval modes, working directories
- **CLAUDE.md**: Project-specific instructions (this file)
- **Approval Policies**: Configurable via `TOOL_USE_APPROVAL_MODE`

## Multi-Provider Architecture
- **Provider Detection**: Auto-detect from model name or explicit configuration
- **Unified Tool Interface**: Same command structure across providers
- **Provider-Specific Features**: Handle differences in tool calling formats
- **Consistent Execution**: Same approval and execution logic regardless of provider

## WebSocket Interface (Primary Focus)
- **Real-time Communication**: Streaming responses and approval requests
- **Session Resumption**: Load conversation history from JSONL logs
- **REST API**: Session management endpoints for external integration
- **Message Protocol**: Structured JSON messages for all interactions
- **Entry Point**: `ws-server.ts` - Main WebSocket server implementation
- **Client Integration**: Web-based access to AgentLoop functionality

## Development Focus Areas
When working on this codebase, prioritize:

### **Primary Components** (Active Development)
- `ws-server.ts` - WebSocket server and message handling
- `src/utils/agent/` - Agent loop implementations and tools
- `src/approvals.ts` - Command approval and security
- Session management and persistence
- Tool implementations (apply_patch, read_chunk, etc.)

### **Secondary Components** (Legacy/Maintenance)
- `src/app.tsx` and `src/components/` - TUI interface (not primary focus)
- CLI-specific components and terminal rendering
- Interactive terminal features and overlays

Focus development efforts on WebSocket server capabilities, agent loop improvements, and tool enhancements rather than TUI functionality.

This codebase follows clean architecture principles with clear separation of concerns, comprehensive error handling, and strong security practices.

---

# Style guidelines
- Avoid trailing whitespace, especially in blank lines
