#!/usr/bin/env node

// Quick test script for the ContextManager
import { ContextManager } from './dist/context-manager.js';

async function testContextManager() {
  console.log('🧪 Testing ContextManager...\n');

  // Mock config
  const config = {
    model: 'gpt-4',
    compactionThreshold: 0.8,
    config: {
      model: 'gpt-4',
      instructions: 'Test instructions',
      apiKey: 'test-key'
    }
  };

  const manager = new ContextManager(config);

  // Test initial state
  console.log('📊 Initial state:');
  console.log('  Token count:', manager.getTokenCount());
  console.log('  Usage percent:', manager.getContextUsagePercent().toFixed(1) + '%');
  console.log('  Transcript length:', manager.getTranscript().length);

  // Add some mock items
  console.log('\n📝 Adding mock conversation items...');
  
  for (let i = 1; i <= 10; i++) {
    const mockItem = {
      id: `msg-${i}`,
      type: 'message',
      role: i % 2 === 1 ? 'user' : 'assistant',
      content: [{
        type: 'input_text',
        text: `This is test message ${i}. `.repeat(100) // Make it longer to increase token count
      }]
    };
    
    manager.addItem(mockItem);
  }

  // Check updated state
  console.log('\n📊 After adding items:');
  const contextInfo = manager.getContextInfo();
  console.log('  Token count:', contextInfo.tokenCount);
  console.log('  Usage percent:', contextInfo.usagePercent.toFixed(1) + '%');
  console.log('  Transcript length:', contextInfo.transcriptLength);
  console.log('  Max tokens:', contextInfo.maxTokens);

  // Test compacted seed input generation
  console.log('\n🌱 Testing seed input generation:');
  const seedInput = manager.getCompactedSeedInput();
  console.log('  Seed input items:', seedInput.length);
  console.log('  First item type:', seedInput[0]?.type);

  // Test clear functionality
  console.log('\n🧹 Testing clear functionality:');
  manager.clear();
  console.log('  Token count after clear:', manager.getTokenCount());
  console.log('  Transcript length after clear:', manager.getTranscript().length);

  console.log('\n✅ ContextManager tests completed!');
}

// Run the test if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testContextManager().catch(console.error);
}

export { testContextManager };