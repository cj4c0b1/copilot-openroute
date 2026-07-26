import * as assert from "assert";
import { OpenRouteGateway } from "../../OpenRouteGateway";

suite("ContextStuffing", () => {
    test("Conversation history is injected into the system prompt", async () => {
        const gateway = new OpenRouteGateway(0, "");
        const history: any[] = [
            { role: "user", content: "What is TypeScript?" },
            { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
        ];
        const formatted = gateway.formatConversationHistory(history);
        assert.ok(formatted.includes("USER: What is TypeScript?"));
        assert.ok(formatted.includes("ASSISTANT: TypeScript is a typed superset of JavaScript."));
    });

    test("truncateHistory drops oldest messages when combined tokens exceed 80% of context window", () => {
        const gateway = new OpenRouteGateway(0, "");
        const messages = [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi there" },
            { role: "user", content: "What is the capital of France?" },
            { role: "assistant", content: "The capital of France is Paris." },
            { role: "user", content: "Tell me more about Paris." },
        ];

        const tokenEstimator = (msg: any) => Math.ceil(JSON.stringify(msg).length / 4);

        // The system message and last user message should always be kept.
        // With a small maxTokens, older messages should be dropped.
        const truncated = (gateway as any).truncateHistory
            ? (gateway as any).truncateHistory(messages, 30, tokenEstimator)
            : (gateway as any).truncateHistory(messages, 30, tokenEstimator);

        assert.ok(truncated.length < messages.length, "Some messages should have been truncated");
        assert.strictEqual(truncated[0].role, "system", "System message should always be kept");
        assert.strictEqual(
            truncated[truncated.length - 1].role,
            "user",
            "Last user message should always be kept"
        );
    });

    test("truncateHistory always keeps the system message", () => {
        const gateway = new OpenRouteGateway(0, "");
        const messages = [
            { role: "user", content: "First" },
            { role: "assistant", content: "Reply one" },
            { role: "user", content: "Second" },
            { role: "system", content: "You are helpful." },
        ];

        const tokenEstimator = (msg: any) => Math.ceil(JSON.stringify(msg).length / 4);
        const truncated = (gateway as any).truncateHistory(messages, 10, tokenEstimator);

        assert.ok(truncated.some((m: any) => m.role === "system"), "System message must be present");
    });

    test("truncateHistory always keeps the last user message", () => {
        const gateway = new OpenRouteGateway(0, "");
        const messages = [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "First" },
            { role: "assistant", content: "Reply" },
            { role: "user", content: "Last question" },
        ];

        const tokenEstimator = (msg: any) => Math.ceil(JSON.stringify(msg).length / 4);
        const truncated = (gateway as any).truncateHistory(messages, 10, tokenEstimator);

        assert.strictEqual(
            truncated[truncated.length - 1].role,
            "user",
            "Last user message must be present"
        );
        assert.strictEqual(
            truncated[truncated.length - 1].content,
            "Last question",
            "Last user message content must be preserved"
        );
    });
});
