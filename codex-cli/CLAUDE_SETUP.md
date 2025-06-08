# Claude/Anthropic Setup

To use Claude models with the WebSocket server, you'll need to install the Anthropic SDK:

```bash
npm install @anthropic-ai/sdk
```

## Environment Configuration

Add your Anthropic API key to your `.env` file:

```bash
ANTHROPIC_API_KEY=your-anthropic-api-key-here
```

## Usage Examples

### Use Claude via Environment Variables

```bash
# Set provider and model
PROVIDER=anthropic
MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_API_KEY=your-key-here

# Start server
node dist/ws-server.js
```

### Auto-Detection from Model Name

```bash
# Provider will be auto-detected as 'anthropic'
MODEL=claude-3-5-sonnet-20241022
ANTHROPIC_API_KEY=your-key-here

# Start server  
node dist/ws-server.js
```

## Supported Claude Models

- `claude-3-5-sonnet-20241022` (recommended)
- `claude-3-5-haiku-20241022`
- `claude-3-opus-20240229`
- `claude-3-sonnet-20240229`
- `claude-3-haiku-20240307`

## Features

- ✅ Native Claude tool calling
- ✅ Streaming responses
- ✅ Shell command execution with approval
- ✅ File operations via apply_patch
- ✅ Context management
- ✅ Full transparency (no hidden reasoning)

## Benefits over OpenAI Models

- **Transparent reasoning**: Claude shows its thinking process
- **Better code understanding**: Strong performance on code tasks
- **Longer context**: Up to 200K tokens
- **Tool use**: Native support for function calling