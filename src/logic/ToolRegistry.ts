
import { CopilotSession } from '@github/copilot-sdk';

export interface PendingToolCall {
    toolCallId: string;
    resolve: (result: any) => void;
    promise: Promise<any>;
}

export interface ActiveThread {
    session: CopilotSession;
    lastUsed: number;
    pendingTools: Map<string, PendingToolCall>;
}

export class ToolRegistry {
    private static instance: ToolRegistry;
    private threads: Map<string, ActiveThread> = new Map();
    private readonly SESSION_TTL = 1000 * 60 * 30; // 30 minutes

    private constructor() {
        // Periodic cleanup
        setInterval(() => this.cleanup(), 1000 * 60 * 5); // Every 5 minutes
    }

    public static getInstance(): ToolRegistry {
        if (!ToolRegistry.instance) {
            ToolRegistry.instance = new ToolRegistry();
        }
        return ToolRegistry.instance;
    }

    public getThread(threadId: string): ActiveThread | undefined {
        const thread = this.threads.get(threadId);
        if (thread) {
            thread.lastUsed = Date.now();
        }
        return thread;
    }

    public registerThread(threadId: string, session: CopilotSession) {
        this.threads.set(threadId, {
            session,
            lastUsed: Date.now(),
            pendingTools: new Map()
        });
    }

    public removeThread(threadId: string) {
        this.threads.delete(threadId);
    }

    public createToolTrap(threadId: string, toolCallId: string): Promise<any> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            throw new Error(`Thread ${threadId} not found in registry`);
        }

        let resolver: (val: any) => void;
        const promise = new Promise<any>((resolve) => {
            resolver = resolve;
        });

        thread.pendingTools.set(toolCallId, {
            toolCallId,
            resolve: resolver!,
            promise
        });

        return promise;
    }

    public resolveTool(threadId: string, toolCallId: string, result: any): boolean {
        const thread = this.threads.get(threadId);
        if (!thread) return false;

        const pending = thread.pendingTools.get(toolCallId);
        if (pending) {
            pending.resolve(result);
            thread.pendingTools.delete(toolCallId);
            return true;
        }
        return false;
    }

    private cleanup() {
        const now = Date.now();
        for (const [id, thread] of this.threads.entries()) {
            if (now - thread.lastUsed > this.SESSION_TTL) {
                console.log(`[ToolRegistry] Cleaning up stale thread: ${id}`);
                thread.session.destroy().catch(() => { });
                this.threads.delete(id);
            }
        }
    }
}
