/**
 * Vercel Serverless Function — Cloud Terminal command runner.
 * File: api/terminal.js
 * Route: POST /api/terminal
 *
 * Uses CommonJS for maximum Vercel compatibility.
 * Accepts: { command: string, cwd: string }
 * Returns: { output: string, error: string, newCwd: string }
 */

const { exec } = require('child_process');
const path = require('path');

// Patterns that could damage the ephemeral serverless environment
const BLOCKED_PATTERNS = [
    'rm -rf /',
    'sudo ',
    'shutdown',
    'reboot',
    'mkfs',
    'dd if=',
    'curl | sh',
    'wget | sh',
    '> /dev/sd',
    'chmod 777 /',
    ':(){:|:&};:',   // fork bomb
];

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')
        return res.status(405).json({ output: '', error: 'Method not allowed', newCwd: '/tmp' });

    const { command = '', cwd = '/tmp' } = req.body || {};

    if (!command.trim()) {
        return res.json({ output: '', error: '', newCwd: cwd });
    }

    const cmd = command.trim();
    const lower = cmd.toLowerCase();

    // Safety gate
    for (const pattern of BLOCKED_PATTERNS) {
        if (lower.includes(pattern)) {
            return res.json({
                output: '',
                error: `\u26D4 Blocked: "${pattern}" is not allowed.`,
                newCwd: cwd,
            });
        }
    }

    // Handle `cd` specially — it's a shell built-in that exec() won't persist,
    // so we resolve the new path and return it so the client can track cwd.
    const cdMatch = cmd.match(/^cd\s*(.*)?$/);
    if (cdMatch) {
        const target = cdMatch[1] ? cdMatch[1].trim() : process.env.HOME || '/tmp';
        let newCwd;
        try {
            newCwd = target.startsWith('/')
                ? target
                : path.resolve(cwd, target);
        } catch {
            newCwd = cwd;
        }
        return res.json({ output: '', error: '', newCwd });
    }

    return new Promise((resolve) => {
        exec(
            cmd,
            {
                cwd: cwd,
                timeout: 10000,         // 10 s
                maxBuffer: 512 * 1024,    // 512 KB
                env: { ...process.env, TERM: 'xterm', FORCE_COLOR: '0' },
            },
            (error, stdout, stderr) => {
                resolve(
                    res.json({
                        output: stdout || '',
                        error: stderr || (error && !stderr ? error.message : ''),
                        newCwd: cwd,   // cwd doesn't change for non-cd commands
                    })
                );
            }
        );
    });
};
