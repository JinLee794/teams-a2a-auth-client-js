// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
require('isomorphic-fetch'); // Polyfill for fetch in Node.js environment

const { 
    A2AClient, 
    AuthenticationHandler, 
    createAuthenticatingFetchWithRetry 
} = require("@a2a-js/sdk/client");

const { ConfirmPrompt, DialogSet, DialogTurnStatus, OAuthPrompt, WaterfallDialog, TextPrompt } = require('botbuilder-dialogs');
const { LogoutDialog } = require('./logoutDialog');
const { CardFactory, MessageFactory } = require('botbuilder-core');

const CONFIRM_PROMPT = 'ConfirmPrompt';
const TEXT_PROMPT = 'TextPrompt';
const MAIN_DIALOG = 'MainDialog';
const MAIN_WATERFALL_DIALOG = 'MainWaterfallDialog';
const OAUTH_PROMPT = 'OAuthPrompt';

/**
 * MainDialog class extends LogoutDialog to handle the main dialog flow.
 */
class MainDialog extends LogoutDialog {
    /**
     * Creates an instance of MainDialog.
     * @param {string} connectionName - The connection name for the OAuth provider.
     */
    constructor() {
        super(MAIN_DIALOG, process.env.connectionName);
        console.log('Connection name:', process.env.connectionName);
        this.addDialog(new OAuthPrompt(OAUTH_PROMPT, {
            connectionName: process.env.connectionName,
            text: 'Please Sign In',
            title: 'Sign In',
            timeout: 300000
        }));
        this.addDialog(new ConfirmPrompt(CONFIRM_PROMPT));
        this.addDialog(new TextPrompt(TEXT_PROMPT));
        this.addDialog(new WaterfallDialog(MAIN_WATERFALL_DIALOG, [
            this.promptStep.bind(this),
            this.loginStep.bind(this),
            this.ensureOAuth.bind(this),
            this.displayToken.bind(this),
            this.queryMessageStep.bind(this),
            this.handleQueryResponse.bind(this)
        ]));

        this.initialDialogId = MAIN_WATERFALL_DIALOG;
    }

    /**
     * The run method handles the incoming activity (in the form of a DialogContext) and passes it through the dialog system.
     * If no dialog is active, it will start the default dialog.
     * @param {TurnContext} context - The context object for the turn.
     * @param {StatePropertyAccessor} accessor - The state property accessor for the dialog state.
     */
    async run(context, accessor) {
        // Restore A2A client and token from conversation state if available
        await this.restoreA2AState(context);

        const dialogSet = new DialogSet(accessor);
        dialogSet.add(this);
        const dialogContext = await dialogSet.createContext(context);
        const results = await dialogContext.continueDialog();
        if (results.status === DialogTurnStatus.empty) {
            await dialogContext.beginDialog(this.id);
        }

        // Persist A2A client and token to conversation state
        await this.persistA2AState(context);
    }

    /**
     * Prompts the user to sign in.
     * @param {WaterfallStepContext} stepContext - The waterfall step context.
     */
    async promptStep(stepContext) {
        // Check if we're continuing a conversation
        if (stepContext.options && stepContext.options.continueConversation) {
            return await stepContext.next(); // Skip to login step
        }
        return await stepContext.beginDialog(OAUTH_PROMPT);
    }

    /**
     * Handles the login step.
     * @param {WaterfallStepContext} stepContext - The waterfall step context.
     */
    async loginStep(stepContext) {
        // Check if we're continuing a conversation and already have tokens
        if (stepContext.options && stepContext.options.continueConversation) {
            const existingToken = stepContext.context.turnState.get('accessToken');
            if (existingToken) {
                return await stepContext.next(); // Skip to ensureOAuth
            }
        }

        // Get the token from the previous step. Note that we could also have gotten the
        // token directly from the prompt itself. There is an example of this in the next method.
        const tokenResponse = stepContext.result;
        if (tokenResponse) {
            await stepContext.context.sendActivity('You are now logged in.');

            // Store the access token for use with A2A client
            stepContext.context.turnState.set('accessToken', tokenResponse.token);

            // Create A2A client with authentication
            await this.createA2AClientWithAuth(tokenResponse.token, stepContext);

            return await stepContext.prompt(CONFIRM_PROMPT, 'Would you like to establish a connection to the agent?');
            // return await stepContext.prompt(CONFIRM_PROMPT, 'Would you like to view your token?');
        }
        await stepContext.context.sendActivity('Login was not successful please try again.');
        return await stepContext.endDialog();
    }

