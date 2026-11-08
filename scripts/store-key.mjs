// Accepts a key on stdin. No key in command arguments, files, or logs.
import { createInterface } from 'node:readline';
import { ConfigManager } from '../dist/core/config.js';
import { SecretVault } from '../dist/core/secrets.js';
const provider = process.argv[2];
const config = new ConfigManager();
await config.load();
if (!provider || !config.settings.providers[provider]) throw new Error('Enter a valid provider preset.');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
const input = createInterface({ input: process.stdin, terminal: false });
const key = await new Promise(resolve => input.once('line', resolve));
input.close();
if (process.stdin.isTTY) process.stdin.setRawMode(false);
await new SecretVault(config.home).set(provider, String(key).trim());
console.log('Credential stored with Windows DPAPI.');
