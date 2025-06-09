#!/usr/bin/env node

// Example WebSocket client to demonstrate interaction with the AgentLoop server
// Run with: node ws-client-example.js

import WebSocket from 'ws';
import readline from 'readline';
import { randomUUID } from 'crypto';

class AgentLoopClient {
  constructor(url = 'ws://localhost:8080') {
    this.ws = new WebSocket(url);
    this.setupWebSocket();
    this.setupCLI();
    this.pendingApproval = null;
    this.suppressedItems = []; // Queue for items suppressed during approval
    this.activeMessages = new Map(); // Track streaming messages by ID
  }

  setupWebSocket() {
    this.ws.on('open', () => {
      console.log('Connected to AgentLoop server');
      console.log('Type your message and press Enter to send to the agent.');
      console.log('Commands:');
      console.log('  /context - Show context window usage');
      console.log('  /compact - Manually compact context');
      console.log('  exit     - Quit the client\n');
      this.showPrompt();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error('Error parsing message:', error);
      }
    });

    this.ws.on('close', () => {
      console.log('\nConnection closed');
      process.exit(0);
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      process.exit(1);
    });
  }

  setupCLI() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.rl.on('line', (input) => {
      this.handleUserInput(input.trim());
    });
  }

  handleContextInfo(payload) {
    process.stdout.write('\r\x1b[K');
    console.log('\n📊 Context Information:');
    console.log(`   Strategy: ${payload.strategy || 'Unknown'}`);
    console.log(`   Token Count: ${payload.tokenCount.toLocaleString()} / ${payload.maxTokens.toLocaleString()}`);
    console.log(`   Usage: ${payload.usagePercent.toFixed(1)}%`);
    console.log(`   Transcript Length: ${payload.transcriptLength} items`);
    
    // Show visual progress bar
    const barLength = 40;
    const filledLength = Math.round((payload.usagePercent / 100) * barLength);
    const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);
    
    let color = '';
    if (payload.usagePercent > 80) color = '\x1b[31m'; // Red
    else if (payload.usagePercent > 60) color = '\x1b[33m'; // Yellow
    else color = '\x1b[32m'; // Green
    
    console.log(`   ${color}[${bar}]\x1b[0m ${payload.usagePercent.toFixed(1)}%`);
    
    if (payload.usagePercent > 80) {
      console.log('   ⚠️  High context usage - consider using /compact');
    }
    
    this.showPrompt();
  }

  handleContextCompacted(payload) {
    process.stdout.write('\r\x1b[K');
    console.log('\n🗜️ Context Compacted Successfully!');
    console.log(`   Strategy: ${payload.strategy || 'Unknown'}`);
    console.log(`   Before: ${payload.oldTokenCount.toLocaleString()} tokens`);
    console.log(`   After: ${payload.newTokenCount.toLocaleString()} tokens`);
    console.log(`   Reduction: ${payload.reductionPercent.toFixed(1)}%`);
    this.showPrompt();
  }

  handleMessage(message) {
    switch (message.type) {
      case 'response_item':
        this.handleResponseItem(message.payload);
        break;

      case 'loading_state':
        this.handleLoadingState(message.payload);
        break;

      case 'approval_request':
        this.handleApprovalRequest(message.payload);
        break;

      case 'agent_finished':
        this.handleAgentFinished(message.payload);
        break;

      case 'context_info':
        this.handleContextInfo(message.payload);
        break;

      case 'context_compacted':
        this.handleContextCompacted(message.payload);
        break;

      case 'error':
        this.handleError(message.payload);
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  handleResponseItem(item) {
    // Suppress shell command display during pending approval
    if (this.pendingApproval && (item.type === 'local_shell_call' || item.type === 'local_shell_call_output')) {
      this.suppressedItems.push(item);
      return; // Don't display shell commands until approval is resolved
    }
    
    //console.log(`${JSON.stringify(item, null, 2)}`)
    
    switch (item.type) {
      case 'message':
        this.handleStreamingMessage(item);
        break;

      case 'function_call':
        // Finalize any active assistant messages before showing tool call
        this.finalizeActiveMessages();
        
        console.log('\n🔧 Tool Call:');
        console.log(`Function: ${item.name}`);
        if (item.arguments) {
          try {
            const args = JSON.parse(item.arguments);
            console.log('Arguments:', JSON.stringify(args, null, 2));
          } catch {
            console.log('Arguments:', item.arguments);
          }
        }
        break;

      case 'local_shell_call':
        console.log('\n🔧 Shell Command:');
        console.log(`Command: ${item.action.command.join(' ')}`);
        if (item.status === 'completed') {
          console.log('Status: ✅ Completed');
        }
        break;

      case 'local_shell_call_output':
        console.log('\n📤 Shell Output:');
        try {
          const output = JSON.parse(item.output);
          if (output.output) {
            console.log(output.output.trim());
          }
          if (output.metadata) {
            console.log(`Exit code: ${output.metadata.exit_code}, Duration: ${output.metadata.duration_seconds}s`);
          }
        } catch {
          console.log(item.output);
        }
        
        // Show prompt after shell output if no pending approval
        if (!this.pendingApproval) {
          this.showPrompt();
        }
        break;

      case 'function_call_output':
        console.log('\n📤 Tool Output:');
        try {
          const output = JSON.parse(item.output);
          if (output.output) {
            console.log(output.output);
          }
          if (output.metadata) {
            console.log('Metadata:', JSON.stringify(output.metadata, null, 2));
          }
        } catch {
          console.log(item.output);
        }
        
        // Show prompt after tool output if no pending approval
        if (!this.pendingApproval) {
          this.showPrompt();
        }
        break;

      case 'reasoning':
        console.log('\n🤔 Reasoning:');
        
        // Handle different reasoning formats
        let hasContent = false;
        
        // Check for summary array (codex format)
        if (Array.isArray(item.summary) && item.summary.length > 0) {
          item.summary.forEach(summary => {
            console.log(summary.text || summary);
          });
          hasContent = true;
        }
        
        // Check for content array (gpt format)
        if (Array.isArray(item.content) && item.content.length > 0) {
          item.content.forEach(content => {
            console.log(content.text || content);
          });
          hasContent = true;
        }
        
        // Check for direct content or reasoning field
        if (!hasContent) {
          if (item.content) {
            console.log(item.content);
            hasContent = true;
          } else if (item.reasoning) {
            console.log(item.reasoning);
            hasContent = true;
          }
        }
        
        // Show timing info if no visible reasoning content
        if (!hasContent) {
          console.log(`(thinking for ${item.duration_ms}ms...)`);
        }
        break;

      default:
        console.log('\n📄 Response:', JSON.stringify(item, null, 2));
    }
  }

  finalizeActiveMessages() {
    // Add newline after any active assistant messages that actually showed content
    for (const [messageId, message] of this.activeMessages) {
      if (message.role === 'assistant' && message.hasShownPrefix && message.text.trim()) {
        console.log(''); // Add newline after assistant message
      }
    }
    this.activeMessages.clear();
  }

  handleStreamingMessage(item) {
    const messageId = item.id;
    const role = item.role;
    
    // Extract text content from this chunk
    let chunkText = '';
    if (Array.isArray(item.content)) {
      chunkText = item.content.map(content => content.text || content).join('');
    } else if (item.content) {
      chunkText = item.content;
    }
    
    if (role === 'assistant') {
      if (!this.activeMessages.has(messageId)) {
        // First chunk for this message ID
        this.activeMessages.set(messageId, { 
          text: chunkText, 
          role: 'assistant',
          hasShownPrefix: false
        });
        
        // Only show prefix if we have actual content
        if (chunkText.trim()) {
          console.log('\n🤖 Assistant:');
          this.activeMessages.get(messageId).hasShownPrefix = true;
          process.stdout.write(chunkText);
        }
      } else {
        // Subsequent chunk for same message ID
        const existing = this.activeMessages.get(messageId);
        
        // If we haven't shown prefix yet and now we have content, show it
        if (!existing.hasShownPrefix && chunkText.trim()) {
          console.log('\n🤖 Assistant:');
          existing.hasShownPrefix = true;
        }
        
        if (chunkText) {
          process.stdout.write(chunkText);
          existing.text += chunkText;
        }
      }
    } else if (role === 'system') {
      console.log('\n⚙️  System:');
      console.log(chunkText);
    }
  }

  processSuppressedItems() {
    // Display any items that were suppressed during approval
    const items = this.suppressedItems;
    this.suppressedItems = [];
    
    items.forEach(item => {
      this.handleResponseItem(item);
    });
  }

  handleLoadingState(payload) {
    if (payload.loading) {
      process.stdout.write('\r🔄 Thinking...');
    } else {
      process.stdout.write('\r\x1b[K'); // Clear thinking indicator
      // Don't show prompt here - let handleAgentFinished do it
    }
  }

  handleApprovalRequest(payload) {
    this.pendingApproval = payload;
    
    // Clear current line and show approval request
    process.stdout.write('\r\x1b[K');
    console.log('\n⚠️  APPROVAL REQUIRED');
    console.log('Command:', payload.command.join(' '));
    
    if (payload.applyPatch) {
      console.log('This is a file modification command');
      console.log('Patch preview:', payload.applyPatch.patch.substring(0, 200) + '...');
    }
    
    console.log('\nChoose an option:');
    console.log('  y/yes     - Approve this command');
    console.log('  n/no      - Deny this command and stop');
    console.log('  c/continue - Deny this command but continue');
    console.log('  a/always  - Approve this and similar commands');
    console.log('  e/explain - Ask the agent to explain this command');
    
    this.rl.setPrompt('Approval [y/n/c/a/e]: ');
    this.rl.prompt();
  }

  handleAgentFinished(payload) {
    // Finalize any active assistant messages
    this.finalizeActiveMessages();
    
    console.log('\n✅ Agent finished processing');
    console.log('Response ID:', payload.responseId);
    if (Object.keys(payload).length > 1) {
      console.log('Additional data:', JSON.stringify(payload, null, 2));
    }
    this.showPrompt();
  }

  handleError(payload) {
    process.stdout.write('\r\x1b[K');
    console.log('\n❌ Error:', payload.message);
    if (payload.details) {
      console.log('Details:', payload.details);
    }
    this.showPrompt();
  }

  handleUserInput(input) {
    if (input.toLowerCase() === 'exit') {
      this.ws.close();
      return;
    }

    if (this.pendingApproval) {
      this.handleApprovalInput(input);
      return;
    }

    if (input.trim() === '') {
      this.showPrompt();
      return;
    }

    // Handle special commands
    if (input.trim() === '/context') {
      this.sendMessage({
        id: randomUUID(),
        type: 'get_context_info'
      });
      return;
    }

    if (input.trim() === '/compact') {
      console.log('\n🗜️ Requesting manual context compaction...');
      this.sendMessage({
        id: randomUUID(),
        type: 'manual_compact'
      });
      return;
    }

    // Send user input to the agent
    this.sendMessage({
      id: randomUUID(),
      type: 'user_input',
      payload: {
        input: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: input }]
        }]
      }
    });
  }

  handleApprovalInput(input) {
    const choice = input.toLowerCase();
    let review;
    let customDenyMessage = undefined;

    switch (choice) {
      case 'y':
      case 'yes':
        review = 'yes';
        break;
      case 'n':
      case 'no':
        review = 'no-exit';
        break;
      case 'c':
      case 'continue':
        review = 'no-continue';
        customDenyMessage = 'User denied command but requested to continue';
        break;
      case 'a':
      case 'always':
        review = 'always';
        break;
      case 'e':
      case 'explain':
        review = 'explain';
        break;
        
      default:
        console.log('Invalid choice. Please enter y/n/c/a/e');
        this.rl.prompt();
        return;
    }

    // Send approval response
    this.sendMessage({
      id: randomUUID(),
      type: 'approval_response',
      payload: {
        review,
        applyPatch: this.pendingApproval.applyPatch,
        customDenyMessage
      }
    });

    // Only clear pending approval if it's not an explain request
    if (review !== 'explain') {
      this.pendingApproval = null;
      console.log(`✓ Response sent: ${review}`);
      
      // Process any items that were suppressed during approval
      this.processSuppressedItems();
    } else {
      console.log(`🤔 Explanation requested...`);
    }
  }

  sendMessage(message) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.log('Connection not ready');
    }
  }

  showPrompt() {
    this.rl.setPrompt('You: ');
    this.rl.prompt();
  }
}

// Start the client
console.log('Starting AgentLoop WebSocket client...');
new AgentLoopClient();