    /**
     * Creates an A2A client with authentication using the access token
     * @param {string} accessToken - The access token from the login step
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async createA2AClientWithAuth(accessToken, stepContext) {
        try {
            // Create an authentication handler that adds the Bearer token
            const authHandler = {
                // Add authorization header to every request
                headers: async () => ({
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                }),

                // Handle token refresh if needed (401 responses)
                shouldRetryWithHeaders: async (req, res) => {
                    if (res.status === 401) {
                        // In a real scenario, you might want to refresh the token here
                        // For now, we'll just return undefined to not retry
                        await stepContext.context.sendActivity('Authentication failed. Token may have expired. Please login again.');
                        return undefined;
                    }
                    return undefined;
                },
            };

            // Create the authenticated fetch function
            const authFetch = createAuthenticatingFetchWithRetry(fetch, authHandler);

            // Use the existing agent endpoint configuration or fallback to default
            // You can add A2A_AGENT_CARD_URL to your .env file pointing to your A2A agent's card URL
            const a2aServerUrl = process.env.A2A_AGENT_CARD_URL || 
                                process.env.AgentEndpointURL + "/.well-known/agent-card.json" || 
                                "http://localhost:4000/.well-known/agent-card.json";
            
            console.log(`Configuring A2A client for: ${a2aServerUrl}`);
            
            // Create A2A client with authenticated fetch
            const a2aClient = await A2AClient.fromCardUrl(a2aServerUrl, { fetchImpl: authFetch });
            
            // Get agent card details
            const agentCard = await a2aClient.getAgentCard();
            
            // Store the client, agent card, and server URL for later use
            stepContext.context.turnState.set('a2aClient', a2aClient);
            stepContext.context.turnState.set('agentCard', agentCard);
            stepContext.context.turnState.set('a2aServerUrl', a2aServerUrl);
            
            // Display agent card in adaptive card format
            await this.displayAgentCard(agentCard, stepContext);
            
            await stepContext.context.sendActivity(`✅ A2A client configured with authentication for: ${a2aServerUrl}`);
            
        } catch (error) {
            console.error('Error creating A2A client:', error);
            await stepContext.context.sendActivity(`❌ Error configuring A2A client: ${error.message}. Please ensure the A2A server is running and accessible.`);
        }
    }

    /**
     * Restores A2A state from conversation state
     * @param {TurnContext} context - The turn context
     */
    async restoreA2AState(context) {
        try {
            const conversationState = context.turnState.get('conversationState');
            if (!conversationState) return;

            const a2aStateProperty = conversationState.createProperty('a2aState');
            const a2aState = await a2aStateProperty.get(context, {});

            if (a2aState.accessToken && a2aState.a2aServerUrl) {
                // Restore access token
                context.turnState.set('accessToken', a2aState.accessToken);
                context.turnState.set('a2aServerUrl', a2aState.a2aServerUrl);
                
                // Recreate A2A client
                const authHandler = {
                    headers: async () => ({
                        Authorization: `Bearer ${a2aState.accessToken}`,
                        'Content-Type': 'application/json',
                    }),
                    shouldRetryWithHeaders: async (req, res) => {
                        if (res.status === 401) {
                            return undefined;
                        }
                        return undefined;
                    },
                };

                const authFetch = createAuthenticatingFetchWithRetry(fetch, authHandler);
                const a2aClient = await A2AClient.fromCardUrl(a2aState.a2aServerUrl, { fetchImpl: authFetch });
                const agentCard = await a2aClient.getAgentCard();

                context.turnState.set('a2aClient', a2aClient);
                context.turnState.set('agentCard', agentCard);
            }
        } catch (error) {
            console.error('Error restoring A2A state:', error);
            // Don't throw - just continue without restored state
        }
    }

