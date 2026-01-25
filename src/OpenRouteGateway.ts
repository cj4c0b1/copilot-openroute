import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { ThinkingAdapter } from './logic/ThinkingAdapter';
import { DeviceCodeManager } from './logic/DeviceCodeManager';
import { ToolRegistry } from './logic/ToolRegistry';

interface OpenAIMessage {
    role: string;
    content: string;
}

interface OpenAIRequest {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    tools?: any[];
}

import * as vscode from 'vscode';

export class OpenRouteGateway {
    private server: http.Server;
    private client?: CopilotClient;
    private gatewayPort: number;
    private extensionPath: string;
    private output?: vscode.OutputChannel;
    private _isRunning: boolean = false;
    private _onDidChangeStatus = new vscode.EventEmitter<void>();
    public readonly onDidChangeStatus = this._onDidChangeStatus.event;
    private executablePath: string | null = null;

    constructor(port: number, extensionPath: string, output?: vscode.OutputChannel) {
        this.gatewayPort = port;
        this.extensionPath = extensionPath;
        this.output = output;

        this.initClient();
        this.server = http.createServer(this.handleRequest.bind(this));
    }

    private log(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
        const timestamp = new Date().toISOString();
        const formattedMsg = `[Gateway][${level.toUpperCase()}][${timestamp}] ${msg}`;

        // Always console
        if (level === 'error') console.error(formattedMsg);
        else if (level === 'warn') console.warn(formattedMsg);
        else console.log(formattedMsg);

        // Output channel if available
        if (this.output) {
            this.output.appendLine(formattedMsg);
        }
    }



    public async getModels(): Promise<string[]> {
        const models = new Set<string>();

        // 1. GitHub Copilot (Primary)
        if (this.client && this._isRunning) {
            try {
                this.log('Fetching models from Copilot SDK...');
                const copilotModels = await this.client.listModels();
                this.log(`Received ${copilotModels.length} models from Copilot SDK: ${copilotModels.map((m: any) => m.id).join(', ')}`);
                copilotModels.forEach((m: any) => {
                    models.add(m.id);
                });
            } catch (e) {
                this.log(`Failed to list Copilot models: ${e}`, 'error');
            }
        }

        // 2. Future Providers (e.g. Ollama, OpenRouter) can be added here
        // await this.fetchOllamaModels(models);

        // 3. Fallbacks if absolutely nothing found
        if (models.size === 0) {
            return ['gpt-4', 'gpt-3.5-turbo'];
        }

        return Array.from(models);
    }

    public getStatus() {
        return {
            running: this._isRunning,
            port: this.gatewayPort,
            executablePath: this.executablePath
        };
    }

    public async login(): Promise<string> {
        // Delegate to startLoginFlow which handles the interactive notification
        throw new Error("Use `startLoginFlow` instead.");
    }

    public async startLoginFlow(): Promise<{ userCode: string, verificationUri: string, expiresIn: number, pollingPromise: Promise<void> }> {
        const clientId = vscode.workspace.getConfiguration('openroute.auth').get<string>('clientId');
        const manager = new DeviceCodeManager(clientId);

        const codeResp = await manager.requestDeviceCode();

        const pollingPromise = (async () => {
            const tokenResp = await manager.pollForToken(codeResp.device_code, codeResp.interval);
            if (tokenResp.access_token) {
                this.log('Token received, updating client...');
                this.setToken(tokenResp.access_token);

                // Restart everything to pick up the new token
                const wasRunning = this._isRunning;
                if (wasRunning) {
                    this.log('Restarting gateway to apply new token...');
                    await this.stop();
                }

                this.initClient();

                if (wasRunning) {
                    await this.start();
                    this.log('Gateway restarted successfully with new token.');
                }
            }
        })();

        return {
            userCode: codeResp.user_code,
            verificationUri: codeResp.verification_uri,
            expiresIn: codeResp.expires_in,
            pollingPromise
        };
    }

    private githubToken?: string;

    public setToken(token: string) {
        this.githubToken = token;
        // Ideally save to secrets, but for now memory as per plan
    }

    private initClient() {
        // Resolve Copilot binary path
        const binaryPath = this.resolveBinaryPath(this.extensionPath);

        if (binaryPath) {
            this.log(`Using Copilot binary at: ${binaryPath}`);
            const env = { ...process.env };
            if (this.githubToken) {
                this.log('Injecting COPILOT_GITHUB_TOKEN and GITHUB_TOKEN');
                env['COPILOT_GITHUB_TOKEN'] = this.githubToken;
                env['GITHUB_TOKEN'] = this.githubToken;
            }

            this.client = new CopilotClient({
                cliPath: binaryPath,
                logLevel: 'debug',
                env // Inject token
            });
        } else {
            this.log('Copilot binary not found. Waiting for manual start or installation.', 'warn');
            // Client remains undefined, start() will handle this
            this.client = undefined as any;
        }
    }

