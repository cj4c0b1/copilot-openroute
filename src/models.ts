import * as http from 'http';

export interface CopilotModelConfig {
    name: string;
    url: string;
    model: string;  // The model ID to send in API requests
    toolCalling: boolean;
    vision: boolean;
    thinking: boolean;
    maxInputTokens: number;
    maxOutputTokens: number;
    requiresAPIKey: boolean;
}

export interface ModelInfo {
    id: string;
    name: string;
    toolCalling: boolean;
    vision: boolean;
    thinking: boolean;
}

// Fallback static models (used when server is not available)
// URL is a placeholder that gets rewritten by rewriteModelUrls() in extension.ts
const PLACEHOLDER_URL = "http://127.0.0.1:9317/v1";

export const OPENROUTE_MODELS: Record<string, CopilotModelConfig> = {
    "gemini-claude-sonnet-4-5": {
        "name": "OpenRoute: Claude Sonnet 4.5",
        "url": PLACEHOLDER_URL,
        "model": "gemini-claude-sonnet-4-5",
        "toolCalling": true,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-claude-sonnet-4-5-thinking": {
        "name": "OpenRoute: Claude Sonnet 4.5 (Thinking)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-claude-sonnet-4-5-thinking",
        "toolCalling": true,
        "vision": true,
        "thinking": true,
        "maxInputTokens": 32000,
        "maxOutputTokens": 2048,
        "requiresAPIKey": false
    },
    "gemini-claude-opus-4-5-thinking": {
        "name": "OpenRoute: Claude Opus 4.5 (Thinking)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-claude-opus-4-5-thinking",
        "toolCalling": true,
        "vision": true,
        "thinking": true,
        "maxInputTokens": 32000,
        "maxOutputTokens": 2048,
        "requiresAPIKey": false
    },
    "gemini-2.5-flash": {
        "name": "OpenRoute: Gemini 2.5 Flash",
        "url": PLACEHOLDER_URL,
        "model": "gemini-2.5-flash",
        "toolCalling": true,
        "vision": false,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-2.5-flash-lite": {
        "name": "OpenRoute: Gemini 2.5 Flash Lite",
        "url": PLACEHOLDER_URL,
        "model": "gemini-2.5-flash-lite",
        "toolCalling": true,
        "vision": false,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-3-pro-preview": {
        "name": "OpenRoute: Gemini 3 Pro (Preview)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-3-pro-preview",
        "toolCalling": true,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-3-flash-preview": {
        "name": "OpenRoute: Gemini 3 Flash (Preview)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-3-flash-preview",
        "toolCalling": true,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-3-pro-image-preview": {
        "name": "OpenRoute: Gemini 3 Pro Image (Preview)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-3-pro-image-preview",
        "toolCalling": true,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gemini-2.5-computer-use-preview-10-2025": {
        "name": "OpenRoute: Gemini 2.5 Computer Use (Preview)",
        "url": PLACEHOLDER_URL,
        "model": "gemini-2.5-computer-use-preview-10-2025",
        "toolCalling": true,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    },
    "gpt-oss-120b-medium": {
        "name": "OpenRoute: gpt-oss-120b-medium",
        "url": PLACEHOLDER_URL,
        "model": "gpt-oss-120b-medium",
        "toolCalling": false,
        "vision": true,
        "thinking": false,
        "maxInputTokens": 128000,
        "maxOutputTokens": 4096,
        "requiresAPIKey": false
    }
};

export const MODEL_LIST: ModelInfo[] = [
    { id: "gemini-claude-sonnet-4-5", name: "Claude Sonnet 4.5", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-claude-sonnet-4-5-thinking", name: "Claude Sonnet 4.5 (Thinking)", toolCalling: true, vision: true, thinking: true },
    { id: "gemini-claude-opus-4-5-thinking", name: "Claude Opus 4.5 (Thinking)", toolCalling: true, vision: true, thinking: true },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (Preview)", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (Preview)", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Preview)", toolCalling: true, vision: true, thinking: false },
    { id: "gemini-2.5-computer-use-preview-10-2025", name: "Gemini 2.5 Computer Use (Preview)", toolCalling: true, vision: true, thinking: false },
    { id: "gpt-oss-120b-medium", name: "gpt-oss-120b-medium", toolCalling: false, vision: true, thinking: false }
];

interface OpenAIModelsResponse {
    data: Array<{
        id: string;
        object: string;
        created?: number;
        owned_by?: string;
    }>;
}

/**
 * Fetches models dynamically from OpenRoute API
 */
