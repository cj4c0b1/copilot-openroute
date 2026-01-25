import * as http from "http";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import * as crypto from "crypto";
import { fileURLToPath } from "node:url";
import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import { ThinkingAdapter } from "./logic/ThinkingAdapter";
import { DeviceCodeManager } from "./logic/DeviceCodeManager";
import { ToolRegistry } from "./logic/ToolRegistry";

interface OpenAIMessage {
  role: string;
  content: string | any[];
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  tools?: any[];
}

import * as vscode from "vscode";

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

  constructor(
    port: number,
    extensionPath: string,
    output?: vscode.OutputChannel,
  ) {
    this.gatewayPort = port;
    this.extensionPath = extensionPath;
    this.output = output;

    this.initClient();
    this.server = http.createServer(this.handleRequest.bind(this));
  }

  private log(msg: string, level: "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toISOString();
    const formattedMsg = `[Gateway][${level.toUpperCase()}][${timestamp}] ${msg}`;

    // Always console
    if (level === "error") console.error(formattedMsg);
    else if (level === "warn") console.warn(formattedMsg);
    else console.log(formattedMsg);

    // Output channel if available
    if (this.output) {
      this.output.appendLine(formattedMsg);
    }
  }

  // Helper: Save base64 image or download URL to temp file for SDK
  private async processAttachments(
    content: any[],
  ): Promise<{ text: string; attachments: any[] }> {
    let text = "";
    const attachments: any[] = [];

    for (const part of content) {
      if (part.type === "text") {
        text += part.text + "\n";
      } else if (part.type === "image_url") {
        try {
          const imageUrl = part.image_url?.url;
          if (!imageUrl) {
            this.log(`Image part has no URL`, "warn");
            continue;
          }

          this.log(`Processing image: ${imageUrl.substring(0, 80)}...`, "info");

          let buffer: Buffer;
          let ext = "png";

          if (imageUrl.startsWith("data:")) {
            // Handle Base64 Data URI
            const matches = imageUrl.match(
              /^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/,
            );
            if (!matches) {
              this.log(`Invalid base64 data URI format`, "warn");
              continue;
            }
            ext = matches[1].replace('+', '');
            if (ext === 'jpeg') ext = 'jpg'; // Normalize jpeg -> jpg

            buffer = Buffer.from(matches[2], "base64");
            this.log(`Decoded base64 image: ${buffer.length} bytes, ext: ${ext}`, "info");
          } else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
            // Handle remote URL - download it
            this.log(`Downloading remote image: ${imageUrl}`, "info");
            try {
              buffer = await this.downloadImage(imageUrl);
              // Try to detect extension from URL
              const urlPath = new URL(imageUrl).pathname;
              const urlExt = urlPath.split('.').pop()?.toLowerCase();
              if (urlExt && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(urlExt)) {
                ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
              }
              this.log(`Downloaded image: ${buffer.length} bytes`, "info");
            } catch (downloadErr) {
              this.log(`Failed to download image: ${downloadErr}`, "error");
              continue;
            }
          } else if (imageUrl.startsWith("file://") || imageUrl.match(/^[a-zA-Z]:\\/)) {
            // Handle local file path
            let filePath = imageUrl;
            if (imageUrl.startsWith("file://")) {
              try {
                filePath = fileURLToPath(imageUrl);
              } catch (e) {
                // Fallback strip if fileURLToPath fails (shouldn't happens for valid URLs)
                filePath = imageUrl.replace("file://", "");
              }
            }

            this.log(`Reading local file: ${filePath}`, "info");
            try {
              buffer = await fs.promises.readFile(filePath);
              const fileExt = filePath.split('.').pop()?.toLowerCase();
              if (fileExt && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fileExt)) {
                ext = fileExt === 'jpeg' ? 'jpg' : fileExt;
              }
              this.log(`Read local file: ${buffer.length} bytes`, "info");
            } catch (readErr) {
              this.log(`Failed to read local file: ${readErr}`, "error");
              continue;
            }
          } else {
            this.log(`Unsupported image URL format: ${imageUrl.substring(0, 50)}`, "warn");
            continue;
          }

          // Ensure extension is safe
          if (!['png', 'jpg', 'gif', 'webp'].includes(ext)) {
            ext = 'png'; // Fallback
          }

          const tempFile = path.join(
            os.tmpdir(),
            `copilot_img_${crypto.randomUUID()}.${ext}`,
          ).replace(/\\/g, '/');
          await fs.promises.writeFile(tempFile, buffer);

          attachments.push({
            type: "file",
            path: tempFile,
          });
          this.log(`Saved image attachment: ${tempFile}`, "info");
        } catch (e) {
          this.log(`Failed to process image attachment: ${e}`, "error");
        }
      }
    }
    return { text: text.trim(), attachments };
  }

  // Helper: Download image from URL
  private async downloadImage(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith("https://") ? require("https") : require("http");

      protocol.get(url, { timeout: 30000 }, (response: any) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          this.downloadImage(response.headers.location).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      }).on("error", reject);
    });
  }

  // Helper: Format history for Context Stuffing
  private formatConversationHistory(messages: OpenAIMessage[]): string {
    return messages
      .map((m) => {
        let content = "";
        if (typeof m.content === "string") {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          // Simplify array content for history text
          content = m.content
            .map((c) => (c.type === "text" ? c.text : "[Image Attachment]"))
            .join(" ");
        }
        return `${m.role.toUpperCase()}: ${content}`;
      })
      .join("\n\n");
  }



  public async getModels(): Promise<string[]> {
    const models = new Set<string>();

    // 1. GitHub Copilot (Primary)
    if (this.client && this._isRunning) {
      try {
        this.log("Fetching models from Copilot SDK...");
        const copilotModels = await this.client.listModels();
        // Log RAW metadata for debugging vision/identity issues
        this.log(`DEBUG: RAW Copilot Models Meta: ${JSON.stringify(copilotModels, null, 2)}`);
        this.log(
          `Received ${copilotModels.length} models from Copilot SDK: ${copilotModels.map((m: any) => m.id).join(", ")}`,
        );
        copilotModels.forEach((m: any) => {
          models.add(m.id);
        });
      } catch (e) {
        this.log(`Failed to list Copilot models: ${e}`, "error");
      }
    }

    if (models.size === 0) {
      return ["gpt-4", "gpt-3.5-turbo"];
    }

    return Array.from(models);
  }

  public async getModelsWithCapabilities(): Promise<
    Array<{ id: string; tools: boolean; vision: boolean; thinking: boolean }>
  > {
    // Fetch raw models from SDK with full metadata
    if (!this.client || !this._isRunning) {
      return [];
    }

    try {
      const copilotModels = await this.client.listModels();

      return copilotModels.map((m: any) => {
        // Extract capabilities from SDK metadata
        const caps = m.capabilities || {};
        const id = m.id || "";

        // Detect thinking models
        const isThinking = id.toLowerCase().includes("thinking");

        // Detect vision capability from SDK metadata or model name patterns
        // Fix: Use correct 'supports.vision' from nested capabilities object
        const capsSupports = (caps as any).supports || {};
        const hasVision =
          capsSupports.vision === true ||
          id.includes("vision") ||
          id.includes("4o") ||
          id.includes("sonnet") ||
          id.includes("opus") ||
          id.includes("pro") ||
          id.includes("claude") ||
          id.includes("5.2") ||
          id.includes("4.5") ||
          id.includes("gemini");

        // GPT-5 mini and other text-only models explicitly don't have vision
        const isTextOnly =
          id.includes("3.5-turbo") ||
          id.includes("flash-lite") ||
          (id.includes("o1") && !id.includes("o1-mini-2024-09-12") && !id.includes("preview")); // o1-preview/mini might have it, but o1/o3-mini often dont in SDK contexts

        return {
          id,
          tools: true, // All models support tools via OpenAI format
          vision: hasVision && !isTextOnly,
          thinking: isThinking,
        };
      });
    } catch (e) {
      this.log(`Failed to fetch models with capabilities: ${e}`, "error");
      return [];
    }
  }

  public getStatus() {
    return {
      running: this._isRunning,
      port: this.gatewayPort,
      executablePath: this.executablePath,
    };
  }

  public async login(): Promise<string> {
    throw new Error("Use `startLoginFlow` instead.");
  }

  public async startLoginFlow(): Promise<{
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    pollingPromise: Promise<void>;
  }> {
    const clientId = vscode.workspace
      .getConfiguration("openroute.auth")
      .get<string>("clientId");
    const manager = new DeviceCodeManager(clientId);

    const codeResp = await manager.requestDeviceCode();

    const pollingPromise = (async () => {
      const tokenResp = await manager.pollForToken(
        codeResp.device_code,
        codeResp.interval,
      );
      if (tokenResp.access_token) {
        this.log("Token received, updating client...");
        this.setToken(tokenResp.access_token);

        const wasRunning = this._isRunning;
        if (wasRunning) {
          this.log("Restarting gateway to apply new token...");
          await this.stop();
        }

        this.initClient();

        if (wasRunning) {
          await this.start();
          this.log("Gateway restarted successfully with new token.");
        }
      }
    })();

    return {
      userCode: codeResp.user_code,
      verificationUri: codeResp.verification_uri,
      expiresIn: codeResp.expires_in,
      pollingPromise,
    };
  }

  private githubToken?: string;

  public setToken(token: string) {
    this.githubToken = token;
  }

  private initClient() {
    const binaryPath = this.resolveBinaryPath(this.extensionPath);

    if (binaryPath) {
      this.log(`Using Copilot binary at: ${binaryPath}`);
      const env = { ...process.env };
      if (this.githubToken) {
        this.log("Injecting COPILOT_GITHUB_TOKEN and GITHUB_TOKEN");
        env["COPILOT_GITHUB_TOKEN"] = this.githubToken;
        env["GITHUB_TOKEN"] = this.githubToken;
      }

      this.client = new CopilotClient({
        cliPath: binaryPath,
        logLevel: "debug",
        env,
      });
    } else {
      this.log(
        "Copilot binary not found. Waiting for manual start or installation.",
        "warn",
      );
      this.client = undefined as any;
    }
  }

  private mapOpenAIToolsToSDK(tools: any[], threadId: string): any[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      handler: async (args: any, invocation: any) => {
        this.log(
          `Tool ${t.function.name} called by SDK for thread ${threadId}. Triggering trap...`,
        );
        return ToolRegistry.getInstance().createToolTrap(
          threadId,
          invocation.toolCallId,
        );
      },
    }));
  }

  private resolveBinaryPath(extensionPath: string): string | null {
    const configPath = vscode.workspace
      .getConfiguration("openroute.server")
      .get<string>("executablePath");
    if (configPath && fs.existsSync(configPath)) {
      this.executablePath = configPath;
      return configPath;
    }

    const platform = os.platform();
    let binaryName = "copilot";
    let packagePlatform = "";

    switch (platform) {
      case "win32":
        binaryName = "copilot.exe";
        packagePlatform = "copilot-win32-x64";
        break;
      case "darwin":
        binaryName = "copilot";
        packagePlatform = "copilot-darwin-x64";
        if (os.arch() === "arm64") packagePlatform = "copilot-darwin-arm64";
        break;
      case "linux":
        binaryName = "copilot";
        packagePlatform = "copilot-linux-x64";
        break;
    }

    const devPath = path.join(
      extensionPath,
      "node_modules",
      "@github",
      packagePlatform,
      binaryName,
    );
    if (fs.existsSync(devPath)) {
      this.executablePath = devPath;
      return devPath;
    }

    const prodPath = path.join(extensionPath, "dist", binaryName);
    if (fs.existsSync(prodPath)) {
      this.executablePath = prodPath;
      return prodPath;
    }

    this.executablePath = configPath || devPath;
    return null;
  }

  public async start(retryCount = 0): Promise<void> {
    const MAX_RETRIES = 10;

    if (this._isRunning || this.server.listening) {
      this.log("Server already running");
      return;
    }

    if (!this.client) {
      this.initClient();
    }

    if (!this.client) {
      throw new Error(
        `Copilot CLI binary not found at: ${this.executablePath || "default locations"}. Please install.`,
      );
    }

    try {
      if (retryCount === 0) {
        await this.client.start();
        this.log("Copilot SDK Client started");
      }
    } catch (err) {
      this.log(`Failed to start Copilot SDK Client: ${err}`, "error");
      if ((err as any).code === "ENOENT") {
        throw new Error("Copilot CLI executable not found in PATH.");
      }
      throw err;
    }

    return new Promise((resolve, reject) => {
      const onError = (err: any) => {
        if (err.code === "EADDRINUSE") {
          if (retryCount < MAX_RETRIES) {
            this.log(
              `Port ${this.gatewayPort} is in use, trying ${this.gatewayPort + 1}...`,
              "warn",
            );
            this.gatewayPort++;
            this.server.removeListener("error", onError);
            resolve(this.start(retryCount + 1));
          } else {
            this.log(
              `Failed to find an available port after ${MAX_RETRIES} attempts.`,
              "error",
            );
            reject(err);
          }
        } else {
          reject(err);
        }
      };

      this.server.once("error", onError);

      this.server.listen(this.gatewayPort, () => {
        this.server.removeListener("error", onError);
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

    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => {
        this._isRunning = false;
        this._onDidChangeStatus.fire();
        resolve();
      });
    });
  }

  private async handleListModels(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    try {
      const models = await this.getModels();
      const response = {
        object: "list",
        data: models.map((id) => ({
          id,
          object: "model",
          created: Date.now(),
          owned_by: "copilot-openroute",
        })),
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      await this.handleChatCompletions(req, res);
    } else if (req.method === "GET" && req.url === "/v1/models") {
      await this.handleListModels(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not Found" } }));
    }
  }

  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const bodyBuffer: Buffer[] = [];
    for await (const chunk of req) {
      bodyBuffer.push(chunk);
    }
    const bodyStr = Buffer.concat(bodyBuffer).toString();
    let body: OpenAIRequest;

    try {
      body = JSON.parse(bodyStr);
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid JSON" } }));
      return;
    }

    this.log(
      `Incoming request paths: ${body.messages.map((m) => m.role).join(" -> ")}`,
    );

    // --- FIX 1: Context Management ---
    // Separate the messages into:
    // 1. System Message (if any)
    // 2. History (Messages 0 to N-1)
    // 3. New User Message (Message N)
    const systemMessage = body.messages.find((m) => m.role === "system");
    const historyMessages = body.messages.filter(
      (m) =>
        m.role !== "system" && m !== body.messages[body.messages.length - 1],
    );
    const lastMessage = body.messages[body.messages.length - 1];

    if (!lastMessage) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "No messages found" } }));
      return;
    }

    // --- Pre-compute Attachments & State ---
    let activeSession: CopilotSession | undefined;
    let threadId: string | undefined;
    let isToolResume = false;
    let promptText = "";
    let attachments: any[] | undefined = undefined;

    // Check for Tool Resume logic
    if (lastMessage.role === "tool" && (lastMessage as any).tool_call_id) {
      const toolCallId = (lastMessage as any).tool_call_id;
      if (toolCallId.includes(":")) {
        const tid = toolCallId.split(":")[0];
        const thread = ToolRegistry.getInstance().getThread(tid);
        if (thread) {
          activeSession = thread.session;
          threadId = tid;
          isToolResume = true;
        }
      }
    }

    // Process Content & Attachments (Scan ALL messages for images)
    const allAttachments: any[] = [];
    const seenImageUrls = new Set<string>();

    if (!isToolResume) {
      for (const msg of body.messages) {
        if (Array.isArray(msg.content)) {
          // Filter out images we've already processed in this request to avoid duplicates in tmp
          const uniqueContent = msg.content.filter(part => {
            if (part.type === 'image_url' && part.image_url?.url) {
              if (seenImageUrls.has(part.image_url.url)) return false;
              seenImageUrls.add(part.image_url.url);
            }
            return true;
          });

          const processed = await this.processAttachments(uniqueContent);
          if (processed.attachments.length > 0) {
            allAttachments.push(...processed.attachments);
          }

          if (msg === lastMessage) {
            promptText = processed.text;
          }
        } else if (msg === lastMessage) {
          promptText = msg.content;
        }
      }

      if (allAttachments.length > 0) {
        attachments = allAttachments;
        this.log(`Extracted ${attachments.length} unique image attachment(s) from conversation history`, "info");
      }
    } else {
      // If resuming (tool result), content is usually string result
      promptText = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
    }

    this.log(`Temp dir is: ${os.tmpdir()}`, "info");

    // --- FIX 1b: Context Stuffing ---
    // Since we create a fresh session for every stateless request, we must inject the history
    // into the System Prompt so the model "remembers" what happened.
    let fullSystemPrompt = systemMessage?.content
      ? (systemMessage.content as string)
      : "";

    // INJECT VISION HINT
    if (attachments && attachments.length > 0) {
      fullSystemPrompt += `\n\n[System: The user has attached ${attachments.length} image(s) to this request. Analysis of these images is required to answer the user's prompt correctly. Use your vision capabilities to examine the provided files.]`;
    }

    if (historyMessages.length > 0) {
      const formattedHistory = this.formatConversationHistory(historyMessages);
      fullSystemPrompt += `\n\n=== Conversation History ===\n${formattedHistory}\n=== End History ===\n`;
      fullSystemPrompt += `\n(Note: The above history is provided for context. You are responding to the USER message below.)`;
    }

    // If using append mode, we don't want to repeat the user's system message entirely if we can avoid it, 
    // but the SDK 'append' mode appends to the BASE instructions. So our 'content' becomes the bulk.
    const systemConfig: any = {
      mode: "append",
      content: fullSystemPrompt || "You are a helpful AI assistant.",
    };

    try {
      this.log(
        `Received request for model: ${body.model} (stream: ${!!body.stream})`,
      );

      try {
        if (!this.client) throw new Error("Copilot SDK Client not initialized");

        // Session Creation
        if (!activeSession) {
          this.log("Creating fresh session with injected context");
          threadId = "thread_" + Math.random().toString(36).substring(2, 10);

          activeSession = await this.client.createSession({
            model: body.model || "gpt-4",
            systemMessage: systemConfig,
            tools: body.tools
              ? this.mapOpenAIToolsToSDK(body.tools, threadId)
              : undefined,
            // CRITICAL: Permission handler is required to allow the SDK to read attachment files
            onPermissionRequest: async (request) => {
              this.log(`Permission request: ${JSON.stringify(request)}`, "info");
              return { kind: "approved" };
            },
          });
          ToolRegistry.getInstance().registerThread(threadId, activeSession);
        }

        const session = activeSession!;

        if (body.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const thinkingAdapter = new ThinkingAdapter();
          let eventReceived = false;

          session.on((event) => {
            const evt = event as any;
            eventReceived = true;

            this.log(`Session event received: ${evt.type}`, "info");

            // Log usage events to keep track
            if (["session.usage_info", "pending_messages.modified", "user.message"].includes(evt.type)) return;

            if (evt.type === "assistant.message_delta") {
              const data = evt.data;
              const sseChunks = thinkingAdapter.processDelta(
                threadId!,
                body.model,
                {
                  content: data.content,
                  reasoning_content: data.reasoning_content,
                },
              );
              sseChunks.forEach((chunk) => res.write(chunk));
            } else if (evt.type === "assistant.message") {
              try {
                this.log("Assistant message complete", "info");
                this.log(`evt.data: ${JSON.stringify(evt.data).substring(0, 500)}`, "info");

                // ... (Existing tool request handling logic) ...
                const toolRequests = (evt.data as any)?.toolRequests;
                if (toolRequests && toolRequests.length > 0) {
                  this.log(`Model requested ${toolRequests.length} tools`, "info");
                  // ... tool logic ...
                  const chunk = {
                    id: "chatcmpl-" + threadId,
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: toolRequests.map((tr: any) => ({
                            id: `${threadId}:${tr.toolCallId}`,
                            type: "function",
                            function: {
                              name: tr.name,
                              arguments:
                                typeof tr.arguments === "string"
                                  ? tr.arguments
                                  : JSON.stringify(tr.arguments),
                            },
                          })),
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  res.write("data: [DONE]\n\n");
                  res.end();
                  return;
                }

                // Regular content finish
                // Note: Delta events usually handle the content, so we just send stop here
                // unless 'content' was not streamed via deltas (which Copilot SDK sometimes does)
                const fullContent = (evt.data as any)?.content;
                this.log(`fullContent extracted: ${fullContent ? "Yes, length: " + fullContent.length : "No/undefined"}`, "info");

                if (fullContent) {
                  this.log(`Buffering full content from assistant.message: ${fullContent.substring(0, 100)}...`, "info");
                  const contentChunk = {
                    id: "chatcmpl-" + threadId,
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: fullContent,
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  this.log(`Writing content chunk to response`, "info");
                  res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
                } else {
                  this.log(`No content in assistant.message - sending only stop chunk`, "warn");
                }

                const stopChunk = {
                  id: "chatcmpl-" + threadId,
                  object: "chat.completion.chunk",
                  created: Date.now(),
                  model: body.model,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: "stop",
                    },
                  ],
                };
                this.log(`Writing stop chunk and [DONE]`, "info");
                res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
                this.log(`Response ended for thread ${threadId}`, "info");
              } catch (err) {
                this.log(`Error processing assistant.message: ${err}`, "error");
              }
            } else if (evt.type === "session.error") {
              this.log(`Session error: ${JSON.stringify(evt.data)}`, "error");
              if (!res.headersSent) {
                res.write(`data: {"error": "${evt.data?.message}"}\n\n`);
              }
              res.end();
            } else {
              // Log unhandled event types for debugging
              this.log(`Unhandled session event: ${evt.type}`, "info");
            }
          });

          if (isToolResume) {
            const lastMsg = body.messages[body.messages.length - 1] as any;
            const [, cid] = lastMsg.tool_call_id.split(":");
            this.log(
              `Resuming session ${threadId} by resolving tool ${cid}`,
              "info",
            );
            ToolRegistry.getInstance().resolveTool(
              threadId!,
              cid,
              lastMsg.content,
            );
          } else {
            // Send with attachments
            this.log(
              `Sending prompt to session: ${promptText.substring(0, 100)}...`,
              "info",
            );
            if (attachments) {
              this.log(`Attachments array: ${JSON.stringify(attachments)}`, "info");
            }
            await session.send({
              prompt: promptText,
              attachments: attachments, // Pass the processed images
              mode: "immediate",
            });
          }

          // Timeout handler - if no event received after 120 seconds, send error
          const timeoutHandle = setTimeout(() => {
            if (!eventReceived && !res.writableEnded) {
              this.log("Session timeout - no response received after 120s", "warn");
              if (!res.headersSent) {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
              }
              res.write(
                `data: {"error": "Gateway timeout - no response from Copilot SDK"}\n\n`,
              );
              res.end();
            }
          }, 120000);

          res.on("finish", () => clearTimeout(timeoutHandle));
        } else {
          // Non-streaming logic (Update similarly for attachments)
          this.log(`Sending non-streaming request...`);
          let response: any;

          if (isToolResume) {
            // ... Tool resume logic ...
            const lastMsg = body.messages[body.messages.length - 1] as any;
            const [, cid] = lastMsg.tool_call_id.split(":");
            response = await new Promise((resolve) => {
              const unsub = session.on((evt) => {
                if (
                  evt.type === "assistant.message" ||
                  evt.type === "session.error"
                ) {
                  unsub();
                  resolve(evt);
                }
              });
              ToolRegistry.getInstance().resolveTool(
                threadId!,
                cid,
                lastMsg.content,
              );
            });
          } else {
            if (attachments) {
              this.log(`Attachments array (blocking): ${JSON.stringify(attachments)}`, "info");
            }
            response = await session.sendAndWait({
              prompt: promptText,
              attachments: attachments, // Pass the processed images
            });
          }

          // ... Response handling (unchanged) ...
          if (response && response.type === "assistant.message") {
            const toolRequests = (response.data as any).toolRequests;
            if (toolRequests && toolRequests.length > 0) {
              // ... existing tool response logic ...
              const result = {
                id: "chatcmpl-" + threadId,
                object: "chat.completion",
                created: Date.now(),
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: toolRequests.map((tr: any) => ({
                        id: `${threadId}:${tr.toolCallId}`,
                        type: "function",
                        function: {
                          name: tr.name,
                          arguments:
                            typeof tr.arguments === "string"
                              ? tr.arguments
                              : JSON.stringify(tr.arguments),
                        },
                      })),
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              };
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            } else {
              const result = {
                id: "chatcmpl-" + threadId,
                object: "chat.completion",
                created: Date.now(),
                model: body.model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: (response as any).data.content,
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              };
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            }
          } else {
            // ... error handling ...
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "No response" } }));
          }
        }
      } catch (err) {
        this.log(`Exception in session execution: ${err}`, "error");
        throw err;
      }
    } catch (error) {
      this.log(`Error in handleChatCompletions: ${error}`, "error");
      const msg = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: msg } }));
      }
    }
  }
}