    private mapOpenAIToolsToSDK(tools: any[], threadId: string): any[] {
        return tools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            handler: async (args: any, invocation: any) => {
                this.log(`Tool ${t.function.name} called by SDK for thread ${threadId}. Triggering trap...`);
                return ToolRegistry.getInstance().createToolTrap(threadId, invocation.toolCallId);
            }
        }));
    }

    private resolveBinaryPath(extensionPath: string): string | null {
        // 0. Check Configuration
        const configPath = vscode.workspace.getConfiguration('openroute.server').get<string>('executablePath');
        if (configPath && fs.existsSync(configPath)) {
            this.executablePath = configPath;
            return configPath;
        }

        const platform = os.platform();
        let binaryName = 'copilot';
        let packagePlatform = '';

        switch (platform) {
            case 'win32':
                binaryName = 'copilot.exe';
                packagePlatform = 'copilot-win32-x64';
                break;
            case 'darwin':
                binaryName = 'copilot';
                packagePlatform = 'copilot-darwin-x64';
                if (os.arch() === 'arm64') packagePlatform = 'copilot-darwin-arm64';
                break;
            case 'linux':
                binaryName = 'copilot';
                packagePlatform = 'copilot-linux-x64';
                break;
        }

        // 1. Try node_modules (Dev environment)
        const devPath = path.join(extensionPath, 'node_modules', '@github', packagePlatform, binaryName);
        if (fs.existsSync(devPath)) {
            this.executablePath = devPath;
            return devPath;
        }

        // 2. Try dist (Production environment - assumes we copy it there)
        const prodPath = path.join(extensionPath, 'dist', binaryName);
        if (fs.existsSync(prodPath)) {
            this.executablePath = prodPath;
            return prodPath;
        }

        // 3. Last Attempted Path for Error Messages
        this.executablePath = configPath || devPath;

        return null;
    }

    public async start(retryCount = 0): Promise<void> {
        const MAX_RETRIES = 10;

        if (this._isRunning || this.server.listening) {
            this.log('Server already running');
            return;
        }

        if (!this.client) {
            // Try to re-initialize in case it was installed recently
            this.initClient();
        }

        if (!this.client) {
            throw new Error(`Copilot CLI binary not found at: ${this.executablePath || 'default locations'}. Please install.`);
        }

        // Start Copilot SDK client (spawns CLI) - Only if not already started
        try {
            // Note: The SDK might not have an easy way to check if started, 
            // but usually calling it again is either a no-op or we can wrap it.
            // Since we want to only start the SDK once even if we retry ports:
            if (retryCount === 0) {
                await this.client.start();
                this.log('Copilot SDK Client started');
            }
        } catch (err) {
            this.log(`Failed to start Copilot SDK Client: ${err}`, 'error');
            // Verify if it was a spawn error
            if ((err as any).code === 'ENOENT') {
                throw new Error('Copilot CLI executable not found in PATH.');
            }
            throw err;
        }

        return new Promise((resolve, reject) => {
            const onError = (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    if (retryCount < MAX_RETRIES) {
                        this.log(`Port ${this.gatewayPort} is in use, trying ${this.gatewayPort + 1}...`, 'warn');
                        this.gatewayPort++;
                        this.server.removeListener('error', onError);
                        resolve(this.start(retryCount + 1));
                    } else {
                        this.log(`Failed to find an available port after ${MAX_RETRIES} attempts.`, 'error');
                        reject(err);
                    }
                } else {
                    reject(err);
                }
            };

            this.server.once('error', onError);

            this.server.listen(this.gatewayPort, () => {
                this.server.removeListener('error', onError);
                this.log(`HTTP Server listening on port ${this.gatewayPort}`);
                this._isRunning = true;
                this._onDidChangeStatus.fire();
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        if (this.client) {
            await this.client.stop();
        }
        // Abort any pending rate-limited requests when stopping

        return new Promise((resolve) => {
            this.server.closeAllConnections(); // Node 18.2+
            this.server.close(() => {
                this._isRunning = false;
                this._onDidChangeStatus.fire();
                resolve();
            });
        });
    }

    private async handleListModels(req: http.IncomingMessage, res: http.ServerResponse) {
        try {
            const models = await this.getModels();
            const response = {
                object: 'list',
                data: models.map(id => ({
                    id,
                    object: 'model',
                    created: Date.now(),
                    owned_by: 'copilot-openroute'
                }))
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: String(e) } }));
        }
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/v1/chat/completions') {
            await this.handleChatCompletions(req, res);
        } else if (req.method === 'GET' && req.url === '/v1/models') {
            await this.handleListModels(req, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not Found' } }));
        }
    }

    private async handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
        const bodyBuffer: Buffer[] = [];
        for await (const chunk of req) {
            bodyBuffer.push(chunk);
        }
        const bodyStr = Buffer.concat(bodyBuffer).toString();
        let body: OpenAIRequest;

        try {
            body = JSON.parse(bodyStr);
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
            return;
        }

        this.log(`Incoming request paths: ${body.messages.map(m => m.role).join(' -> ')}`);

        // Extract System Prompt and Last User Message
        const systemMessage = body.messages.find(m => m.role === 'system');
        // Find last user message
        const userMessage = [...body.messages].reverse().find(m => m.role === 'user');

        if (!userMessage) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No user message found' } }));
            return;
        }

        // Rate limiting removed in favor of upstream handling
        try {
            this.log(`Received request for model: ${body.model} (stream: ${!!body.stream})`);

            try {
                if (!this.client) throw new Error('Copilot SDK Client not initialized');

                // 1. Determine Thread/Session
                let activeSession: CopilotSession | undefined;
                let threadId: string | undefined;

                let isToolResume = false;
                const lastMessage = body.messages[body.messages.length - 1] as any;
                if (lastMessage.role === 'tool') {
                    const toolCallId = lastMessage.tool_call_id;
                    this.log(`Detected tool result for ${toolCallId}. Looking for suspended thread...`);

                    if (toolCallId.includes(':')) {
                        const tid = toolCallId.split(':')[0];
                        const thread = ToolRegistry.getInstance().getThread(tid);
                        if (thread) {
                            this.log(`Found suspended thread ${tid}. Preparation for resolution...`);
                            activeSession = thread.session;
                            threadId = tid;
                            isToolResume = true;
                        }
                    }
                }

                if (!activeSession) {
                    this.log('Creating fresh session for request');
                    threadId = 'thread_' + Math.random().toString(36).substring(2, 10);
                    activeSession = await this.client.createSession({
                        model: body.model || 'gpt-4',
                        systemMessage: systemMessage ? {
                            mode: 'replace',
                            content: systemMessage.content
                        } : undefined,
                        tools: body.tools ? this.mapOpenAIToolsToSDK(body.tools, threadId) : undefined
                    });
                    ToolRegistry.getInstance().registerThread(threadId, activeSession);
                }

                const session = activeSession!;

                if (body.stream) {
                    res.writeHead(200, {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    });

                    // Initialize Thinking Adapter
                    const thinkingAdapter = new ThinkingAdapter();

                    session.on(event => {
                        const evt = event as any;
                        this.log(`Session event: ${evt.type}`, 'info');

                        if (evt.type === 'assistant.message_delta') {
                            const data = evt.data;
                            const content = data.content;
                            const reasoning = data.reasoning_content;

                            const sseChunks = thinkingAdapter.processDelta(
                                threadId!,
                                body.model,
                                { content, reasoning_content: reasoning }
                            );

                            sseChunks.forEach(chunk => res.write(chunk));
                        } else if (evt.type === 'assistant.message') {
                            this.log('Assistant message complete');

                            // 1. Check for Tool Requests
                            const toolRequests = (evt.data as any)?.toolRequests;
                            if (toolRequests && toolRequests.length > 0) {
                                this.log(`Model requested ${toolRequests.length} tools`);
                                const chunk = {
                                    id: 'chatcmpl-' + threadId,
                                    object: 'chat.completion.chunk',
                                    created: Date.now(),
                                    model: body.model,
                                    choices: [{
                                        index: 0,
                                        delta: {
                                            tool_calls: toolRequests.map((tr: any) => ({
                                                id: `${threadId}:${tr.toolCallId}`,
                                                type: 'function',
                                                function: {
                                                    name: tr.name,
                                                    arguments: typeof tr.arguments === 'string' ? tr.arguments : JSON.stringify(tr.arguments)
                                                }
                                            }))
                                        },
                                        finish_reason: 'tool_calls'
                                    }]
                                };
                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                                res.write('data: [DONE]\n\n');
                                res.end();

                                return;
                            }

                            // 2. Regular Content
                            const content = (evt.data as any)?.content;
                            if (content) {
                                this.log(`Emitting buffered content (${content.length} chars)`);
                                const chunk = {
                                    id: 'chatcmpl-' + threadId,
                                    object: 'chat.completion.chunk',
                                    created: Date.now(),
                                    model: body.model,
                                    choices: [{
                                        index: 0,
                                        delta: { content },
                                        finish_reason: null
                                    }]
                                };
                                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                            }

                            // Done
                            const stopChunk = {
                                id: 'chatcmpl-' + threadId,
                                object: 'chat.completion.chunk',
                                created: Date.now(),
                                model: body.model,
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    finish_reason: 'stop'
                                }]
                            };
                            res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                            res.write('data: [DONE]\n\n');
                            res.end();

                        } else if (evt.type === 'session.error') {
                            this.log(`Session error event: ${JSON.stringify(evt.data)}`, 'error');
                            if (!res.headersSent) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ error: { message: evt.data?.message || 'SDK Error' } }));
                            } else {
                                res.end();
                            }

                        } else {
                            const noisyEvents = ['pending_messages.modified', 'user.message', 'assistant.turn_start', 'assistant.turn_end', 'session.usage_info', 'assistant.usage', 'session.idle', 'assistant.message_delta', 'assistant.reasoning_delta'];
                            if (!noisyEvents.includes(evt.type)) {
                                this.log(`Unhandled session event: ${evt.type}`, 'info');
                            }
                        }
                    });

                    if (isToolResume) {
                        const lastMsg = body.messages[body.messages.length - 1] as any;
                        const [, cid] = lastMsg.tool_call_id.split(':');
                        this.log(`Resuming session ${threadId} by resolving tool ${cid}`);
                        ToolRegistry.getInstance().resolveTool(threadId!, cid, lastMsg.content);
                    } else {
                        await session.send({ prompt: userMessage.content, mode: 'immediate' });
                    }
                } else {
                    // Non-streaming
                    this.log(`Sending non-streaming request to SDK: ${userMessage.content.substring(0, 50)}...`);
                    let response: any;
                    if (isToolResume) {
                        const lastMsg = body.messages[body.messages.length - 1] as any;
                        const [, cid] = lastMsg.tool_call_id.split(':');
                        this.log(`Resuming session ${threadId} (non-streaming) by resolving tool ${cid}`);

                        // For non-streaming, we must wait for the next assistant message.
                        // We use the same listener pattern but wrap it in a promise.
                        response = await new Promise((resolve) => {
                            const unsub = session.on(evt => {
                                if (evt.type === 'assistant.message' || evt.type === 'session.error') {
                                    unsub();
                                    resolve(evt);
                                }
                            });
                            ToolRegistry.getInstance().resolveTool(threadId!, cid, lastMsg.content);
                        });
                    } else {
                        response = await session.sendAndWait({ prompt: userMessage.content });
                    }
                    this.log(`Received SDK response type: ${response?.type}`);

                    if (response && response.type === 'assistant.message') {
                        const toolRequests = (response.data as any).toolRequests;
                        if (toolRequests && toolRequests.length > 0) {
                            const result = {
                                id: 'chatcmpl-' + threadId,
                                object: 'chat.completion',
                                created: Date.now(),
                                model: body.model,
                                choices: [{
                                    index: 0,
                                    message: {
                                        role: 'assistant',
                                        content: null,
                                        tool_calls: toolRequests.map((tr: any) => ({
                                            id: `${threadId}:${tr.toolCallId}`,
                                            type: 'function',
                                            function: {
                                                name: tr.name,
                                                arguments: typeof tr.arguments === 'string' ? tr.arguments : JSON.stringify(tr.arguments)
                                            }
                                        }))
                                    },
                                    finish_reason: 'tool_calls'
                                }],
                                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                            };
                            this.log(`Returning tool call JSON response`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(result));
                        } else {
                            const result = {
                                id: 'chatcmpl-' + threadId,
                                object: 'chat.completion',
                                created: Date.now(),
                                model: body.model,
                                choices: [{
                                    index: 0,
                                    message: {
                                        role: 'assistant',
                                        content: (response as any).data.content
                                    },
                                    finish_reason: 'stop'
                                }],
                                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
                            };
                            this.log(`Returning JSON response (${result.choices[0].message.content?.length || 0} chars)`);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify(result));
                        }
                    } else {
                        const anyResponse = response as any;
                        const errorMsg = anyResponse?.type === 'error' ? anyResponse.data?.message : 'No response from Copilot';
                        this.log(`Failed to get assistant message: ${errorMsg}. Response type: ${anyResponse?.type}`, 'warn');
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: { message: errorMsg } }));
                    }

                }

            } catch (err) {
                this.log(`Exception in session execution: ${err}`, 'error');

                throw err;
            }

        } catch (error) {
            this.log(`Error in handleChatCompletions: ${error}`, 'error');
            const msg = error instanceof Error ? error.message : String(error);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: msg } }));
            }
        }
    }
}
