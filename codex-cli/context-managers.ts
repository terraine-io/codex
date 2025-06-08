import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import type { AppConfig } from './src/utils/config.js';
import { approximateTokensUsed } from './src/utils/approximate-tokens-used.js';
import { generateCompactSummary } from './src/utils/compact-summary.js';
import { maxTokensForModel } from './src/utils/model-utils.js';

export interface ContextManagerConfig {
  maxTokens?: number;
  compactionThreshold?: number; // e.g., 0.8 = compact at 80% full
  model: string;
  config: AppConfig;
}

export interface ContextInfo {
  tokenCount: number;
  usagePercent: number;
  transcriptLength: number;
  maxTokens: number;
  strategy: string;
}

/**
 * Abstract base class for context management strategies.
 * Provides common functionality for tracking transcript and calculating usage,
 * while allowing derived classes to implement different compaction behaviors.
 */
export abstract class ContextManager {
  protected transcript: Array<ResponseItem> = [];
  protected userInputHistory: Array<ResponseInputItem> = [];
  protected readonly maxTokens: number;
  protected readonly config: ContextManagerConfig;
  
  // Callback for when compaction is needed
  public onCompactionNeeded?: (transcript: Array<ResponseItem>) => Promise<void>;
  
  constructor(config: ContextManagerConfig) {
    this.config = config;
    this.maxTokens = config.maxTokens || maxTokensForModel(config.model);
    
    console.log(`${this.getStrategyName()} initialized: model=${config.model}, maxTokens=${this.maxTokens}`);
  }

  /**
   * Return the name of this strategy for logging and debugging
   */
  abstract getStrategyName(): string;

  /**
   * Determine if compaction should be triggered.
   * Different strategies can implement different logic here.
   */
  protected abstract shouldCompact(): boolean;

  /**
   * Called from AgentLoop's onItem callback to track all response items
   */
  addItem(item: ResponseItem): void {
    this.transcript.push(item);
    
    // Check if we need to compact after adding the item
    if (this.shouldCompact()) {
      this.onCompactionTriggered();
    }
  }

  /**
   * Called when compaction is triggered. Can be overridden by strategies
   * that want to customize the trigger behavior.
   */
  protected onCompactionTriggered(): void {
    console.log(`Context compaction triggered: ${this.getTokenCount()}/${this.maxTokens} tokens (${this.getContextUsagePercent().toFixed(1)}%)`);
    this.onCompactionNeeded?.(this.transcript);
  }

  /**
   * Called when user sends new input (before AgentLoop.run())
   * Helps track the flow of user inputs for debugging
   */
  addUserInput(input: Array<ResponseInputItem>): void {
    this.userInputHistory.push(...input);
  }

  /**
   * Get a copy of the current transcript
   */
  getTranscript(): Array<ResponseItem> {
    return [...this.transcript];
  }

  /**
   * Get current token count using the same approximation as AgentLoop
   */
  getTokenCount(): number {
    return approximateTokensUsed(this.transcript);
  }

  /**
   * Get context usage as percentage (0-100)
   */
  getContextUsagePercent(): number {
    return (this.getTokenCount() / this.maxTokens) * 100;
  }

  /**
   * Get comprehensive context information
   */
  getContextInfo(): ContextInfo {
    return {
      tokenCount: this.getTokenCount(),
      usagePercent: this.getContextUsagePercent(),
      transcriptLength: this.transcript.length,
      maxTokens: this.maxTokens,
      strategy: this.getStrategyName()
    };
  }

