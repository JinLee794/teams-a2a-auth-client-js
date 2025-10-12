// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

const { TeamsActivityHandler } = require('botbuilder');
const { v4: uuidv4 } = require('uuid');

/**
 * DialogBot class extends TeamsActivityHandler to handle Teams activities.
 */
class DialogBot extends TeamsActivityHandler {
    /**
     * Creates an instance of DialogBot.
     * @param {ConversationState} conversationState - The state management object for conversation state.
     * @param {UserState} userState - The state management object for user state.
     * @param {Dialog} dialog - The dialog to be run by the bot.
     */
    constructor(conversationState, userState, dialog) {
        super();

        if (!conversationState) {
            throw new Error('[DialogBot]: Missing parameter. conversationState is required');
        }
        if (!userState) {
            throw new Error('[DialogBot]: Missing parameter. userState is required');
        }
        if (!dialog) {
            throw new Error('[DialogBot]: Missing parameter. dialog is required');
        }

        this.conversationState = conversationState;
        this.userState = userState;
        this.dialog = dialog;
        this.dialogState = this.conversationState.createProperty('DialogState');

        this.onMessage(this.handleMessage.bind(this));
    }

    /**
     * Handles incoming message activities.
     * @param {TurnContext} context - The context object for the turn.
     * @param {Function} next - The next middleware function in the pipeline.
     */
    async handleMessage(context, next) {
        console.log('Running dialog with Message Activity.');

        const text = context.activity.text?.trim().toLowerCase();
        
        // Special commands that should trigger the dialog flow
        const dialogCommands = ['login', 'logout', 'exit'];
        const isDialogCommand = dialogCommands.includes(text);

        // Check if we have an authenticated A2A client
        const a2aClient = context.turnState.get('a2aClient');
        const hasAuth = context.turnState.get('accessToken');

        // If it's not a dialog command and we have an authenticated A2A client, route to agent
        if (!isDialogCommand && hasAuth && a2aClient) {
            try {
                await this.routeToA2AAgent(context, a2aClient);
                await next();
                return;
            } catch (error) {
                // Check if it's an auth error
                if (error.message.includes('401') || error.message.includes('Unauthorized')) {
                    console.log('Authentication failed, triggering login flow...');
                    // Clear the invalid auth state
                    context.turnState.set('accessToken', null);
                    context.turnState.set('a2aClient', null);
                    // Fall through to dialog
                } else {
                    console.error('Error routing to A2A agent:', error);
                    await context.sendActivity(`⚠️ Error communicating with agent: ${error.message}`);
                    await next();
                    return;
                }
            }
        }

        // Run the Dialog with the new message Activity.
        await this.dialog.run(context, this.dialogState);

        await next();
    }

    /**
     * Routes the message directly to the A2A agent
     * @param {TurnContext} context - The context object for the turn.
     * @param {A2AClient} a2aClient - The authenticated A2A client
     */
    async routeToA2AAgent(context, a2aClient) {
        const userMessage = context.activity.text;
        
        const sendParams = {
            message: {
                messageId: uuidv4(),
                role: "user",
                parts: [{ kind: "text", text: userMessage }],
                kind: "message",
            },
        };

        try {
            // Use streaming to handle all responses for real-time updates
            console.log('DialogBot: Routing message via streaming response');
            await this.handleStreamingResponse(context, a2aClient, sendParams);
        } catch (error) {
            // Check for auth errors
            if (error.message.includes('401') || error.message.includes('Unauthorized')) {
                throw new Error('401 Unauthorized - Authentication required');
            }
            throw error;
        }
    }