export async function fetchModelsFromServer(host: string, port: number): Promise<Record<string, CopilotModelConfig>> {
    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: host,
            port: port,
            path: '/v1/models',
            method: 'GET',
            timeout: 5000,
        };

        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        reject(new Error(`Server returned status ${res.statusCode}`));
                        return;
                    }

                    const response: OpenAIModelsResponse = JSON.parse(body);
                    const models: Record<string, CopilotModelConfig> = {};

                    for (const model of response.data) {
                        const modelId = model.id;
                        const serverUrl = `http://${host}:${port}/v1`;

                        // Prefer known, curated model specs where available.
                        const known = OPENROUTE_MODELS[modelId];
                        if (known) {
                            models[modelId] = {
                                ...known,
                                url: serverUrl,
                                model: modelId,
                            };
                            continue;
                        }

                        const displayName = formatModelName(modelId);
                        models[modelId] = {
                            name: `OpenRoute: ${displayName}`,
                            url: serverUrl,
                            model: modelId,
                            toolCalling: inferToolCalling(modelId),
                            vision: inferVision(modelId),
                            thinking: inferThinking(modelId),
                            maxInputTokens: inferContextWindow(modelId),
                            maxOutputTokens: inferMaxOutputTokens(modelId),
                            requiresAPIKey: false,
                        };
                    }

                    resolve(models);
                } catch (error) {
                    reject(new Error(`Failed to parse models response: ${error}`));
                }
            });
        });

        req.on('error', (error) => {
            reject(new Error(`Failed to fetch models: ${error.message}`));
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout while fetching models'));
        });

        req.end();
    });
}

function formatModelName(modelId: string): string {
    if (modelId.includes('claude')) {
        if (modelId.includes('opus')) {
            if (modelId.includes('thinking')) return 'Claude Opus 4.5 (Thinking)';
            return 'Claude Opus 4.5';
        }
        if (modelId.includes('sonnet')) {
            if (modelId.includes('thinking')) return 'Claude Sonnet 4.5 (Thinking)';
            return 'Claude Sonnet 4.5';
        }
    }

    if (modelId.includes('gemini')) {
        let name = modelId
            .replace('gemini-', 'Gemini ')
            .replace(/-preview.*$/, ' (Preview)')
            .replace(/-/g, ' ');
        name = name.replace(/\b\w/g, c => c.toUpperCase());
        return name;
    }

    return modelId
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

const MODEL_SPECS = {
    gemini: {
        flash: { context: 1048576, output: 8192 },
        pro: { context: 2097152, output: 8192 },
        default: { context: 1048576, output: 8192 }
    },
    claude: {
        default: { context: 200000, output: 8192 }
    },
    gpt4: {
        default: { context: 128000, output: 4096 }
    },
    thinking: {
        maxContext: 32000,
        maxOutput: 2048
    },
    fallback: {
        context: 128000,
        output: 4096
    }
};

function inferContextWindow(modelId: string): number {
    const id = modelId.toLowerCase();
    if (id.includes('thinking')) return MODEL_SPECS.thinking.maxContext;
    if (id.includes('gemini')) {
        if (id.includes('flash')) return MODEL_SPECS.gemini.flash.context;
        if (id.includes('pro')) return MODEL_SPECS.gemini.pro.context;
        return MODEL_SPECS.gemini.default.context;
    }
    if (id.includes('claude')) return MODEL_SPECS.claude.default.context;
    if (id.includes('gpt-4')) return MODEL_SPECS.gpt4.default.context;
    return MODEL_SPECS.fallback.context;
}

function inferMaxOutputTokens(modelId: string): number {
    const id = modelId.toLowerCase();
    if (id.includes('thinking')) return MODEL_SPECS.thinking.maxOutput;
    if (id.includes('gemini')) return MODEL_SPECS.gemini.default.output;
    if (id.includes('claude')) return MODEL_SPECS.claude.default.output;
    return MODEL_SPECS.fallback.output;
}

function inferToolCalling(modelId: string): boolean {
    const noToolModels = ['gpt-oss', 'basic'];
    return !noToolModels.some(pattern => modelId.toLowerCase().includes(pattern));
}

function inferVision(modelId: string): boolean {
    const visionKeywords = ['image', 'vision', 'computer-use', 'multimodal'];
    return visionKeywords.some(keyword => modelId.toLowerCase().includes(keyword));
}

function inferThinking(modelId: string): boolean {
    return modelId.toLowerCase().includes('thinking');
}
