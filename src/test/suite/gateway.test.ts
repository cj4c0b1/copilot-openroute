import * as assert from "assert";
import * as http from "http";
import * as vscode from "vscode";
import { OpenRouteGateway } from "../../OpenRouteGateway";

suite("OpenRouteGateway", () => {
    let gateway: OpenRouteGateway;
    let port: number;

    teardown(async () => {
        if (gateway) {
            await gateway.stop();
        }

        const config = vscode.workspace.getConfiguration("openroute.server");
        await config.update("provider", "copilot", vscode.ConfigurationTarget.Global);
        await config.update("openaiBaseUrl", "https://openrouter.ai/api/v1", vscode.ConfigurationTarget.Global);
        await config.update("openaiApiKey", "", vscode.ConfigurationTarget.Global);
        await config.update("customModels", [], vscode.ConfigurationTarget.Global);
    });

    test("GET /v1/models responds with a models list", async () => {
        gateway = new OpenRouteGateway(0, "");
        await gateway.start();
        port = gateway.getStatus().port;

        const models = await new Promise<string>((resolve, reject) => {
            http.get(`http://localhost:${port}/v1/models`, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => resolve(data));
                res.on("error", reject);
            }).on("error", reject);
        });

        const parsed = JSON.parse(models);
        assert.strictEqual(parsed.object, "list");
        assert.ok(Array.isArray(parsed.data));
        assert.ok(parsed.data.length > 0);
        assert.strictEqual(parsed.data[0].object, "model");
        assert.ok(parsed.data[0].id);
        assert.ok(parsed.data[0].created);
        assert.strictEqual(parsed.data[0].owned_by, "copilot-openroute");
    });

    test("configured OpenAI-compatible models appear in /v1/models", async () => {
        const config = vscode.workspace.getConfiguration("openroute.server");
        await config.update("provider", "openai-compatible", vscode.ConfigurationTarget.Global);
        await config.update("openaiBaseUrl", "https://example.invalid/v1", vscode.ConfigurationTarget.Global);
        await config.update("customModels", ["openai/gpt-4.1-mini", "google/gemini-2.0-flash-001"], vscode.ConfigurationTarget.Global);

        gateway = new OpenRouteGateway(0, "");
        await gateway.start();
        port = gateway.getStatus().port;

        const models = await new Promise<string>((resolve, reject) => {
            http.get(`http://localhost:${port}/v1/models`, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => resolve(data));
                res.on("error", reject);
            }).on("error", reject);
        });

        const parsed = JSON.parse(models);
        assert.ok(parsed.data.some((model: any) => model.id === "openai/gpt-4.1-mini"));
        assert.ok(parsed.data.some((model: any) => model.id === "google/gemini-2.0-flash-001"));
    });

    test("POST /v1/chat/completions translates OpenAI request to SDK call", async () => {
        gateway = new OpenRouteGateway(0, "");
        await gateway.start();
        port = gateway.getStatus().port;

        const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
            const req = http.request(
                {
                    hostname: "localhost",
                    port,
                    path: "/v1/chat/completions",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
                    res.on("error", reject);
                }
            );
            req.on("error", reject);
            req.write(
                JSON.stringify({
                    model: "gpt-4",
                    messages: [{ role: "user", content: "Say hello" }],
                })
            );
            req.end();
        });

        assert.strictEqual(response.statusCode, 200);
        const parsed = JSON.parse(response.body);
        assert.ok(parsed.id);
        assert.strictEqual(parsed.object, "chat.completion");
        assert.ok(parsed.choices);
        assert.strictEqual(parsed.choices[0].message.role, "assistant");
    });

    test("Streaming emits SSE chunks and terminates with data: [DONE]", async () => {
        gateway = new OpenRouteGateway(0, "");
        await gateway.start();
        port = gateway.getStatus().port;

        const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
            const req = http.request(
                {
                    hostname: "localhost",
                    port,
                    path: "/v1/chat/completions",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
                (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
                    res.on("error", reject);
                }
            );
            req.on("error", reject);
            req.write(
                JSON.stringify({
                    model: "gpt-4",
                    messages: [{ role: "user", content: "Say hello" }],
                    stream: true,
                })
            );
            req.end();
        });

        assert.strictEqual(response.statusCode, 200);
        assert.ok(response.body.includes("data: [DONE]"), "Response should end with data: [DONE]");
        // Should have at least one SSE chunk before the terminator
        const chunks = response.body.split("\n\n").filter((c) => c.startsWith("data: "));
        assert.ok(chunks.length >= 2, "Should have at least one data chunk plus the DONE terminator");
    });

    test("Port retry logic increments port on EADDRINUSE up to 10 attempts", async () => {
        // Start a server to occupy the initial port
        const blocker = http.createServer();
        await new Promise<void>((resolve) => blocker.listen(9317, resolve));

        try {
            gateway = new OpenRouteGateway(9317, "");
            await gateway.start();

            const status = gateway.getStatus();
            assert.ok(status.port > 9317, "Gateway should have found an alternate port");
            assert.ok(status.running, "Gateway should be running");
        } finally {
            await new Promise<void>((resolve) => blocker.close(resolve));
        }
    });
});
