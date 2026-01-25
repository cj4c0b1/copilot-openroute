import fetch from 'node-fetch';

export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

export interface AccessTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
    error_uri?: string;
}

export class DeviceCodeManager {
    // Official VS Code Client ID for Copilot
    private static readonly DEFAULT_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
    private clientId: string;

    constructor(clientId?: string) {
        this.clientId = clientId || DeviceCodeManager.DEFAULT_CLIENT_ID;
        console.log(`[DeviceCodeManager] Initialized with Client ID: ${this.clientId}`);
    }

    public async requestDeviceCode(): Promise<DeviceCodeResponse> {
        console.log('[DeviceCodeManager] Requesting device code...');
        const response = await fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: this.clientId,
                scope: 'read:user read:org repo workflow copilot' // Broad scopes to ensure full access
                // NOTE: Copilot often uses specific scopes, but VS Code client ID is whitelisted. 
                // We'll trust the whitelist or investigate if 'copilot' scope is needed explicitly.
                // Research suggests just client_id is enough for device flow initiation on whitelisted apps.
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to request device code: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as DeviceCodeResponse;
        console.log('[DeviceCodeManager] Device code received:', data.user_code);
        return data;
    }

    public async pollForToken(deviceCode: string, interval: number): Promise<AccessTokenResponse> {
        console.log('[DeviceCodeManager] Polling for token...');

        let isAuthorized = false;
        while (!isAuthorized) {
            await new Promise(resolve => setTimeout(resolve, interval * 1000));

            const response = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    client_id: this.clientId,
                    device_code: deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
                })
            });

            if (!response.ok) {
                // Network error or server error
                throw new Error(`Polling failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as AccessTokenResponse;

            if (data.error) {
                if (data.error === 'authorization_pending') {
                    // Continue polling
                    continue;
                } else if (data.error === 'slow_down') {
                    // Increase interval
                    interval += 5;
                    continue;
                } else if (data.error === 'expired_token') {
                    throw new Error('Device code expired. Please try logging in again.');
                } else {
                    throw new Error(`Auth Error: ${data.error_description || data.error}`);
                }
            }

            if (data.access_token) {
                console.log('[DeviceCodeManager] Token received!');
                isAuthorized = true;
                return data;
            }
        }
        throw new Error('Polling finished without token'); // Should never reach here
    }
}