    /**
     * Persists A2A state to conversation state
     * @param {TurnContext} context - The turn context
     */
    async persistA2AState(context) {
        try {
            const conversationState = context.turnState.get('conversationState');
            if (!conversationState) return;

            const accessToken = context.turnState.get('accessToken');
            const a2aServerUrl = context.turnState.get('a2aServerUrl');

            if (accessToken && a2aServerUrl) {
                const a2aStateProperty = conversationState.createProperty('a2aState');
                await a2aStateProperty.set(context, {
                    accessToken,
                    a2aServerUrl
                });
            }
        } catch (error) {
            console.error('Error persisting A2A state:', error);
            // Don't throw - just continue
        }
    }

    /**
     * Ensures the OAuth token is available.
     * @param {WaterfallStepContext} stepContext - The waterfall step context.
     */
    async ensureOAuth(stepContext) {
        // Check if we're continuing a conversation
        if (stepContext.options && stepContext.options.continueConversation) {
            return await stepContext.next(); // Skip to displayToken
        }

        // await stepContext.context.sendActivity('Thank you.');

        const result = stepContext.result;
        if (result) {
            return await stepContext.beginDialog(OAUTH_PROMPT);
        }
        return await stepContext.endDialog();
    }

    /**
     * Displays the OAuth token to the user.
     * @param {WaterfallStepContext} stepContext - The waterfall step context.
     */
    async displayToken(stepContext) {
        // Check if we're continuing a conversation
        if (stepContext.options && stepContext.options.continueConversation) {
            return await stepContext.next(); // Skip to queryMessageStep
        }

        const tokenResponse = stepContext.result;
        if (tokenResponse && tokenResponse.token) {
            // await stepContext.context.sendActivity(`Here is your token: ${tokenResponse.token}`);
            
            // Demonstrate using the A2A client with authentication
            const a2aClient = stepContext.context.turnState.get('a2aClient');
            if (a2aClient) {
                await stepContext.context.sendActivity('🤖 A2A client is ready to make authenticated requests.');
                
                // // Example: Send a test message to the A2A agent
                // try {
                //     await this.testA2AConnection(a2aClient, stepContext);
                // } catch (error) {
                //     console.error('Error testing A2A connection:', error);
                //     await stepContext.context.sendActivity(`⚠️ Could not test A2A connection: ${error.message}`);
                // }
                
                // Proceed to message query step
                return await stepContext.next();
            }
        }
        return await stepContext.endDialog();
    }

