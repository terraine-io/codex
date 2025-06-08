/**
 * Agent Loop module - provides both legacy and multi-provider interfaces
 */

// Export types and interfaces
export type { IAgentLoop, AgentLoopConfig, FullAgentLoopConfig, AgentLoopCallbacks } from "./agent-loop-interface.js";

// Export factory for new multi-provider usage
export { AgentLoopFactory } from "./agent-loop-factory.js";

// Export original AgentLoop for backwards compatibility
export { AgentLoop } from "./agent-loop.js";

// Export Claude implementation
export { ClaudeAgentLoop } from "./claude-agent-loop.js";

// Export related types that consumers might need
export type { ReviewDecision } from "./review.js";
export type { CommandConfirmation } from "./agent-loop.js";

/**
 * Backwards-compatible default export
 * @deprecated Use AgentLoopFactory.create() for new code
 */
export { AgentLoop as default } from "./agent-loop.js";