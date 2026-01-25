
export interface ThinkingAdapterState {
    thinkingActive: boolean;
}

export class ThinkingAdapter {
    private thinkingActive = false;
    private debug?: (msg: string) => void;

    constructor(debug?: (msg: string) => void) {
        this.debug = debug;
    }

    /**
     * Processes an incoming delta (from Copilot SDK) and returns an array of SSE strings.
     * Maps `reasoning_content` to the specific format VS Code expects for thinking blocks.
     */
    public processDelta(
        sessionId: string, 
        model: string, 
        delta: { content?: string; reasoning_content?: string }
    ): string[] {
        const results: string[] = [];
        
        const reasoning = delta.reasoning_content;
        const content = delta.content;

        // 1. Handle Reasoning (Thinking)
        if (reasoning !== undefined && reasoning !== null && reasoning !== '') {
            if (!this.thinkingActive) {
                this.thinkingActive = true;
                if (this.debug) this.debug('Starting thinking block');
                // Optional: Emit explicit start if needed, but usually the first chunk with _thinking matches logic
            }

            // Emit chunk with special thinking markers
            results.push(this.formatChunk(sessionId, model, {
                reasoning_content: reasoning,
                _thinking: reasoning,
                _thinking_active: true
            }));
        }

        // 2. Handle Content (Regular Text)
        if (content !== undefined && content !== null && content !== '') {
            if (this.thinkingActive) {
                this.thinkingActive = false;
                if (this.debug) this.debug('Ending thinking block');
                // Emit thinking end marker
                results.push(this.formatChunk(sessionId, model, {
                    _thinking_end: true
                }));
            }

            // Emit regular content
            results.push(this.formatChunk(sessionId, model, {
                content: content
            }));
        }

        return results;
    }

    private formatChunk(sessionId: string, model: string, deltaBody: any): string {
        const chunk = {
            id: 'chatcmpl-' + sessionId,
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: model,
            choices: [{
                index: 0,
                delta: deltaBody,
                finish_reason: null
            }]
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    
    public reset(): void {
        this.thinkingActive = false;
    }
}