    /**
     * Tests the A2A connection by sending a simple message
     * @param {A2AClient} a2aClient - The configured A2A client
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async testA2AConnection(a2aClient, stepContext) {
        const { v4: uuidv4 } = require('uuid');
        
        const sendParams = {
            message: {
                messageId: uuidv4(),
                role: "user",
                parts: [{ kind: "text", text: "Hello from Microsoft Teams bot! This is a test message with authenticated access." }],
                kind: "message",
            },
        };
        
        await stepContext.context.sendActivity('📤 Sending test message to A2A agent...');
        
        const response = await a2aClient.sendMessage(sendParams);
        
        if ("error" in response) {
            await stepContext.context.sendActivity(`❌ A2A Error: ${response.error.message}`);
        } else {
            const result = response.result;
            if (result.kind === "message") {
                await stepContext.context.sendActivity(`✅ A2A Response: ${result.parts[0].text}`);
            } else if (result.kind === "task") {
                await stepContext.context.sendActivity(`✅ A2A Task Created: ${result.id} (Status: ${result.status.state})`);
            } else {
                await stepContext.context.sendActivity(`✅ A2A Response received (Type: ${result.kind})`);
            }
        }
    }

    /**
     * Displays the agent card details in an adaptive card
     * @param {Object} agentCard - The agent card details
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async displayAgentCard(agentCard, stepContext) {
        const adaptiveCard = {
            type: "AdaptiveCard",
            version: "1.4",
            body: [
                {
                    type: "TextBlock",
                    text: "🤖 A2A Agent Details",
                    weight: "Bolder",
                    size: "Large",
                    color: "Accent"
                },
                {
                    type: "ColumnSet",
                    columns: [
                        {
                            type: "Column",
                            width: "auto",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: "**Name:**",
                                    weight: "Bolder"
                                }
                            ]
                        },
                        {
                            type: "Column",
                            width: "stretch",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: agentCard?.name || "Unknown Agent",
                                    wrap: true
                                }
                            ]
                        }
                    ]
                },
                {
                    type: "ColumnSet",
                    columns: [
                        {
                            type: "Column",
                            width: "auto",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: "**Description:**",
                                    weight: "Bolder"
                                }
                            ]
                        },
                        {
                            type: "Column",
                            width: "stretch",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: agentCard?.description || "No description available",
                                    wrap: true
                                }
                            ]
                        }
                    ]
                },
                {
                    type: "ColumnSet",
                    columns: [
                        {
                            type: "Column",
                            width: "auto",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: "**Version:**",
                                    weight: "Bolder"
                                }
                            ]
                        },
                        {
                            type: "Column",
                            width: "stretch",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: agentCard?.version || "Unknown",
                                    wrap: true
                                }
                            ]
                        }
                    ]
                },
                {
                    type: "ColumnSet",
                    columns: [
                        {
                            type: "Column",
                            width: "auto",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: "**Protocol:**",
                                    weight: "Bolder"
                                }
                            ]
                        },
                        {
                            type: "Column",
                            width: "stretch",
                            items: [
                                {
                                    type: "TextBlock",
                                    text: agentCard?.protocolVersion || "Unknown",
                                    wrap: true
                                }
                            ]
                        }
                    ]
                },
                {
                    type: "TextBlock",
                    text: "**Skills:**",
                    weight: "Bolder",
                    spacing: "Medium"
                },
                {
                    type: "Container",
                    items: agentCard?.skills?.map(skill => ({
                        type: "TextBlock",
                        text: `• **${skill.name}**: ${skill.description}`,
                        wrap: true
                    })) || [
                        {
                            type: "TextBlock",
                            text: "No skills information available",
                            isSubtle: true
                        }
                    ]
                }
            ]
        };

        const cardActivity = MessageFactory.attachment(CardFactory.adaptiveCard(adaptiveCard));
        await stepContext.context.sendActivity(cardActivity);
    }

    /**
     * Prompts the user to enter a message for the A2A agent
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async queryMessageStep(stepContext) {
        const promptMessage = MessageFactory.text('💬 Enter your message for the A2A agent (or type "exit" to end):');
        return await stepContext.prompt(TEXT_PROMPT, { prompt: promptMessage });
    }

    /**
     * Handles the user's query and polls for response
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async handleQueryResponse(stepContext) {
        const userMessage = stepContext.result;
        
        if (userMessage.toLowerCase() === 'exit') {
            await stepContext.context.sendActivity('👋 Goodbye! A2A session ended.');
            return await stepContext.endDialog();
        }

        const a2aClient = stepContext.context.turnState.get('a2aClient');
        if (!a2aClient) {
            await stepContext.context.sendActivity('❌ A2A client not available. Please restart the authentication process.');
            return await stepContext.endDialog();
        }

        try {
            await this.sendMessageWithPolling(a2aClient, userMessage, stepContext);
            
            // Continue the conversation - prompt for another message
            return await stepContext.replaceDialog(MAIN_WATERFALL_DIALOG, { 
                skipAuth: true,
                continueConversation: true 
            });
            
        } catch (error) {
            console.error('Error handling query response:', error);
            await stepContext.context.sendActivity(`❌ Error processing your message: ${error.message}`);
            return await stepContext.endDialog();
        }
    }

    /**
     * Sends a message to A2A agent and polls for response
     * @param {A2AClient} a2aClient - The A2A client
     * @param {string} userMessage - The user's message
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async sendMessageWithPolling(a2aClient, userMessage, stepContext) {
        const { v4: uuidv4 } = require('uuid');
        
        const sendParams = {
            message: {
                messageId: uuidv4(),
                role: "user",
                parts: [{ kind: "text", text: userMessage }],
                kind: "message",
            },
        };
        
        try {
            // Use streaming to handle all responses (messages and tasks)
            // This avoids the body consumption issue and provides real-time updates
            console.log('Agent: Using streaming response for real-time updates');
            await this.handleStreamingResponse(a2aClient, sendParams, stepContext);
            
        } catch (error) {
            throw new Error(`Failed to communicate with A2A agent: ${error.message}`);
        }
    }

    /**
     * Handles streaming response from A2A agent
     * @param {A2AClient} a2aClient - The A2A client
     * @param {Object} sendParams - The message parameters
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async handleStreamingResponse(a2aClient, sendParams, stepContext) {
        try {
            console.log('MainDialog: Starting streaming response...');
            
            // Send initial typing indicator
            await stepContext.context.sendActivity({ type: 'typing' });
            
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
                        await stepContext.context.sendActivity({ type: 'typing' });
                    } catch (error) {
                        console.log('MainDialog: Typing indicator failed:', error.message);
                    }
                }
            }, 2000); // Send typing every 2 seconds
            
            try {
                for await (const event of stream) {
                    receivedEvents = true;
                    console.log(`MainDialog: Received event:`, event.kind);
                    
                    if (event.kind === "message") {
                    // Direct message response
                    if (event.parts && event.parts[0]?.text) {
                        accumulatedText += event.parts[0].text;
                        updateCount++;
                        console.log('MainDialog: Accumulated message text');
                        
                        // Update or send the message in Teams
                        if (!messageActivity) {
                            // Send initial message
                            const response = await stepContext.context.sendActivity(`🤖 ${accumulatedText}`);
                            messageActivity = response;
                        } else if (updateCount % UPDATE_INTERVAL === 0) {
                            // Update existing message periodically for smooth streaming
                            try {
                                await stepContext.context.updateActivity({
                                    ...messageActivity,
                                    text: `🤖 ${accumulatedText}`,
                                    type: 'message'
                                });
                            } catch (updateError) {
                                console.log('MainDialog: Message update not supported, continuing...');
                            }
                        }
                    }
                } else if (event.kind === "task") {
                    // Initial task creation
                    currentTask = event;
                    console.log(`MainDialog: Task ${event.id} created with status: ${event.status.state}`);
                    
                    // Collect initial artifacts if present
                    if (event.artifacts && event.artifacts.length > 0) {
                        lastArtifacts = event.artifacts;
                    }
                } else if (event.kind === "status-update") {
                    // Task status changed
                    console.log(`MainDialog: Task status update: ${event.status.state}`);
                    if (currentTask) {
                        currentTask.status = event.status;
                    }
                    
                    // If task completed, stop typing indicator and send final update
                    if (event.status.state === "completed") {
                        console.log('MainDialog: Task completed, stopping typing indicator');
                        isCompleted = true;
                        clearInterval(typingInterval);
                        
                        if (accumulatedText && messageActivity) {
                            console.log('MainDialog: Sending final update');
                            try {
                                await stepContext.context.updateActivity({
                                    ...messageActivity,
                                    text: `🤖 ${accumulatedText}`,
                                    type: 'message'
                                });
                            } catch (updateError) {
                                console.log('MainDialog: Final update failed');
                            }
                        }
                    }
                } else if (event.kind === "artifact-update") {
                    // New artifact added to task
                    console.log(`MainDialog: Artifact update received`);
                    if (event.artifact && event.artifact.parts) {
                        // Collect artifact text
                        for (const part of event.artifact.parts) {
                            if (part.kind === "text" && part.text) {
                                accumulatedText += part.text;
                                updateCount++;
                                
                                // Update message with artifact text
                                if (!messageActivity) {
                                    const response = await stepContext.context.sendActivity(`🤖 ${accumulatedText}`);
                                    messageActivity = response;
                                } else if (updateCount % UPDATE_INTERVAL === 0) {
                                    try {
                                        await stepContext.context.updateActivity({
                                            ...messageActivity,
                                            text: `🤖 ${accumulatedText}`,
                                            type: 'message'
                                        });
                                    } catch (updateError) {
                                        console.log('MainDialog: Message update not supported');
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
            
            console.log(`MainDialog: Stream complete. Received events: ${receivedEvents}`);
            
            // Send or update the final response based on what we received
            if (accumulatedText) {
                // We have text content (either from message or artifacts)
                console.log('MainDialog: Sending final accumulated text to Teams');
                
                if (messageActivity) {
                    // Update with final text
                    try {
                        await stepContext.context.updateActivity({
                            ...messageActivity,
                            text: `🤖 ${accumulatedText}`,
                            type: 'message'
                        });
                    } catch (updateError) {
                        // If update fails, send as new message
                        await stepContext.context.sendActivity(`🤖 ${accumulatedText}`);
                    }
                } else {
                    // Send as new message if we never sent one
                    await stepContext.context.sendActivity(`🤖 ${accumulatedText}`);
                }
            } else if (currentTask) {
                // We have a task but no text content
                await stepContext.context.sendActivity(`🎯 Task ${currentTask.id}: ${currentTask.status.state}`);
                
                // Display artifacts if any
                if (lastArtifacts.length > 0) {
                    await this.displayTaskArtifacts(lastArtifacts, stepContext);
                }
                
                // Show status message if available
                if (currentTask.status.message) {
                    await stepContext.context.sendActivity(`ℹ️ ${currentTask.status.message}`);
                }
            } else if (!receivedEvents) {
                await stepContext.context.sendActivity('⚠️ No response received from agent.');
            }
            
            console.log('MainDialog: Response handling complete');
            
        } catch (error) {
            console.error('MainDialog: Streaming error:', error);
            // If streaming fails, fall back to regular response
            console.log('MainDialog: Falling back to regular response...');
            await this.handleRegularResponse(a2aClient, sendParams, stepContext);
        }
    }

    /**
     * Handles regular response with polling from A2A agent
     * @param {A2AClient} a2aClient - The A2A client
     * @param {Object} sendParams - The message parameters
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async handleRegularResponse(a2aClient, sendParams, stepContext) {
        console.log('MainDialog: Sending message to A2A agent...');
        
        // Send typing indicator
        await stepContext.context.sendActivity({ type: 'typing' });
        
        const response = await a2aClient.sendMessage(sendParams);
        console.log('MainDialog: Received response:', JSON.stringify(response).substring(0, 200));
        
        if ("error" in response) {
            console.error('MainDialog: A2A error:', response.error);
            throw new Error(response.error.message);
        }

        const result = response.result;
        console.log('MainDialog: Result kind:', result.kind);
        
        if (result.kind === "message") {
            const text = result.parts[0]?.text || 'No text content';
            console.log('MainDialog: Sending message to Teams:', text.substring(0, 100));
            await stepContext.context.sendActivity(`🤖 ${text}`);
        } else if (result.kind === "task") {
            console.log('MainDialog: Task created:', result.id, 'Status:', result.status.state);
            await stepContext.context.sendActivity(`🎯 Task: ${result.id} - ${result.status.state}`);
            
            // Display artifacts if available
            if (result.artifacts && result.artifacts.length > 0) {
                await this.displayTaskArtifacts(result.artifacts, stepContext);
            }
            
            // Display status message if available
            if (result.status.message) {
                await stepContext.context.sendActivity(`ℹ️ ${result.status.message}`);
            }
            
            // Note: Task polling removed due to A2A SDK body read limitations
            // If task is not complete, the agent should send updates via streaming or webhooks
            if (result.status.state !== "completed" && result.status.state !== "failed" && result.status.state !== "canceled") {
                await stepContext.context.sendActivity(`⏳ Task is ${result.status.state}. The agent will notify when complete.`);
            }
        }
        
        console.log('MainDialog: Response handling complete');
    }



    /**
     * Displays task artifacts
     * @param {Array} artifacts - The task artifacts
     * @param {WaterfallStepContext} stepContext - The waterfall step context
     */
    async displayTaskArtifacts(artifacts, stepContext) {
        for (const artifact of artifacts) {
            await stepContext.context.sendActivity(`📎 **${artifact.name || artifact.artifactId}**`);
            
            if (artifact.parts) {
                for (const part of artifact.parts) {
                    if (part.kind === "text") {
                        await stepContext.context.sendActivity(`📄 ${part.text}`);
                    } else if (part.kind === "file") {
                        await stepContext.context.sendActivity(`🗂️ File: ${part.filename || 'unnamed file'}`);
                    }
                }
            }
        }
    }
}

module.exports.MainDialog = MainDialog;