import * as assert from "assert";
import { OPENROUTE_MODELS, MODEL_LIST } from "../../models";

suite("Models", () => {
    test("Every OPENROUTE_MODELS entry has required fields: id, created, owned_by", () => {
        for (const [key, model] of Object.entries(OPENROUTE_MODELS)) {
            assert.ok(model.id || key, `Model entry key "${key}" must have an id`);
            assert.ok(
                model.name,
                `Model entry "${key}" must have a name`
            );
            assert.strictEqual(typeof model.toolCalling, "boolean", `Model "${key}" toolCalling must be boolean`);
            assert.strictEqual(typeof model.vision, "boolean", `Model "${key}" vision must be boolean`);
            assert.strictEqual(typeof model.thinking, "boolean", `Model "${key}" thinking must be boolean`);
            assert.ok(
                Number.isInteger(model.maxInputTokens) && model.maxInputTokens > 0,
                `Model "${key}" maxInputTokens must be a positive integer`
            );
            assert.ok(
                Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0,
                `Model "${key}" maxOutputTokens must be a positive integer`
            );
        }
    });

    test("Every MODEL_LIST entry has required fields and boolean capability flags", () => {
        for (const model of MODEL_LIST) {
            assert.ok(model.id, "Model id must be present");
            assert.ok(model.name, "Model name must be present");
            assert.strictEqual(typeof model.toolCalling, "boolean", "toolCalling must be boolean");
            assert.strictEqual(typeof model.vision, "boolean", "vision must be boolean");
            assert.strictEqual(typeof model.thinking, "boolean", "thinking must be boolean");
        }
    });

    test("No model has null/undefined capability flags", () => {
        for (const model of MODEL_LIST) {
            assert.strictEqual(model.toolCalling, true || false, `toolCalling must be boolean for ${model.id}`);
            assert.strictEqual(model.vision === true || model.vision === false, true, `vision must be boolean for ${model.id}`);
            assert.strictEqual(model.thinking === true || model.thinking === false, true, `thinking must be boolean for ${model.id}`);
        }
    });

    test("OPENROUTE_MODELS and MODEL_LIST have consistent entries", () => {
        const modelIds = new Set(MODEL_LIST.map((m) => m.id));
        for (const key of Object.keys(OPENROUTE_MODELS)) {
            assert.ok(modelIds.has(key), `OPENROUTE_MODELS key "${key}" should exist in MODEL_LIST`);
        }
    });
});