    /**
     * Handles streaming response from A2A agent
     * @param {TurnContext} context - The context object
     * @param {A2AClient} a2aClient - The A2A client
     * @param {Object} sendParams - The message parameters
     */
    async handleStreamingResponse(context, a2aClient, sendParams) {
        try {
            console.log('DialogBot: Starting streaming response...');
            
            // Send initial typing indicator
            await context.sendActivity({ type: 'typing' });
            
            const stream = a2aClient.sendMessageStream(sendParams);
            
            let accumulatedText = '';
            let currentTask = null;
            let receivedEvents = false;
            let lastArtifacts = [];
            let messageActivity = null;
            let updateCount = 0;
            const UPDATE_INTERVAL = 5; // Update UI every 5 events for smooth streaming
            let isCompleted = false;
            
            // Set up periodic typing indicator while streaming
            const typingInterval = setInterval(async () => {
                if (!isCompleted) {
                    try {
                        await context.sendActivity({ type: 'typing' });
                    } catch (error) {
                        console.log('DialogBot: Typing indicator failed:', error.message);
                    }
                }
            }, 2000); // Send typing every 2 seconds
            
            try {
                for await (const event of stream) {
                    receivedEvents = true;
                    console.log(`DialogBot: Received event:`, event.kind);
                    
                    if (event.kind === "message") {
                    // Direct message response
                    if (event.parts && event.parts[0]?.text) {
                        accumulatedText += event.parts[0].text;
                        updateCount++;
                        console.log('DialogBot: Accumulated message text');
                        
                        // Update or send the message in Teams
                        if (!messageActivity) {
                            // Send initial message
                            const response = await context.sendActivity(`🤖 ${accumulatedText}`);
                            messageActivity = response;
                        } else if (updateCount % UPDATE_INTERVAL === 0) {
                            // Update existing message periodically for smooth streaming
                            try {
                                await context.updateActivity({
                                    ...messageActivity,
                                    text: `🤖 ${accumulatedText}`,
                                    type: 'message'
                                });
                            } catch (updateError) {
                                console.log('DialogBot: Message update not supported, continuing...');
                            }
                        }
                    }
                } else if (event.kind === "task") {
                    // Initial task creation
                    currentTask = event;
                    console.log(`DialogBot: Task ${event.id} created with status: ${event.status.state}`);
                    
                    // Collect initial artifacts if present
                    if (event.artifacts && event.artifacts.length > 0) {
                        lastArtifacts = event.artifacts;
                    }
                } else if (event.kind === "status-update") {
                    // Task status changed
                    console.log(`DialogBot: Task status update: ${event.status.state}`);
                    if (currentTask) {
                        currentTask.status = event.status;
                    }
                    
                    // If task completed, stop typing indicator and send final update
                    if (event.status.state === "completed") {
                        console.log('DialogBot: Task completed, stopping typing indicator');
                        isCompleted = true;
                        clearInterval(typingInterval);
                        
                        if (accumulatedText && messageActivity) {
                            console.log('DialogBot: Sending final update');
                            try {
                                await context.updateActivity({
                                    ...messageActivity,
                                    text: `🤖 ${accumulatedText}`,
                                    type: 'message'
                                });
                            } catch (updateError) {
                                console.log('DialogBot: Final update failed');
                            }
                        }
                    }
                } else if (event.kind === "artifact-update") {
                    // New artifact added to task
                    console.log(`DialogBot: Artifact update received`);
                    if (event.artifact && event.artifact.parts) {
                        // Collect artifact text
                        for (const part of event.artifact.parts) {
                            if (part.kind === "text" && part.text) {
                                accumulatedText += part.text;
                                updateCount++;
                                
                                // Update message with artifact text
                                if (!messageActivity) {
                                    const response = await context.sendActivity(`🤖 ${accumulatedText}`);
                                    messageActivity = response;
                                } else if (updateCount % UPDATE_INTERVAL === 0) {
                                    try {
                                        await context.updateActivity({
                                            ...messageActivity,
                                            text: `🤖 ${accumulatedText}`,
                                            type: 'message'
                                        });
                                    } catch (updateError) {
                                        console.log('DialogBot: Message update not supported');
                                    }
                                }
                            }
                        }
                        // Store artifact
                        lastArtifacts.push(event.artifact);
                    }
                }
            }
            } finally {
                // Always clean up the typing interval
                clearInterval(typingInterval);
                isCompleted = true;
            }
            
            console.log(`DialogBot: Stream complete. Received events: ${receivedEvents}`);
            
            // Send or update the final response based on what we received
            if (accumulatedText) {
                // We have text content (either from message or artifacts)
                console.log('DialogBot: Sending final accumulated text to Teams');
                
                if (messageActivity) {
                    // Update with final text
                    try {
                        await context.updateActivity({
                            ...messageActivity,
                            text: `🤖 ${accumulatedText}`,
                            type: 'message'
                        });
                    } catch (updateError) {
                        // If update fails, send as new message
                        await context.sendActivity(`🤖 ${accumulatedText}`);
                    }
                } else {
                    // Send as new message if we never sent one
                    await context.sendActivity(`🤖 ${accumulatedText}`);
                }
            } else if (currentTask) {
                // We have a task but no text content
                await context.sendActivity(`🎯 Task ${currentTask.id}: ${currentTask.status.state}`);
                
                // Display artifacts if any
                if (lastArtifacts.length > 0) {
                    for (const artifact of lastArtifacts) {
                        await context.sendActivity(`📎 ${artifact.name || artifact.artifactId}`);
                        if (artifact.parts) {
                            for (const part of artifact.parts) {
                                if (part.kind === "text") {
                                    await context.sendActivity(`📄 ${part.text}`);
                                } else if (part.kind === "file") {
                                    await context.sendActivity(`🗂️ File: ${part.filename || 'unnamed'}`);
                                }
                            }
                        }
                    }
                }
                
                // Show status message if available
                if (currentTask.status.message) {
                    await context.sendActivity(`ℹ️ ${currentTask.status.message}`);
                }
            } else if (!receivedEvents) {
                await context.sendActivity('⚠️ No response received from agent.');
            }
            
            console.log('DialogBot: Response handling complete');
            
        } catch (error) {
            console.error('DialogBot: Streaming error:', error);
            // If streaming fails, fall back to regular response
            console.log('DialogBot: Falling back to regular response...');
            await this.handleRegularResponse(context, a2aClient, sendParams);
        }
    }

