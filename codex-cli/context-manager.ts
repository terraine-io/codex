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
}

export class ContextManager {
  private transcript: Array<ResponseItem> = [];
  private userInputHistory: Array<ResponseInputItem> = [];
  private readonly maxTokens: number;
  private readonly compactionThreshold: number;
  
  // Callback for when compaction is needed
  public onCompactionNeeded?: (transcript: Array<ResponseItem>) => Promise<void>;
  
  constructor(private config: ContextManagerConfig) {
    this.maxTokens = config.maxTokens || maxTokensForModel(config.model);
    this.compactionThreshold = config.compactionThreshold || 0.8;
    
    console.log(`ContextManager initialized: model=${config.model}, maxTokens=${this.maxTokens}, threshold=${this.compactionThreshold}`);
  }

  /**
   * Called from AgentLoop's onItem callback to track all response items
   */
  addItem(item: ResponseItem): void {
    this.transcript.push(item);
    
    // Check if we need to compact after adding the item
    if (this.shouldCompact()) {
      console.log(`Context compaction needed: ${this.getTokenCount()}/${this.maxTokens} tokens (${this.getContextUsagePercent().toFixed(1)}%)`);
      this.onCompactionNeeded?.(this.transcript);
    }
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
      maxTokens: this.maxTokens
    };
  }

  /**
   * Check if compaction should be triggered
   */
  private shouldCompact(): boolean {
    const usagePercent = this.getContextUsagePercent();
    return usagePercent > (this.compactionThreshold * 100);
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
          text: `📄 **Context Summary**\n\n${summaryText}`
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
    console.log('Clearing context manager state');
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