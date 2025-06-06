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
  }

  setupWebSocket() {
    this.ws.on('open', () => {
      console.log('Connected to AgentLoop server');
      console.log('Type your message and press Enter to send to the agent.');
      console.log('Type "exit" to quit.\n');
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

      case 'error':
        this.handleError(message.payload);
        break;

      default:
        console.log('Unknown message type:', message.type);
    }
  }

  handleResponseItem(item) {
    // Clear the current line and move cursor to beginning
    process.stdout.write('\r\x1b[K');
    console.log(`item: ${JSON.stringify(item, null, 2)}`)
    
    switch (item.type) {
      case 'message':
        if (item.role === 'assistant') {
          console.log('\n🤖 Assistant:');
          item.content.forEach(content => {
            console.log(content.text);
          });
        } else if (item.role === 'system') {
          console.log('\n⚙️  System:');
          item.content.forEach(content => {
            console.log(content.text);
          });
        }
        break;

      case 'function_call':
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
        break;

      case 'reasoning':
        console.log('\n🤔 Reasoning:');
        item.content.forEach(content => {
          console.log(content.text);
        });
        break;

      default:
        console.log('\n📄 Response:', JSON.stringify(item, null, 2));
    }
  }

  handleLoadingState(payload) {
    if (payload.loading) {
      process.stdout.write('\r🔄 Thinking...');
    } else {
      process.stdout.write('\r\x1b[K'); // Clear loading indicator
      if (!this.pendingApproval) {
        this.showPrompt();
      }
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
    process.stdout.write('\r\x1b[K');
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
        review = 'YES';
        break;
      case 'n':
      case 'no':
        review = 'NO';
        break;
      case 'c':
      case 'continue':
        review = 'NO_CONTINUE';
        customDenyMessage = 'User denied command but requested to continue';
        break;
      case 'a':
      case 'always':
        review = 'ALWAYS';
        break;
      case 'e':
      case 'explain':
        review = 'EXPLAIN';
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

    this.pendingApproval = null;
    console.log(`✓ Response sent: ${review}`);
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