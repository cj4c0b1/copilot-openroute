import * as vscode from 'vscode';
import { OpenRouteGateway } from './OpenRouteGateway';
import { installCopilotCLI } from './logic/Installer';

let gateway: OpenRouteGateway | undefined;

export function activate(context: vscode.ExtensionContext) {
    const output = vscode.window.createOutputChannel('Copilot OpenRoute');
    context.subscriptions.push(output);
    output.appendLine('[Main] Copilot OpenRoute activating...');

    // Initialize Gateway
    try {
        const config = vscode.workspace.getConfiguration('openroute.server');
        const port = config.get<number>('port', 9317);



        gateway = new OpenRouteGateway(port, context.extensionPath, output);
        gateway.start()
            .then(() => {
                output.appendLine(`[Main] Gateway started automatically on port ${port}`);
                vscode.window.setStatusBarMessage(`OpenRoute: Active (${port})`, 5000);
            })
            .catch(err => handleGatewayError(err, output));
    } catch (err) {
        output.appendLine(`[Main] Error initializing gateway: ${err}`);
    }

    // Commands
    const startCmd = vscode.commands.registerCommand('openroute.start', async () => {
        if (!gateway) {
            const config = vscode.workspace.getConfiguration('openroute.server');
            const port = config.get<number>('port', 9317);
            gateway = new OpenRouteGateway(port, (vscode.extensions.getExtension('punal100.copilot-openroute')?.extensionPath || ''), output);
        }
        try {
            await gateway.start();
            vscode.window.showInformationMessage('OpenRoute Gateway Started');
        } catch (err) {
            handleGatewayError(err, output);
        }
    });

    const stopCmd = vscode.commands.registerCommand('openroute.stop', async () => {
        if (gateway) {
            await gateway.stop();
            vscode.window.showInformationMessage('OpenRoute Gateway Stopped');
        }
    });

    const loginCmd = vscode.commands.registerCommand('openroute.login', async () => {
        if (!gateway) {
            vscode.window.showErrorMessage('Gateway must be initialized before logging in.');
            return;
        }

        try {
            const flow = await gateway.startLoginFlow();

            // Show modal notification with code
            const userSelection = await vscode.window.showInformationMessage(
                `Your GitHub Copilot Device Code is: ${flow.userCode}`,
                { modal: true, detail: `Click 'Copy & Open' to authenticate in your browser.\nVerification URL: ${flow.verificationUri}` },
                'Copy & Open',
                'Copy Code'
            );

            if (userSelection === 'Copy & Open') {
                await vscode.env.clipboard.writeText(flow.userCode);
                await vscode.env.openExternal(vscode.Uri.parse(flow.verificationUri));
            } else if (userSelection === 'Copy Code') {
                await vscode.env.clipboard.writeText(flow.userCode);
            }

            // Wait for polling to complete
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Waiting for GitHub Authentication...',
                cancellable: true
            }, async (_progress, _token) => {
                // Determine if we need to race polling against cancellation
                // DeviceCodeManager handles polling logic, we just await the promise

                // Note: The pollingPromise currently polls indefinitely until success or internal timeout. 
                // We should ideally support cancellation if the user clicks Cancel.
                // For now, if the user cancels, we just ignore the background promise (it will eventually fail or succeed silently).
                // Or we can just let it run.

                await flow.pollingPromise;
            });

            vscode.window.showInformationMessage('Successfully logged in to GitHub Copilot.');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Login failed: ${msg}`);
        }
    });

    // Sidebar Provider
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DashboardSidebarProvider } = require('./providers/DashboardSidebarProvider');
    if (gateway) {
        const sidebarProvider = new DashboardSidebarProvider(context.extensionUri, gateway);
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(DashboardSidebarProvider.viewType, sidebarProvider)
        );
    } else {
        // Fallback if gateway failed init (though gateway var is set unless new threw)
        if (gateway) {
            const sidebarProvider = new DashboardSidebarProvider(context.extensionUri, gateway);
            context.subscriptions.push(
                vscode.window.registerWebviewViewProvider(DashboardSidebarProvider.viewType, sidebarProvider)
            );
        }
    }

    const showDashboardCmd = vscode.commands.registerCommand('openroute.showDashboard', async () => {
        await vscode.commands.executeCommand('copilot-openroute.sidebarView.focus');
    });

    context.subscriptions.push(startCmd, stopCmd, loginCmd, showDashboardCmd);
}

export function deactivate() {
    if (gateway) {
        gateway.stop();
    }
}

async function handleGatewayError(err: unknown, output: vscode.OutputChannel) {
    const msg = err instanceof Error ? err.message : String(err);
    output.appendLine(`[Main] Gateway Error: ${msg}`);

    if (msg.includes('Copilot CLI binary not found') || msg.includes('executable not found')) {
        const selection = await vscode.window.showErrorMessage(
            'Copilot CLI not found. OpenRoute requires the Copilot CLI to function.',
            'Auto-Download & Install',
            'Manual Download',
            'Configure Path'
        );

        if (selection === 'Auto-Download & Install') {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Installing Copilot CLI...',
                cancellable: false
            }, async (progress) => {
                const result = await installCopilotCLI((p) => {
                    progress.report({ message: `${p}%`, increment: 0 }); // increment 0 to just update message? Or use increment logic.
                }, output);

                if (result.success) {
                    vscode.window.showInformationMessage(`Copilot CLI installed successfully (v${result.version}). Starting Gateway...`);
                    // Try starting again
                    if (gateway) {
                        try {
                            await gateway.start();
                            vscode.window.showInformationMessage('OpenRoute Gateway Started');
                        } catch (startErr) {
                            vscode.window.showErrorMessage(`Installation successful, but failed to start: ${startErr}`);
                        }
                    }
                } else {
                    vscode.window.showErrorMessage(`Installation failed: ${result.error}`);
                }
            });
        } else if (selection === 'Manual Download') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/github/copilot-cli'));
        } else if (selection === 'Configure Path') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'openroute.server.executablePath');
        }
    } else if (msg.includes('in PATH')) {
        // Specific PATH error from spawn
        vscode.window.showErrorMessage(
            'Copilot CLI executable not found in PATH.',
            'Configure Path'
        ).then(sel => {
            if (sel === 'Configure Path') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'openroute.server.executablePath');
            }
        });
    } else {
        vscode.window.showErrorMessage(`OpenRoute Gateway Error: ${msg}`);
    }
}
