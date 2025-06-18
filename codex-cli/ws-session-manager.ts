
import { WebSocket } from 'ws';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { AgentLoopFactory, type IAgentLoop, type CommandConfirmation } from './src/utils/agent/index.js';
import type { ApplyPatchCommand, ApprovalPolicy } from './src/approvals.js';
import type { ResponseItem, ResponseInputItem } from 'openai/resources/responses/responses.mjs';
import { ContextManager, createContextManager, type ContextInfo } from './context-managers.js';
import { randomUUID } from 'crypto';
import type { AppConfig } from './src/utils/config.js';
import { type ClaudeTool } from './src/utils/agent/claude-types.js';
import { JupyterMcpWrapper } from './src/utils/agent/mcp-wrapper.js';

// Types for session management
export interface SessionEvent {
    timestamp: string;
    event_type: 'websocket_message_received' | 'websocket_message_sent';
    direction: 'incoming' | 'outgoing';
    message_data: any;
}

// Message types for WebSocket communication
interface WSMessage {
    id: string;
    type: string;
    payload?: any;
}

interface UserInputMessage extends WSMessage {
    type: 'user_input';
    payload: {
        input: Array<ResponseInputItem>;
        previousResponseId?: string;
    };
}

interface ApprovalResponseMessage extends WSMessage {
    type: 'approval_response';
    payload: CommandConfirmation;
}


export class SessionManager {
    private currentSessionId: string;
    private sessionStorePath: string;
    private agentLoop: IAgentLoop;
    private ws: WebSocket;
    private contextManager: ContextManager;
    private pendingApprovalRequest: {
        resolve: (confirmation: CommandConfirmation) => void;
        reject: (error: Error) => void;
        command: Array<string>;
        applyPatch?: ApplyPatchCommand;
    } | null;
    private messageFragments: Map<string, ResponseItem[]> = new Map();
    private jupyterMcpWrapper: JupyterMcpWrapper | null;

    // Fragment collection for turn-based message logging:
    // Collects streaming message fragments during a conversation turn and combines
    // them into complete messages for session logging while preserving real-time
    // streaming to the client.
    private currentTurnFragments: ResponseItem[] = [];
    // Note: lastResponseId is not needed when disableResponseStorage: true


