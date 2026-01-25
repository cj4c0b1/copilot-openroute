import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { exec } = require('child_process');

interface GitHubAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GitHubRelease {
    tag_name: string;
    assets: GitHubAsset[];
}

/**
 * Fetches the latest release info for copilot-cli from GitHub
 * @note This points to the official repository.
 */
async function fetchLatestRelease(): Promise<GitHubRelease> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/github/copilot-cli/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'vscode-copilot-openroute',
                'Accept': 'application/vnd.github+json'
            }
        };

        const req = https.get(options, (res) => {
            let body = '';

            if (res.statusCode === 403) {
                const remaining = res.headers['x-ratelimit-remaining'];
                const reset = res.headers['x-ratelimit-reset'];
                const resetTime = reset ? new Date(parseInt(String(reset), 10) * 1000).toLocaleTimeString() : 'unknown';
                reject(new Error(`GitHub API rate limit exceeded. Remaining: ${remaining}, Reset at: ${resetTime}`));
                return;
            }

            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`GitHub API returned status ${res.statusCode}: ${body}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error('Failed to parse GitHub API response'));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('GitHub API request timeout'));
        });
    });
}

/**
 * Finds the correct asset based on platform
 */
function findAsset(assets: GitHubAsset[]): GitHubAsset | undefined {
    const platform = os.platform(); // win32, darwin, linux
    const arch = os.arch(); // x64, arm64, etc.

    // Naming patterns:
    // Windows: copilot-win32-x64.zip, copilot-win32-arm64.zip
    // MacOS: copilot-darwin-x64.tar.gz, copilot-darwin-arm64.tar.gz
    // Linux: copilot-linux-x64.tar.gz, copilot-linux-arm64.tar.gz

    const searchTerms: string[] = [];

    if (platform === 'win32') {
        searchTerms.push('copilot-win32');
        searchTerms.push(arch === 'arm64' ? 'arm64' : (arch === 'ia32' ? '386' : 'x64')); // Note: Official usually uses x64
        searchTerms.push('.zip');
    } else if (platform === 'darwin') {
        searchTerms.push('copilot-darwin');
        searchTerms.push(arch === 'arm64' ? 'arm64' : 'x64');
        searchTerms.push('.tar.gz');
    } else if (platform === 'linux') {
        searchTerms.push('copilot-linux');
        searchTerms.push(arch === 'arm64' ? 'arm64' : 'x64');
        searchTerms.push('.tar.gz');
    }

    return assets.find(asset =>
        searchTerms.every(term => asset.name.toLowerCase().includes(term))
    );
}

/**
 * Downloads a file with progress reporting
 */
async function downloadFile(url: string, dest: string, onProgress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const timeout = 300000; // 5 mins

        const request = https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    response.destroy();
                    file.close();
                    fs.unlink(dest, () => { });
                    downloadFile(redirectUrl, dest, onProgress).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                response.resume();
                file.close();
                fs.unlink(dest, () => { });
                reject(new Error(`Server returned status ${response.statusCode}`));
                return;
            }

            const totalSize = parseInt(response.headers['content-length'] || '0', 10);
            let downloadedSize = 0;
            let timeoutTimer: NodeJS.Timeout;

            const resetTimeout = () => {
                if (timeoutTimer) clearTimeout(timeoutTimer);
                timeoutTimer = setTimeout(() => {
                    request.destroy();
                    file.close();
                    fs.unlink(dest, () => { });
                    reject(new Error('Download timeout'));
                }, timeout);
            };

            resetTimeout();

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (totalSize > 0) {
                    onProgress(Math.round((downloadedSize / totalSize) * 100));
                }
                resetTimeout();
            });

            response.pipe(file);

            file.on('finish', () => {
                if (timeoutTimer) clearTimeout(timeoutTimer);
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
        });
    });
}

/**
 * Extracts an archive (ZIP or tar.gz) to a target directory
 */
async function extractArchive(archivePath: string, targetDir: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const ext = path.extname(archivePath).toLowerCase();

    // Check for .tar.gz (double extension)
    const isTarGz = archivePath.toLowerCase().endsWith('.tar.gz') || archivePath.toLowerCase().endsWith('.tgz');

    if (isTarGz) {
        return extractTarGz(archivePath, targetDir);
    } else {
        return extractZip(archivePath, targetDir);
    }
}

async function extractTarGz(archivePath: string, targetDir: string): Promise<void> {
    // Ensure target exists
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    return new Promise((resolve, reject) => {
        // Use system tar command. Windows 10+ has tar. Unix has tar.
        // Command: tar -xzf <archive> -C <targetDir>
        const cmd = `tar -xzf "${archivePath}" -C "${targetDir}"`;
        exec(cmd, (err: any, stdout: any, stderr: any) => {
            if (err) {
                reject(new Error(`Tar extraction failed: ${stderr || err.message}`));
            } else {
                resolve();
            }
        });
    });
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            if (!zipfile) return reject(new Error('Could not open ZIP file'));

            const absoluteTargetDir = path.resolve(targetDir);
            let closed = false;

            const closeZipFile = () => {
                if (!closed) {
                    closed = true;
                    zipfile.close();
                }
            };

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                const entryPath = path.resolve(targetDir, entry.fileName);

                if (!entryPath.startsWith(absoluteTargetDir + path.sep)) {
                    closeZipFile();
                    reject(new Error(`Zip Slip detected: ${entry.fileName}`));
                    return;
                }

                if (/\/$/.test(entry.fileName)) {
                    fs.mkdirSync(entryPath, { recursive: true });
                    zipfile.readEntry();
                } else {
                    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            closeZipFile();
                            return reject(err);
                        }
                        if (!readStream) {
                            closeZipFile();
                            return reject(new Error('Could not read stream from ZIP'));
                        }

                        const writeStream = fs.createWriteStream(entryPath);
                        readStream.pipe(writeStream);

                        writeStream.on('finish', () => {
                            // If on linux/mac, ensure executable permission if it looks like a binary
                            if (process.platform !== 'win32') {
                                // Simple heuristic: if no extension or .sh, chmod +x
                                if (!path.extname(entryPath) || entryPath.endsWith('.sh')) {
                                    fs.chmodSync(entryPath, '755');
                                }
                            }
                            zipfile.readEntry();
                        });

                        writeStream.on('error', (err) => {
                            closeZipFile();
                            reject(err);
                        });
                        readStream.on('error', (err) => {
                            closeZipFile();
                            reject(err);
                        });
                    });
                }
            });

            zipfile.on('end', () => {
                closeZipFile();
                resolve();
            });

            zipfile.on('error', (err) => {
                closeZipFile();
                reject(err);
            });
        });
    });
}

/**
 * Finds the executable recursively
 */
function findExecutable(targetDir: string): string | null {
    // Look for copilot.exe or cli-proxy-api.exe or copilot (no ext)
    const platform = os.platform();
    const candidates = platform === 'win32'
        ? ['copilot.exe', 'cli-proxy-api.exe']
        : ['copilot', 'cli-proxy-api'];

    const items = fs.readdirSync(targetDir, { withFileTypes: true });

    // Check files in current dir
    for (const item of items) {
        if (item.isFile() && candidates.includes(item.name.toLowerCase())) {
            return path.join(targetDir, item.name);
        }
    }

    // Recurse
    for (const item of items) {
        if (item.isDirectory()) {
            const found = findExecutable(path.join(targetDir, item.name));
            if (found) return found;
        }
    }

    return null;
}

/**
 * Main orchestration for installing CLI
 */
export async function installCopilotCLI(
    onProgress: (percent: number) => void,
    outputChannel?: vscode.OutputChannel
): Promise<{ success: boolean; version: string; executablePath?: string; error?: string }> {
    const tempDir = os.tmpdir();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const zipPath = path.join(tempDir, 'CopilotCLI-Install.zip');
    const userProfile = process.env.USERPROFILE || os.homedir();
    const targetDir = path.join(userProfile, '.openroute', 'bin'); // More standard location

    try {
        outputChannel?.appendLine('[Installer] Fetching latest release information...');
        const release = await fetchLatestRelease();
        const asset = findAsset(release.assets);

        if (!asset) {
            return { success: false, version: '', error: `No compatible asset found for ${os.platform()}-${os.arch()}` };
        }

        outputChannel?.appendLine(`[Installer] Downloading from: ${asset.browser_download_url}`);
        outputChannel?.appendLine(`[Installer] Downloading from: ${asset.browser_download_url}`);
        const archiveName = path.basename(asset.browser_download_url);
        const archivePath = path.join(tempDir, archiveName);

        await downloadFile(asset.browser_download_url, archivePath, onProgress);

        outputChannel?.appendLine(`[Installer] Extracting to: ${targetDir}`);
        if (fs.existsSync(targetDir)) {
            // Optional: clean up old dir? Or just overwrite.
            // fs.rmSync(targetDir, { recursive: true, force: true });
        }
        await extractArchive(archivePath, targetDir);

        const foundExecutable = findExecutable(targetDir);
        if (foundExecutable) {
            outputChannel?.appendLine(`[Installer] Found executable at: ${foundExecutable}`);
            // Update configuration
            await vscode.workspace.getConfiguration('openroute.server').update('executablePath', foundExecutable, vscode.ConfigurationTarget.Global);
            outputChannel?.appendLine('[Installer] Configuration updated.');
        } else {
            outputChannel?.appendLine(`[Installer] WARN: Could not find executable in ${targetDir}`);
        }

        if (fs.existsSync(archivePath)) {
            fs.unlinkSync(archivePath);
        }

        outputChannel?.appendLine('[Installer] Installation complete.');
        return { success: true, version: release.tag_name, executablePath: foundExecutable || undefined };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel?.appendLine(`[Installer] Error: ${msg}`);

        if (fs.existsSync(zipPath)) {
            try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
        }

        return { success: false, version: '', error: msg };
    }
}
