/**
 * Vercel Serverless Function — Cloud Terminal
 * Route: POST /api/terminal
 *
 * ESM format (required by "type": "module" in package.json).
 * Accepts: { command: string, cwd: string }
 * Returns: { output: string, error: string, newCwd: string }
 */

import { exec } from 'child_process';
import path from 'path';

const BLOCKED = [
    'rm -rf /', 'sudo ', 'shutdown', 'reboot', 'mkfs ', 'dd if=',
    ':(){:|:&};:', 'chmod 777 /', '> /dev/sd'
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ output: '', error: 'POST only', newCwd: '/tmp' });

    try {
        const { command = '', cwd = '/tmp' } = req.body || {};
        const cmd = command.trim();

        if (!cmd) return res.json({ output: '', error: '', newCwd: cwd });

        // Safety check
        const lower = cmd.toLowerCase();
        for (const p of BLOCKED) {
            if (lower.includes(p)) {
                return res.json({ output: '', error: `⛔ Blocked: "${p}"`, newCwd: cwd });
            }
        }

        // Handle `cd` — stateless, so we resolve the path and return it
        const cdMatch = cmd.match(/^cd\s*(.*)$/);
        if (cdMatch) {
            const target = (cdMatch[1] || '').trim() || '/tmp';
            const newCwd = target.startsWith('/') ? target : path.resolve(cwd, target);
            return res.json({ output: '', error: '', newCwd });
        }

        // Execute normal command
        return await new Promise((resolve) => {
            exec(cmd, {
                cwd,
                timeout: 10_000,
                maxBuffer: 512 * 1024,
                env: { ...process.env, TERM: 'xterm', FORCE_COLOR: '0' }
            }, (error, stdout, stderr) => {
                resolve(res.json({
                    output: stdout || '',
                    error: stderr || (error && !stderr ? error.message : ''),
                    newCwd: cwd
                }));
            });
        });

    } catch (err) {
        console.error('Terminal function error:', err);
        return res.status(500).json({ output: '', error: `Server error: ${err.message}`, newCwd: '/tmp' });
    }
}