  /**
   * Generate a compacted summary of the current transcript
   * Returns the summary as a ResponseItem that can seed a new AgentLoop
   */
  async compact(): Promise<ResponseItem> {
    if (this.transcript.length === 0) {
      throw new Error('Cannot compact empty transcript');
    }

    try {
      console.log(`Compacting transcript: ${this.transcript.length} items, ${this.getTokenCount()} tokens`);
      
      // Generate summary using existing utility from codex
      const summaryText = await generateCompactSummary(
        this.transcript,
        this.config.model,
        false, // flexMode - set to false for now
        this.config.config
      );

      // Create a response item containing the summary
      const summaryItem: ResponseItem = {
        id: `context-summary-${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [{ 
          type: "output_text", 
          text: `📄 **Context Summary (${this.getStrategyName()})**\n\n${summaryText}`
        }]
      };

      // Replace our transcript with just the summary
      const oldTokenCount = this.getTokenCount();
      this.transcript = [summaryItem];
      this.userInputHistory = []; // Clear user input history as well
      
      const newTokenCount = this.getTokenCount();
      console.log(`Context compacted: ${oldTokenCount} → ${newTokenCount} tokens (${((1 - newTokenCount/oldTokenCount) * 100).toFixed(1)}% reduction)`);
      
      return summaryItem;
      
    } catch (error) {
      console.error('Failed to compact context:', error);
      throw new Error(`Context compaction failed: ${error.message}`);
    }
  }

  /**
   * Clear all transcript and history
   */
  clear(): void {
    console.log(`Clearing ${this.getStrategyName()} state`);
    this.transcript = [];
    this.userInputHistory = [];
  }

  /**
   * Set a new transcript (used after AgentLoop recreation)
   */
  setTranscript(transcript: Array<ResponseItem>): void {
    this.transcript = [...transcript];
  }

  /**
   * Get the compacted transcript ready for seeding a new AgentLoop
   * Returns it in the format expected by AgentLoop.run()
   */
  getCompactedSeedInput(): Array<ResponseInputItem> {
    if (this.transcript.length === 0) {
      return [];
    }

    // Convert our ResponseItems back to ResponseInputItems
    // This is what AgentLoop expects in its run() method
    return this.transcript.map(item => {
      if (item.type === "message") {
        return {
          type: "message",
          role: item.role,
          content: item.content
        } as ResponseInputItem;
      } else if (item.type === "function_call_output") {
        return {
          type: "function_call_output",
          call_id: item.call_id,
          output: item.output
        } as ResponseInputItem;
      }
      // For other types, we'll just pass them through
      // This might need adjustment based on actual usage
      return item as unknown as ResponseInputItem;
    });
  }
}

/**
 * Threshold-based context manager that triggers compaction when token usage
 * exceeds a configurable percentage of the model's context window.
 */
export class ThresholdContextManager extends ContextManager {
  private readonly compactionThreshold: number;

  constructor(config: ContextManagerConfig) {
    super(config);
    this.compactionThreshold = config.compactionThreshold || 0.8;
    console.log(`Compaction threshold: ${this.compactionThreshold * 100}%`);
  }

  getStrategyName(): string {
    return "ThresholdContextManager";
  }

  protected shouldCompact(): boolean {
    const usagePercent = this.getContextUsagePercent();
    return usagePercent > (this.compactionThreshold * 100);
  }

  /**
   * Get the current compaction threshold
   */
  getCompactionThreshold(): number {
    return this.compactionThreshold;
  }
}

/**
 * Dummy context manager that never triggers automatic compaction.
 * Useful for testing, debugging, or scenarios where manual control is preferred.
 * Manual compaction via compact() method is still available.
 */
export class DummyContextManager extends ContextManager {
  private warnOnce: boolean = false;

  getStrategyName(): string {
    return "DummyContextManager";
  }

  protected shouldCompact(): boolean {
    // Never trigger automatic compaction
    return false;
  }

  protected onCompactionTriggered(): void {
    // This should never be called since shouldCompact() always returns false,
    // but include for completeness
    console.log(`DummyContextManager: compaction triggered but ignored`);
  }

  addItem(item: ResponseItem): void {
    super.addItem(item);
    
    // Warn once when approaching limits without compaction
    const usagePercent = this.getContextUsagePercent();
    if (usagePercent > 90 && !this.warnOnce) {
      console.warn(`⚠️  DummyContextManager: Context usage at ${usagePercent.toFixed(1)}% - no automatic compaction will occur`);
      this.warnOnce = true;
    }
  }

  /**
   * Reset the warning flag (useful for testing)
   */
  resetWarning(): void {
    this.warnOnce = false;
  }
}

/**
 * Factory function to create context managers based on strategy name
 */
export function createContextManager(strategy: string, config: ContextManagerConfig): ContextManager {
  switch (strategy.toLowerCase()) {
    case 'threshold':
      return new ThresholdContextManager(config);
    case 'dummy':
    case 'none':
      return new DummyContextManager(config);
    default:
      console.warn(`Unknown context management strategy: ${strategy}, defaulting to threshold`);
      return new ThresholdContextManager(config);
  }
}

// Export types and default strategy for backward compatibility
export type { ContextManagerConfig, ContextInfo };
// Note: ContextManager is the abstract base class exported above
// For backward compatibility, ThresholdContextManager is the recommended default