    constructor(sessionId: string, ws: WebSocket, sessionStorePath: string, jupyterMcpWrapper: JupyterMcpWrapper | null) {
        this.currentSessionId = sessionId;
        this.sessionStorePath = sessionStorePath;
        this.jupyterMcpWrapper = jupyterMcpWrapper;

        const sessionEvent: SessionEvent = {
            timestamp: new Date().toISOString(),
            event_type: 'websocket_message_received',
            direction: 'incoming',
            message_data: { event: 'session_connected', session_id: sessionId }
        };

        this.logSessionEvent(sessionEvent);
        console.log(`🆔 Connected to session: ${this.currentSessionId}`);

        // Load existing session events and reconstruct transcript for resumption
        const sessionEvents = this.loadSessionEvents(sessionId);
        const resumeTranscript = this.reconstructTranscriptFromEvents(sessionEvents);

        // Initialize AgentLoop when client connects, with session resumption if available
        this.initializeAgentLoop(undefined /* seedInput */, resumeTranscript.length > 0 ? resumeTranscript : undefined);

        ws.on('message', async (data) => {
            try {
                const message: WSMessage = JSON.parse(data.toString());

                // Basic activity logging for monitoring
                const sessionInfo = this.currentSessionId ? ` [session: ${this.currentSessionId.substring(0, 8)}...]` : '';
                console.log(`📨 WebSocket message received: type=${message.type}, id=${message.id}${sessionInfo}`);

                // Log incoming message to session storage
                this.logIncomingMessage(message);

                await this.handleMessage(message);
            } catch (error) {
                console.error('Error handling message:', error);
                this.sendError('Invalid message format', error);
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected');
            this.endSession();
            this.cleanup();
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            this.endSession();
            this.cleanup();
        });

        this.ws = ws;
    }

    private loadSessionEvents(sessionId: string): SessionEvent[] {
        if (!this.sessionStorePath) {
            console.log('⚠️  Session storage not configured, starting fresh session');
            return [];
        }

        try {
            const sessionFile = join(this.sessionStorePath, `${sessionId}.jsonl`);

            if (!existsSync(sessionFile)) {
                console.log(`📝 No existing session file found for ${sessionId}, starting fresh`);
                return [];
            }

            // Read the entire session file
            const content = readFileSync(sessionFile, 'utf-8');
            const lines = content.trim().split('\n').filter(line => line.length > 0);

            if (lines.length === 0) {
                console.log(`📝 Empty session file for ${sessionId}, starting fresh`);
                return [];
            }

            // Parse all events
            const events: SessionEvent[] = [];
            for (const line of lines) {
                try {
                    const event: SessionEvent = JSON.parse(line);
                    events.push(event);
                } catch (parseError) {
                    console.error(`❌ Error parsing event in session ${sessionId}:`, parseError);
                    // Continue with other events instead of failing completely
                }
            }

            console.log(`📚 Loaded ${events.length} events from session ${sessionId}`);
            return events;

        } catch (error) {
            console.error(`❌ Error loading session events for ${sessionId}:`, error);
            return [];
        }
    }

    private reconstructTranscriptFromEvents(events: SessionEvent[]): Array<ResponseInputItem> {
        const transcript: Array<ResponseInputItem> = [];

        for (const event of events) {
            // Skip non-message events
            if (event.event_type !== 'websocket_message_received' &&
                event.event_type !== 'websocket_message_sent') {
                continue;
            }

            // Skip system events like session_started, session_connected, etc.
            if (event.message_data?.event) {
                continue;
            }

            // Process user input messages
            if (event.event_type === 'websocket_message_received' &&
                event.message_data?.type === 'user_input') {
                const userInput = event.message_data.payload?.input;
                if (userInput && Array.isArray(userInput)) {
                    transcript.push(...userInput);
                }
            }

            // Process response items (assistant messages, tool calls, explanation messages, etc.)
            if (event.event_type === 'websocket_message_sent' &&
                event.message_data?.type === 'response_item') {
                const responseItem = event.message_data.payload;
                if (responseItem) {
                    // Convert response item to input item format for transcript
                    const inputItem: ResponseInputItem = {
                        id: responseItem.id,
                        type: responseItem.type,
                        role: responseItem.role,
                        status: responseItem.status,
                        content: responseItem.content,
                        ...(responseItem.action && { action: responseItem.action }),
                        ...(responseItem.result && { result: responseItem.result })
                    };
                    transcript.push(inputItem);
                }
            }
        }

        console.log(`🔄 Reconstructed transcript with ${transcript.length} items`);
        return transcript;
    }

    private logSessionEvent(event: SessionEvent): void {
        if (!this.sessionStorePath || !this.currentSessionId) {
            return;
        }

        try {
            const sessionFile = join(this.sessionStorePath, `${this.currentSessionId}.jsonl`);
            const eventLine = JSON.stringify(event) + '\n';
            appendFileSync(sessionFile, eventLine);
        } catch (error) {
            console.error(`❌ Failed to log session event: ${error.message}`);
        }
    }

    private endSession(): void {
        const sessionEvent: SessionEvent = {
            timestamp: new Date().toISOString(),
            event_type: 'websocket_message_received',
            direction: 'incoming',
            message_data: { event: 'session_ended' }
        };

        this.logSessionEvent(sessionEvent);
        console.log(`🔚 Ended session: ${this.currentSessionId}`);
    }

    private logIncomingMessage(message: WSMessage): void {
        const sessionEvent: SessionEvent = {
            timestamp: new Date().toISOString(),
            event_type: 'websocket_message_received',
            direction: 'incoming',
            message_data: message
        };

        this.logSessionEvent(sessionEvent);
    }

    private logOutgoingMessage(message: WSMessage): void {
        const sessionEvent: SessionEvent = {
            timestamp: new Date().toISOString(),
            event_type: 'websocket_message_sent',
            direction: 'outgoing',
            message_data: message
        };

        this.logSessionEvent(sessionEvent);
    }


    private async handleMessage(message: WSMessage) {
        switch (message.type) {
            case 'user_input':
                await this.handleUserInput(message as UserInputMessage);
                break;

            case 'approval_response':
                await this.handleApprovalResponse(message as ApprovalResponseMessage);
                break;

            case 'get_context_info':
                this.handleGetContextInfo();
                break;

            case 'manual_compact':
                await this.handleManualCompaction();
                break;

            default:
                this.sendError(`Unknown message type: ${message.type}`);
        }
    }

    private async handleUserInput(message: UserInputMessage) {
        if (!this.contextManager) {
            console.log('⚠️handleUserInput: ContextManager not initialized');
            this.sendError('handleUserInput: ContextManager not initialized');
            return;
        }
        if (!this.agentLoop) {
            console.log('⚠️handleUserInput: AgentLoop not initialized');
            this.sendError('handleUserInput: AgentLoop not initialized');
            return;
        }

        try {
            const { input } = message.payload;

            // Add user input to context manager for tracking
            this.contextManager.addUserInput(input);

            // Check if we're approaching context limits before processing
            const contextInfo = this.contextManager.getContextInfo();
            if (contextInfo.usagePercent > 90) {
                console.log(`Context usage high (${contextInfo.usagePercent.toFixed(1)}%), considering auto-compaction`);
            }

            console.log(`Invoking agentLoop.run`);

            // Since we're using disableResponseStorage: true, we don't need previousResponseId
            // Each request is self-contained and doesn't rely on server-side conversation state
            await this.agentLoop.run(input);

        } catch (error) {
            console.error('Error running AgentLoop:', error);
            this.sendError('Failed to process user input', error);
        }
    }

    private async handleApprovalResponse(message: ApprovalResponseMessage) {
        if (!this.pendingApprovalRequest) {
            this.sendError('No pending approval request');
            return;
        }

        try {
            console.log(`✅ SERVER: Received approval response: ${message.payload.review}`);

            // Handle explanation request specially
            if (message.payload.review === 'explain') {
                console.log(`🤔 SERVER: Handling explanation request`);

                try {
                    // Generate explanation using AI model
                    const explanation = await this.generateCommandExplanation(this.pendingApprovalRequest.command);

                    // Send explanation message back to client
                    this.sendMessage({
                        id: randomUUID(),
                        type: 'response_item',
                        payload: {
                            id: randomUUID(),
                            type: 'message',
                            role: 'assistant',
                            content: [{
                                type: 'input_text',
                                text: explanation
                            }]
                        }
                    });

                } catch (error) {
                    console.error('Failed to generate explanation:', error);
                    this.sendMessage({
                        id: randomUUID(),
                        type: 'response_item',
                        payload: {
                            id: randomUUID(),
                            type: 'message',
                            role: 'assistant',
                            content: [{
                                type: 'input_text',
                                text: `Unable to generate explanation for command "${this.pendingApprovalRequest.command.join(' ')}" due to an error. Please make a decision on whether to approve this command.`
                            }]
                        }
                    });
                }

                // Send a new approval request (don't resolve the promise yet)
                this.sendMessage({
                    id: randomUUID(),
                    type: 'approval_request',
                    payload: {
                        command: this.pendingApprovalRequest.command,
                        applyPatch: this.pendingApprovalRequest.applyPatch,
                    },
                });

                console.log(`📤 SERVER: Sent explanation and renewed approval request`);
                return; // Don't resolve the approval yet
            }

            console.log(`🚀 SERVER: Resolving approval promise - command can now execute`);

            // Resolve the pending approval request with the user's decision
            this.pendingApprovalRequest.resolve(message.payload);
            this.pendingApprovalRequest = null;

            console.log(`📝 SERVER: Approval resolved, AgentLoop should continue execution`);
        } catch (error) {
            console.error('Error handling approval response:', error);
            this.sendError('Failed to process approval response', error);
        }
    }

    private sendMessage(message: WSMessage) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // FRAGMENT LOGGING FILTER:
            // Skip logging individual message fragments to avoid duplicate entries.
            // Message fragments are collected and logged as complete messages when
            // the conversation turn ends (see logCollectedTurnFragments).
            // However, standalone explanation messages should be logged immediately.
            // Non-message items (function calls, loading states, etc.) are logged immediately.
            const isStreamingFragment = message.type === 'response_item' &&
                message.payload?.type === 'message' &&
                this.isStreamingResponse();

            if (!isStreamingFragment) {
                this.logOutgoingMessage(message);
            }

            // Basic activity logging for monitoring (but avoid spamming with streaming fragments)
            if (!isStreamingFragment || message.type !== 'response_item') {
                const sessionInfo = this.currentSessionId ? ` [session: ${this.currentSessionId.substring(0, 8)}...]` : '';
                console.log(`📤 WebSocket message sent: type=${message.type}, id=${message.id}${sessionInfo}`);
            }

            this.ws.send(JSON.stringify(message));
        }
    }

    private isStreamingResponse(): boolean {
        // Explanation messages are sent during approval handling, not during streaming responses
        // We can detect this by checking if we have a pending approval request
        return this.pendingApprovalRequest === null;
    }

    private sendError(message: string, details?: any) {
        this.sendMessage({
            id: randomUUID(),
            type: 'error',
            payload: { message, details },
        });
    }

    private async handleAutoCompaction(): Promise<void> {
        try {
            console.log('🗜️ Performing automatic context compaction...');

            const oldTokenCount = this.contextManager.getTokenCount();

            // Generate compacted summary
            const summaryItem = await this.contextManager.compact();

            // Get seed input for new AgentLoop
            const seedInput = this.contextManager.getCompactedSeedInput();

            // Recreate AgentLoop with compacted context
            this.initializeAgentLoop(undefined, seedInput);

            const newTokenCount = this.contextManager.getTokenCount();
            const reductionPercent = ((oldTokenCount - newTokenCount) / oldTokenCount) * 100;

            // Notify client about successful compaction
            this.sendMessage({
                id: randomUUID(),
                type: 'context_compacted',
                payload: {
                    oldTokenCount,
                    newTokenCount,
                    reductionPercent,
                    strategy: this.contextManager.getStrategyName()
                }
            });

            console.log(`✅ Context compacted: ${oldTokenCount} → ${newTokenCount} tokens (${reductionPercent.toFixed(1)}% reduction)`);

        } catch (error) {
            console.error('❌ Auto-compaction failed:', error);

            // Send error to client
            this.sendError('Automatic context compaction failed', {
                error: error.message,
                context: 'auto_compaction'
            });
        }
    }

    private async handleManualCompaction(): Promise<void> {
        console.log('🗜️ Manual context compaction requested');
        await this.handleAutoCompaction();
    }

    private handleGetContextInfo(): void {
        if (!this.contextManager) {
            this.sendError('ContextManager not initialized');
            return;
        }

        const contextInfo = this.contextManager.getContextInfo();
        this.sendMessage({
            id: randomUUID(),
            type: 'context_info',
            payload: contextInfo,
        });
    }

    private async generateCommandExplanation(command: Array<string>): Promise<string> {
        try {
            console.log(`🤖 SERVER: Generating explanation for command: ${command.join(' ')}`);

            // Create OpenAI client (reuse the same configuration as AgentLoop)
            const OpenAI = (await import('openai')).default;
            const oai = new OpenAI({
                apiKey: process.env.OPENAI_API_KEY,
                timeout: 30000, // 30 second timeout for explanation
            });

            // Format the command for display
            const commandForDisplay = command.join(' ');

            // Create explanation request (same prompt as TUI)
            const response = await oai.chat.completions.create({
                model: 'gpt-4', // Use a reliable model for explanations
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert in shell commands and terminal operations. Your task is to provide detailed, accurate explanations of shell commands that users are considering executing. Break down each part of the command, explain what it does, identify any potential risks or side effects, and explain why someone might want to run it. Be specific about what files or systems will be affected. If the command could potentially be harmful, make sure to clearly highlight those risks.',
                    },
                    {
                        role: 'user',
                        content: `Please explain this shell command in detail: \`${commandForDisplay}\`\n\nProvide a structured explanation that includes:\n1. A brief overview of what the command does\n2. A breakdown of each part of the command (flags, arguments, etc.)\n3. What files, directories, or systems will be affected\n4. Any potential risks or side effects\n5. Why someone might want to run this command\n\nBe specific and technical - this explanation will help the user decide whether to approve or reject the command.`,
                    },
                ],
            });

            const explanation = response.choices[0]?.message.content || 'Unable to generate explanation.';
            console.log(`✅ SERVER: Generated explanation (${explanation.length} chars)`);
            return explanation;

        } catch (error) {
            console.error('❌ SERVER: Error generating command explanation:', error);
            throw error;
        }
    }

    private cleanup() {
        // End session if still active
        if (this.currentSessionId) {
            this.endSession();
        }

        this.agentLoop.terminate();

        if (this.pendingApprovalRequest) {
            this.pendingApprovalRequest.reject(new Error('Connection closed'));
        }

        // Clear any remaining message fragments
        this.messageFragments.clear();
        this.currentTurnFragments = [];
    }


    private initializeAgentLoop(seedInput?: Array<ResponseInputItem>, resumeTranscript?: Array<ResponseInputItem>) {
        // Clean up any existing agent loop and reset state
        if (this.agentLoop) {
            console.log('Terminating existing AgentLoop');
            this.agentLoop.terminate();
        }

        // Reset all session state for new client
        this.pendingApprovalRequest = null;
        console.log('Creating new AgentLoop with fresh state');

        // Determine provider from environment or auto-detect from model
        const model = process.env.MODEL || 'codex-mini-latest';
        const provider = (process.env.PROVIDER as 'openai' | 'anthropic' | 'google') ||
            AgentLoopFactory.detectProvider(model);

        // Choose the appropriate API key based on provider
        let apiKey: string;
        if (provider === 'anthropic') {
            apiKey = process.env.ANTHROPIC_API_KEY || '';
        } else if (provider === 'google') {
            apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
        } else {
            apiKey = process.env.OPENAI_API_KEY || '';
        }

        // Load instructions from file if specified
        let instructions = '';
        const instructionsFilePath = process.env.INSTRUCTIONS_FILE_PATH;
        if (instructionsFilePath) {
            try {
                if (existsSync(instructionsFilePath)) {
                    instructions = readFileSync(instructionsFilePath, 'utf-8');
                    console.log(`✅ Loaded instructions from file: ${instructionsFilePath}`);
                } else {
                    console.error(`❌ Instructions file not found: ${instructionsFilePath}`);
                    console.error('Please create the file or update INSTRUCTIONS_FILE_PATH in your .env file');
                }
            } catch (error) {
                console.error(`❌ Error reading instructions file: ${error.message}`);
                console.error('Using empty instructions');
            }
        }

        // Default configuration - you can modify this based on your needs
        const config: AppConfig = {
            model, // Use same default as TUI for better tool behavior
            instructions,
            apiKey,
        };

        // Configure approval policy from environment variable
        const approvalModeEnv = process.env.TOOL_USE_APPROVAL_MODE;
        let approvalPolicy: ApprovalPolicy = 'suggest'; // Conservative by default

        if (approvalModeEnv) {
            if (approvalModeEnv === 'suggest' || approvalModeEnv === 'auto-edit' || approvalModeEnv === 'full-auto') {
                approvalPolicy = approvalModeEnv;
                console.log(`✅ Using tool approval mode: ${approvalPolicy}`);
            } else {
                console.error(`❌ Invalid TOOL_USE_APPROVAL_MODE: ${approvalModeEnv}`);
                console.error('Valid values are: suggest, auto-edit, full-auto');
                console.error('Using default: suggest');
            }
        } else {
            console.log(`ℹ️  Using default tool approval mode: ${approvalPolicy}`);
        }

        // Initialize context manager using factory
        const strategy = process.env.CONTEXT_STRATEGY || 'threshold';
        console.log('[🆕] initializeAgentLoop creating new this.contextManager');
        this.contextManager = createContextManager(strategy, {
            model: config.model || 'codex-mini-latest',
            compactionThreshold: parseFloat(process.env.CONTEXT_COMPACTION_THRESHOLD || '0.8'),
            config
        });

        // Set up auto-compaction callback
        this.contextManager.onCompactionNeeded = async (transcript) => {
            await this.handleAutoCompaction();
        };

        console.log(`🤖 SERVER: Creating AgentLoop with provider: ${provider}, model: ${model}`);

        this.agentLoop = AgentLoopFactory.create({
            model,
            provider,
            config,
            instructions: config.instructions,
            approvalPolicy,
            additionalWritableRoots: [process.cwd()],
            disableResponseStorage: true,

            // Callback for streaming response items back to client
            onItem: (item: ResponseItem) => {
                // console.log(`📨 SERVER: Received response item type: ${item.type}, id: ${item.id}${item.type === 'local_shell_call' ? ` (command: ${(item as any).action?.command?.join(' ')})` : ''}`);

                // Add to context manager first for tracking
                this.contextManager?.addItem(item);

                // STREAMING FRAGMENT COLLECTION:
                // Collect message fragments for session logging while continuing to stream to client.
                // This allows us to log complete messages instead of individual fragments.
                if (item.type === 'message') {
                    this.currentTurnFragments.push(item);
                }

                // console.log(`📤 SERVER: Sending response item to client: ${item.type}`);
                // Then send to client
                this.sendMessage({
                    id: randomUUID(),
                    type: 'response_item',
                    payload: item,
                });
            },

            // Callback for loading state changes
            onLoading: (loading: boolean) => {
                // TURN START: Clear fragments when starting a new conversation turn
                // This ensures we collect only fragments belonging to the current turn
                if (loading) {
                    this.currentTurnFragments = [];
                }

                this.sendMessage({
                    id: randomUUID(),
                    type: 'loading_state',
                    payload: { loading },
                });
            },

            // Callback for approval requests - this is where we handle user interaction
            getCommandConfirmation: async (
                command: Array<string>,
                applyPatch?: ApplyPatchCommand
            ): Promise<CommandConfirmation> => {
                console.log(`🔒 SERVER: Requesting approval for command: ${command.join(' ')}`);
                return new Promise((resolve, reject) => {
                    // Store the pending request
                    this.pendingApprovalRequest = {
                        resolve,
                        reject,
                        command,
                        applyPatch,
                    };

                    console.log(`📤 SERVER: Sending approval request to client`);
                    // Send approval request to client
                    this.sendMessage({
                        id: randomUUID(),
                        type: 'approval_request',
                        payload: {
                            command,
                            applyPatch,
                        },
                    });
                    console.log(`⏳ SERVER: Waiting for approval response...`);
                });
            },

            // Callback for tracking response IDs
            onLastResponseId: (responseId: string) => {
                // TURN END: Log collected message fragments as a complete message
                // This combines all streaming fragments from this turn into a single
                // session log entry, avoiding multiple partial message entries
                this.logCollectedTurnFragments(responseId);

                // Send context info with agent finished message
                const contextInfo = this.contextManager?.getContextInfo();

                this.sendMessage({
                    id: randomUUID(),
                    type: 'agent_finished',
                    payload: { responseId },
                });

                // Send current context info
                if (contextInfo) {
                    this.sendMessage({
                        id: randomUUID(),
                        type: 'context_info',
                        payload: contextInfo,
                    });
                }
            },

            mcpWrapper: this.jupyterMcpWrapper,
        });

        // If we have seed input (from compaction), run it to initialize the transcript
        if (seedInput && seedInput.length > 0) {
            console.log('Seeding new AgentLoop with compacted context...');
            // Run the seed input to initialize the AgentLoop's internal transcript
            this.agentLoop.run(seedInput).catch(error => {
                console.error('Error seeding AgentLoop:', error);
                this.sendError('Failed to seed AgentLoop with compacted context', error);
            });
        }

        // If we have a resume transcript (from session resumption), initialize the transcript
        if (resumeTranscript && resumeTranscript.length > 0) {
            console.log(`🔄 Resuming session with ${resumeTranscript.length} items from previous conversation...`);
            // Initialize the transcript without making API calls
            if (this.agentLoop.initializeTranscript) {
                this.agentLoop.initializeTranscript(resumeTranscript);
            } else {
                console.warn('⚠️  AgentLoop implementation does not support initializeTranscript - session resumption unavailable');
            }
        }
    }

    /**
     * Logs collected streaming fragments as a complete message for session storage.
     *
     * FRAGMENT COLLECTION WORKFLOW:
     * 1. Turn Start: onLoading(true) → Clear currentTurnFragments
     * 2. Streaming: onItem() called with message fragments → Add to currentTurnFragments
     * 3. Turn End: onLastResponseId() → Combine fragments and log as complete message
     * 4. Continue streaming to client: Individual fragments still sent to client in real-time
     *
     * This approach ensures session logs contain complete messages instead of multiple
     * partial message events, while preserving the real-time streaming experience for clients.
     */
    private logCollectedTurnFragments(responseId: string): void {
        if (this.currentTurnFragments.length === 0) {
            return; // No fragments to log for this turn
        }

        // Combine all message fragments into a single complete message
        const completeMessage = this.combineMessageFragments(this.currentTurnFragments);

        if (completeMessage) {
            // Log the complete message instead of individual fragments
            const sessionEvent: SessionEvent = {
                timestamp: new Date().toISOString(),
                event_type: 'websocket_message_sent',
                direction: 'outgoing',
                message_data: {
                    id: randomUUID(),
                    type: 'response_item',
                    payload: completeMessage,
                }
            };

            this.logSessionEvent(sessionEvent);
        }

        // Clear the fragments for the next turn
        this.currentTurnFragments = [];
    }

    /**
     * Combines streaming message fragments into a single complete message.
     * Takes multiple message fragments with partial text content and merges
     * them into one message with the full combined text.
     */
    private combineMessageFragments(fragments: ResponseItem[]): ResponseItem | null {
        if (fragments.length === 0) {
            return null;
        }

        // Use the first fragment as the base and combine content from all fragments
        const baseMessage = { ...fragments[0] };

        // Combine all text content from fragments
        let combinedText = '';
        for (const fragment of fragments) {
            if (fragment.content && Array.isArray(fragment.content)) {
                for (const contentItem of fragment.content) {
                    if (contentItem.type === 'output_text') {
                        combinedText += contentItem.text || '';
                    }
                }
            }
        }

        // Update the content with the combined text
        if (baseMessage.content && Array.isArray(baseMessage.content)) {
            baseMessage.content = [{
                type: 'output_text',
                text: combinedText,
                annotations: []
            }];
        }

        return baseMessage;
    }

    // Public methods for monitoring and control
    public getContextInfo(): ContextInfo | null {
        return this.contextManager?.getContextInfo() || null;
    }

    public async manualCompact(): Promise<void> {
        await this.handleManualCompaction();
    }
}
