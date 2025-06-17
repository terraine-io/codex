import type { ResponseInputItem } from "openai/resources/responses/responses.mjs";
import type { ApprovalPolicy } from "../../approvals.js";
import type { AppConfig } from "../config.js";
import { type ClaudeTool } from './claude-types.js';


/**
 * Configuration for creating agent loop instances across different providers
 */
export interface AgentLoopConfig {
  /** Model identifier (provider-specific) */
  model: string;
  
  /** Provider name (openai, anthropic, google) */
  provider: 'openai' | 'anthropic' | 'google';
  
  /** Optional instructions for the agent */
  instructions?: string;
  
  /** How to handle command approval requests */
  approvalPolicy: ApprovalPolicy;
  
  /** Whether to store conversation state server-side */
  disableResponseStorage?: boolean;
  
  /** Additional configuration (API keys, etc.) */
  config?: AppConfig;
  
  /** Additional writable directories for tools */
  additionalWritableRoots?: ReadonlyArray<string>;
}

/**
 * Callback functions for handling agent events
 */
export interface AgentLoopCallbacks {
  /** Called when agent produces output items */
  onItem: (item: any) => void;
  
  /** Called when loading state changes */
  onLoading: (loading: boolean) => void;
  
  /** Called when agent needs command confirmation */
  getCommandConfirmation: (
    command: Array<string>,
    applyPatch?: any
  ) => Promise<any>;
  
  /** Called when response ID changes */
  onLastResponseId: (lastResponseId: string) => void;
}

export interface AgentMcpTools {
  mcpTools: Array<ClaudeTool>;
}

/**
 * Common interface for all agent loop implementations
 */
export interface IAgentLoop {
  /** Session identifier */
  readonly sessionId: string;
  
  /**
   * Execute agent conversation turn
   */
  run(
    input: Array<ResponseInputItem>,
    previousResponseId?: string
  ): Promise<void>;
  
  /**
   * Cancel current operation
   */
  cancel(): void;
  
  /**
   * Terminate agent (makes instance unusable)
   */
  terminate(): void;

  /**
   * Initialize agent with historical transcript (for session resumption)
   * This populates the internal conversation state without making API calls
   */
  initializeTranscript?(transcript: Array<ResponseInputItem>): void;
}

/**
 * Extended configuration that includes callbacks
 */
export interface FullAgentLoopConfig extends AgentLoopConfig, AgentLoopCallbacks, AgentMcpTools {}