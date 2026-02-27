/**
 * Vercel Serverless Function — Simple command executor for the cloud terminal.
 * Route: /api/terminal
 *
 * Accepts: POST { command: string }
 * Returns: { output: string, error: string }
 *
 * Provides a basic "throw command → get output" terminal for cloud deployments.
 * Not a PTY — no interactive programs (vim, top, etc.), but works for
 * ls, cat, echo, python3, node, git status, etc.
 */
import { exec } from 'child_process';

// Commands that could damage the environment
const BLOCKED_PATTERNS = [
    'rm -rf /', 'sudo ', 'shutdown', 'reboot', 'mkfs', 'dd if=',
    'curl | sh', 'wget | sh', '> /dev/sda', 'chmod 777 /',
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { command, cwd } = req.body || {};

    if (!command || typeof command !== 'string' || !command.trim()) {
        return res.status(400).json({ output: '', error: 'No command provided.' });
    }

    const cmd = command.trim();

    // Safety check
    const lower = cmd.toLowerCase();
    for (const pattern of BLOCKED_PATTERNS) {
        if (lower.includes(pattern)) {
            return res.json({ output: '', error: `⛔ Command blocked for security: "${pattern}"` });
        }
    }

    return new Promise((resolve) => {
        exec(
            cmd,
            {
                timeout: 10000,   // 10s max
                maxBuffer: 512 * 1024, // 512KB
                cwd: cwd || '/tmp',
                env: { ...process.env, TERM: 'xterm' },
            },
            (error, stdout, stderr) => {
                resolve(
                    res.json({
                        output: stdout || '',
                        error: stderr || (error && !stderr ? error.message : ''),
                    })
                );
            }
        );
    });
}
