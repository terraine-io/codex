import type { IAgentLoop, FullAgentLoopConfig } from "./agent-loop-interface.js";

import { AgentLoop } from "./agent-loop.js";
import { ClaudeAgentLoop } from "./claude-agent-loop.js";

/**
 * Factory for creating agent loop instances based on provider
 */
export class AgentLoopFactory {
  /**
   * Create an agent loop instance for the specified provider
   */
  static create(config: FullAgentLoopConfig): IAgentLoop {
    switch (config.provider) {
      case 'openai':
        return AgentLoopFactory.createOpenAI(config);
        
      case 'anthropic':
        return AgentLoopFactory.createClaude(config);
        
      case 'google':
        throw new Error('Gemini/Google provider not yet implemented');
        
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }
  
  /**
   * Create Claude/Anthropic-based agent loop
   */
  private static createClaude(config: FullAgentLoopConfig): IAgentLoop {
    // Ensure API key is available in config for Claude
    const claudeConfig = {
      ...config.config,
      apiKey: config.config?.apiKey || process.env.ANTHROPIC_API_KEY
    };
    
    return new ClaudeAgentLoop({
      model: config.model,
      instructions: config.instructions,
      approvalPolicy: config.approvalPolicy,
      disableResponseStorage: config.disableResponseStorage,
      config: claudeConfig,
      additionalWritableRoots: config.additionalWritableRoots,
      onItem: config.onItem,
      onLoading: config.onLoading,
      getCommandConfirmation: config.getCommandConfirmation,
      onLastResponseId: config.onLastResponseId,
    });
  }
  
  /**
   * Create OpenAI-based agent loop (current implementation)
   */
  private static createOpenAI(config: FullAgentLoopConfig): IAgentLoop {
    // Convert to current AgentLoop constructor format
    const agentLoopParams = {
      model: config.model,
      provider: config.provider,
      instructions: config.instructions,
      approvalPolicy: config.approvalPolicy,
      disableResponseStorage: config.disableResponseStorage,
      onItem: config.onItem,
      onLoading: config.onLoading,
      getCommandConfirmation: config.getCommandConfirmation,
      onLastResponseId: config.onLastResponseId,
      additionalWritableRoots: config.additionalWritableRoots || [],
      config: config.config,
    };
    
    return new AgentLoop(agentLoopParams);
  }
  
  /**
   * Detect provider from model name if not explicitly specified
   */
  static detectProvider(model: string): 'openai' | 'anthropic' | 'google' {
    if (model.startsWith('claude-') || model.includes('anthropic')) {
      return 'anthropic';
    }
    
    if (model.startsWith('gemini-') || model.includes('google')) {
      return 'google';
    }
    
    // Default to OpenAI for known OpenAI models and unknown models
    return 'openai';
  }
  
  /**
   * Convenience method that auto-detects provider from model name
   */
  static createWithAutoDetection(config: Omit<FullAgentLoopConfig, 'provider'>): IAgentLoop {
    const provider = AgentLoopFactory.detectProvider(config.model);
    return AgentLoopFactory.create({ ...config, provider });
  }
}