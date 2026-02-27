/**
 * Vercel Serverless Function — handles all 6 AI testing actions.
 * File: api/ai/[action].js
 * Auto-routed by Vercel to:  /api/ai/quick-test, /api/ai/code-explain, etc.
 *
 * Uses CommonJS (module.exports) for maximum Vercel compatibility.
 * Reads OPENROUTER_API_KEY from Vercel environment variables.
 */

module.exports = async function handler(req, res) {
    // ── CORS ─────────────────────────────────────────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')
        return res.status(405).json({ error: 'Method not allowed. Use POST.' });

    // ── Route params ──────────────────────────────────────────────────────────
    const action = req.query.action;

    // ── Body parsing ──────────────────────────────────────────────────────────
    const { code = '', language = 'python', selected_text, user_input } = req.body || {};

    // ── Environment ───────────────────────────────────────────────────────────
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL_LINK
        || 'arcee-ai/trinity-large-preview:free';

    if (!OPENROUTER_API_KEY) {
        return res.status(503).json({
            error:
                'OPENROUTER_API_KEY is not configured.\n'
                + 'Go to Vercel → Project → Settings → Environment Variables\n'
                + 'and add OPENROUTER_API_KEY with your OpenRouter key.',
        });
    }

    // ── Target code: drag-selection takes priority over full file ─────────────
    const target = (selected_text && selected_text.trim()) ? selected_text.trim() : code;
    const scope = (selected_text && selected_text.trim()) ? '(selected snippet)' : '(full file)';

    // ── Prompt map ────────────────────────────────────────────────────────────
    const prompts = {
        'quick-test': {
            system:
                'You are a senior code reviewer. Give a crisp, bullet-style review. '
                + 'Cover: correctness, edge cases, style, potential bugs, performance. '
                + 'Max 10 bullets. End with an overall VERDICT line.',
            user: `Review this ${language} ${scope} code:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'generate-tests': {
            system:
                'You are a test engineer. Generate 5 meaningful test cases.\n'
                + 'Format each as:\n'
                + '  Test Case N:\n  Input: <value>\n  Expected Output: <value>\n\n'
                + 'Then suggest debug print placements.',
            user: `Code ${scope}:\n\`\`\`${language}\n${target}\n\`\`\``,
        },
        'code-explain': {
            system:
                'You are an expert code explainer. For each logical block: state WHAT it does, '
                + 'WHY it does it, note patterns/algorithms used, flag potential issues. '
                + 'Use clear headers and bullet points.',
            user: `Explain this ${language} code:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'simulate': {
            system: user_input
                ? 'You are a code runtime simulator. Trace through the code with the given input, '
                + 'show every step, the expected output, and any possible errors.'
                : 'You are a code analyst. Tell the user exactly what inputs this code expects '
                + '(type, format, count). Give 2-3 concrete example inputs they can try.',
            user: user_input
                ? `Code:\n\`\`\`${language}\n${target}\n\`\`\`\n\nUser input provided: ${user_input}\n\nSimulate step by step.`
                : `What inputs does this code need?\n\n\`\`\`${language}\n${target}\n\`\`\``,
        },
        'reduce-complexity': {
            system:
                'You are an algorithm optimisation expert. Provide:\n'
                + '1. Current Complexity Analysis (Time + Space Big-O)\n'
                + '2. Optimisation Suggestions (ranked by impact, include code snippets)\n'
                + '3. Data Structure Recommendations\n'
                + 'At the very end of your response, on their own lines:\n'
                + '   EFFICIENCY_SCORE: <0-100>\n'
                + '   SCALABILITY_SCORE: <0-100>',
            user: `Analyse and optimise this ${language} ${scope}:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'redesign': {
            system:
                'You are a senior software architect. Provide:\n'
                + '1. Brief current design analysis\n'
                + '2. Complete redesigned code implementing the user requirements\n'
                + '3. Changes summary (bullet points)',
            user:
                `Requirements: ${user_input || 'Improve overall design and structure'}\n\n`
                + `Code to redesign:\n\`\`\`${language}\n${target}\n\`\`\``,
        },
    };

    const prompt = prompts[action];
    if (!prompt) {
        return res.status(400).json({
            error: `Unknown action: "${action}". Valid actions: quick-test, generate-tests, code-explain, simulate, reduce-complexity, redesign`,
        });
    }

    // ── Call OpenRouter ───────────────────────────────────────────────────────
    try {
        const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://sync-it-ecru.vercel.app',
                'X-Title': 'SynnccIT',
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user },
                ],
                max_tokens: 1800,
                temperature: 0.3,
            }),
        });

        if (!aiResponse.ok) {
            const errBody = await aiResponse.text();
            return res.status(502).json({
                error: `OpenRouter returned HTTP ${aiResponse.status}: ${errBody.slice(0, 400)}`,
            });
        }

        const data = await aiResponse.json();
        const result = data.choices?.[0]?.message?.content?.trim()
            || 'AI returned an empty response.';

        // Parse complexity scores if present
        let metrics = null;
        if (action === 'reduce-complexity') {
            let efficiency = 50, scalability = 50;
            for (const line of result.split('\n')) {
                if (line.includes('EFFICIENCY_SCORE:')) {
                    const n = parseInt(line.split(':')[1], 10);
                    if (!isNaN(n)) efficiency = n;
                }
                if (line.includes('SCALABILITY_SCORE:')) {
                    const n = parseInt(line.split(':')[1], 10);
                    if (!isNaN(n)) scalability = n;
                }
            }
            metrics = { efficiency, scalability };
        }

        return res.json({ result, metrics, test_results: null });

    } catch (err) {
        return res.status(500).json({ error: `Request to OpenRouter failed: ${err.message}` });
    }
};
