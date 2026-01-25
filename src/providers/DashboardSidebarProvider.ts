import * as vscode from 'vscode';
import { OpenRouteGateway } from '../OpenRouteGateway';

export class DashboardSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'copilot-openroute.sidebarView';
    private _view?: vscode.WebviewView;
    private _lastError: string | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _gateway: OpenRouteGateway
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        // Initial render
        this._updateWebview();

        // Listen for messages from the Webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            await this._handleMessage(data);
        });

        // Listen for Gateway status changes to push updates
        this._gateway.onDidChangeStatus(() => {
            this._updateWebview();
        });
    }

    private async _handleMessage(data: { type: string; value?: any }) {
        try {
            this._lastError = null; // Clear error on new action
            switch (data.type) {
                case 'refreshStatus':
                    this._updateWebview();
                    break;
                case 'startServer':
                    await this._gateway.start();
                    break;
                case 'stopServer':
                    await this._gateway.stop();
                    break;
                case 'restartServer':
                    await this._gateway.stop();
                    await this._gateway.start();
                    break;
                case 'saveConfig':
                    if (data.value && typeof data.value.port === 'number') {
                        await vscode.workspace.getConfiguration('openroute.server').update('port', data.value.port, vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage(`Port updated to ${data.value.port}. Restarting server...`);
                    }
                    break;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotOpenRoute');
                    break;
                case 'loginOpenRoute':
                    await vscode.commands.executeCommand('openroute.login');
                    break;
                case 'openExternal':
                    if (data.value) {
                        await vscode.env.openExternal(vscode.Uri.parse(data.value));
                    }
                    break;
                case 'dismissError':
                    this._lastError = null;
                    this._updateWebview();
                    break;
            }
        } catch (err: any) {
            const message = err.message || String(err);
            this._lastError = message;
            this._updateWebview();

            // Notify VS Code with Actionable button if CLI not found
            if (message.includes('binary not found') || message.includes('executable not found')) {
                const selection = await vscode.window.showErrorMessage(
                    `OpenRoute Gateway error: ${message}`,
                    'Configure Path'
                );
                if (selection === 'Configure Path') {
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotOpenRoute.server.executablePath');
                }
            } else {
                vscode.window.showErrorMessage(`OpenRoute Gateway error: ${message}`);
            }
        }
    }

    private async _updateWebview() {
        if (!this._view) return;
        this._view.webview.html = await this._getHtmlForWebview();
    }

    private async _getHtmlForWebview(): Promise<string> {
        const status = this._gateway.getStatus();
        const modelsWithCaps = await this._gateway.getModelsWithCapabilities();
        const isRunning = status.running;
        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>OpenRoute Dashboard</title>
                <style>
                    :root {
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-sideBar-background);
                    }
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { padding: 16px; }
                    .header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
                    .status-indicator { width: 12px; height: 12px; border-radius: 50%; background-color: #64748b; }
                    .status-indicator.running { background-color: #22c55e; animation: pulse 2s infinite; }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                    .status-text { font-weight: 600; font-size: 14px; }
                    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; transition: background-color 0.2s; width: 100%; justify-content: center; margin-bottom: 4px; }
                    .btn-primary { background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
                    .btn-primary:hover { background-color: var(--vscode-button-hoverBackground); }
                    .btn-secondary { background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
                    .btn-secondary:hover { background-color: var(--vscode-button-secondaryHoverBackground); }
                    .btn-danger { background-color: #dc2626; color: white; }
                    .btn-danger:hover { background-color: #b91c1c; }
                    .actions { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
                    .card { background-color: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
                    .card h3 { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
                    .info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--vscode-widget-border); font-size: 12px; }
                    .info-row:last-child { border-bottom: none; }
                    .info-label { color: var(--vscode-descriptionForeground); }
                    .info-value { font-weight: 500; }
                    .model-list { max-height: 250px; overflow-y: auto; }
                    .model-item { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid var(--vscode-widget-border); font-size: 11px; }
                    .model-item:last-child { border-bottom: none; }
                    .model-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                    .model-badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 500; }
                    .badge-tool { background-color: #3b82f622; color: #3b82f6; }
                    .badge-vision { background-color: #8b5cf622; color: #8b5cf6; }
                    .badge-thinking { background-color: #f59e0b22; color: #f59e0b; }
                    .alert { padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 12px; }
                    .alert-warning { background-color: #f59e0b22; border: 1px solid #f59e0b44; color: var(--vscode-foreground); }
                    .alert-success { background-color: #22c55e22; border: 1px solid #22c55e44; color: var(--vscode-foreground); }
                    .alert-error { background-color: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); color: var(--vscode-inputValidation-errorForeground); }
                    .resource-list { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
                    .resource-link { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; user-select: none; font-size: 12px; color: var(--vscode-foreground); text-decoration: none; }
                    .resource-link:hover { background-color: var(--vscode-list-hoverBackground); }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="status-indicator ${isRunning ? 'running' : ''}"></div>
                    <span class="status-text">${isRunning ? 'Server Running' : 'Server Stopped'}</span>
                </div>

                ${this._lastError ? `
                    <div class="alert alert-error">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>⚠️ ${this._lastError}</span>
                            <button onclick="dismissError()" style="background: none; border: none; color: inherit; cursor: pointer; font-size: 14px;">×</button>
                        </div>
                    </div>
                ` : ''}

                <div class="alert ${isRunning ? 'alert-success' : 'alert-warning'}">
                    ${isRunning ? '✅ Gateway is active and ready for requests.' : '⚠️ Gateway is stopped. Start it to use Copilot models.'}
                </div>

                <div class="actions">
                    ${isRunning ? `
                        <button class="btn btn-danger" onclick="stopServer()">⏹️ Stop Server</button>
                        <button class="btn btn-secondary" onclick="restartServer()">🔄 Restart Server</button>
                    ` : `
                        <button class="btn btn-primary" onclick="startServer()">▶️ Start Server</button>
                    `}
                    <button class="btn btn-secondary" onclick="login()">🔐 Login to GitHub Copilot</button>
                    <button class="btn btn-secondary" onclick="openSettings()">⚙️ Settings</button>
                </div>

                <div class="card">
                    <h3>ℹ️ Gateway Info</h3>
                    <div class="info-row"><span class="info-label">Status</span><span class="info-value">${isRunning ? '🟢 Running' : '🔴 Stopped'}</span></div>
                    <div class="info-row"><span class="info-label">Local Port</span><span class="info-value">${status.port}</span></div>
                </div>

                <div class="card">
                    <h3>🤖 Available Models (${modelsWithCaps.length})</h3>
                    <div class="model-list">
                        ${modelsWithCaps.length > 0 ? modelsWithCaps.map(m => `
                            <div class="model-item">
                                <span class="model-name">${m.id}</span>
                                <div style="display: flex; gap: 4px;">
                                    ${m.tools ? '<span class="model-badge badge-tool">Tools</span>' : ''}
                                    ${m.vision ? '<span class="model-badge badge-vision">Vision</span>' : ''}
                                    ${m.thinking ? '<span class="model-badge badge-thinking">Thinking</span>' : ''}
                                </div>
                            </div>
                        `).join('') : '<div style="padding: 8px; font-size: 11px; opacity: 0.6;">No models available. Please login.</div>'}
                    </div>
                </div>

                <div class="card">
                    <h3>🚀 Quick Setup</h3>
                    <ol style="margin-left: 16px; font-size: 11px; line-height: 1.6; opacity: 0.9;">
                        <li>Click <strong>"Login to GitHub Copilot"</strong> to authenticate</li>
                        <li>Start the server using the <strong>"▶️ Start Server"</strong> button</li>
                        <li>The gateway fetches your available models automatically</li>
                        <li>Point your tool to <code style="background: var(--vscode-editor-background); padding: 2px 4px; border-radius: 2px;">http://localhost:${status.port}/v1</code></li>
                        <li>Use any API key (e.g., "openroute") and select a model</li>
                    </ol>
                </div>

                <div class="card">
                    <h3>📋 Requirements</h3>
                    <ul style="margin-left: 16px; font-size: 11px; line-height: 1.8; opacity: 0.9;">
                        <li>GitHub Copilot Pro or Free subscription</li>
                        <li>VS Code extension installed and activated</li>
                        <li>Copilot CLI installed (auto-detected)</li>
                    </ul>
                </div>

                <div class="card">
                    <h3>🔗 Resources</h3>
                    <div class="resource-list">
                        <a class="resource-link" href="#" onclick="openExternal('https://github.com/punal100/copilot-openroute')">
                            <span>📦 Repository</span>
                        </a>
                        <a class="resource-link" href="#" onclick="openExternal('https://github.com/punal100/copilot-openroute/issues')">
                            <span>🐛 Issues</span>
                        </a>
                        <a class="resource-link" href="#" onclick="openExternal('https://docs.github.com/en/copilot/overview-of-github-copilot')">
                            <span>📚 Copilot Docs</span>
                        </a>
                    </div>
                </div>

                <script nonce="${nonce}">
                    const vscode = acquireVsCodeApi();
                    function startServer() { vscode.postMessage({ type: 'startServer' }); }
                    function stopServer() { vscode.postMessage({ type: 'stopServer' }); }
                    function restartServer() { vscode.postMessage({ type: 'restartServer' }); }
                    function login() { vscode.postMessage({ type: 'loginOpenRoute' }); }
                    function openSettings() { vscode.postMessage({ type: 'openSettings' }); }
                    function dismissError() { vscode.postMessage({ type: 'dismissError' }); }
                    function openExternal(url) { vscode.postMessage({ type: 'openExternal', value: url }); }
                </script>
            </body>
            </html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