    /**
     * Handles regular (non-streaming) response from A2A agent
     * @param {TurnContext} context - The context object
     * @param {A2AClient} a2aClient - The A2A client
     * @param {Object} sendParams - The message parameters
     */
    async handleRegularResponse(context, a2aClient, sendParams) {
        // Send typing indicator
        await context.sendActivity({ type: 'typing' });
        
        const response = await a2aClient.sendMessage(sendParams);
        
        if ("error" in response) {
            throw new Error(response.error.message);
        }

        const result = response.result;
        
        if (result.kind === "message") {
            const text = result.parts[0]?.text || 'No text content';
            await context.sendActivity(`🤖 ${text}`);
        } else if (result.kind === "task") {
            await context.sendActivity(`🎯 Task: ${result.id} (${result.status.state})`);
            
            // Display artifacts if available
            if (result.artifacts && result.artifacts.length > 0) {
                for (const artifact of result.artifacts) {
                    await context.sendActivity(`📎 ${artifact.name || artifact.artifactId}`);
                    if (artifact.parts) {
                        for (const part of artifact.parts) {
                            if (part.kind === "text") {
                                await context.sendActivity(`📄 ${part.text}`);
                            } else if (part.kind === "file") {
                                await context.sendActivity(`🗂️ File: ${part.filename || 'unnamed'}`);
                            }
                        }
                    }
                }
            }
            
            // Display status message if available
            if (result.status.message) {
                await context.sendActivity(`ℹ️ ${result.status.message}`);
            }
            
            // Note: Task polling removed due to A2A SDK body read limitations
            if (result.status.state !== "completed" && result.status.state !== "failed" && result.status.state !== "canceled") {
                await context.sendActivity(`⏳ Task is ${result.status.state}. The agent will notify when complete.`);
            }
        }
    }

    /**
     * Override the ActivityHandler.run() method to save state changes after the bot logic completes.
     * @param {TurnContext} context - The context object for the turn.
     */
    async run(context) {
        await super.run(context);

        // Save any state changes. The load happened during the execution of the Dialog.
        await this.conversationState.saveChanges(context, false);
        await this.userState.saveChanges(context, false);
    }
}

module.exports.DialogBot = DialogBot;