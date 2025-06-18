## Feature Request

The current implementation of `ws-server` exposes internal tools, e.g. `shell` and TODO management tools.
I want to extend it, so that the LLM can interact with tools provided by MCP servers. 

## Overview

Here's the high-level plan for implementation:

1. Read MCP server configs and instantiate (see `src/utils/agent/mcp-wrapper.ts`)
2. Fetch tools exposed by MCP server; forget about resources, prompts, completions, and other MCP concepts for now
3. Pass these tools into `ClaudeAgentLoop` (`src/utils/agent/claude-agent-loop.ts:371`)
    - So that the LLM has instructions for how to use these tools
    - Similar to how built-in tools for TODO management, and `apply_patch` are exposed to the LLM
4. Intercept tool calls meant for MCP wrapper (see `handleToolUseSync` function, `src/utils/agent/claude-agent-loop.ts:543`)
5. Call `emitResponseItem` with appropriately type-converted response to feed tool call response back into agent loop
    - Pay special attention to the differences in request/result formats between our code, and those used by the client SDK from the `modelcontextprotocol` package
    - For example, in `handleToolUseSync`, think about how to between the `ClaudeToolUseContent`/`ClaudeToolResultContent` types used by our code, and the request/response types used by the SDK (see Appendix section of this doc)

## Task
I've already started work on this feature. See `git diff` for the in-flight changes.
These changes will show you the relevant files that will be updated to implement
this feature. Use this `diff` to formulate a detailed implementation plan.
Don't implement these changes yet -- let me review your plan first.

Note that the changes I've made are just suggestive. If you can think of better design
alternatives, suggest them, along with reasons for why they are better.

## Appendix

### Relevant Types used in MCP client SDK

@mcp_client_sdk_types.ts


### Code snippets from client SDK

@mcp_client_sdk_code_snippets.ts