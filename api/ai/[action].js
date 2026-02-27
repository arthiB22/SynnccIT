/**
 * Vercel Serverless Function — handles all 6 AI testing actions.
 * Route: /api/ai/[action]  (e.g. /api/ai/quick-test)
 *
 * Uses OPENROUTER_API_KEY from Vercel environment variables.
 * No Python backend needed — works fully on Vercel.
 */
export default async function handler(req, res) {
    // CORS headers so the front-end can call this from any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { action } = req.query;
    const { code = '', language = 'python', selected_text, user_input } = req.body || {};

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL_LINK || 'arcee-ai/trinity-large-preview:free';

    if (!OPENROUTER_API_KEY) {
        return res.status(503).json({
            error: 'OPENROUTER_API_KEY is not set in Vercel environment variables.\n'
                + 'Go to Vercel → Project → Settings → Environment Variables and add OPENROUTER_API_KEY.',
        });
    }

    // Selected text has priority over the full file
    const target = (selected_text && selected_text.trim()) ? selected_text.trim() : code;
    const scope = (selected_text && selected_text.trim()) ? '(selected snippet)' : '(full file)';

    const prompts = {
        'quick-test': {
            system: 'You are a senior code reviewer. Give a crisp, bullet-style review. '
                + 'Cover: correctness, edge cases, style, potential bugs, performance. '
                + 'Max 10 bullets. End with an overall verdict.',
            user: `Review this ${language} ${scope} code:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'generate-tests': {
            system: 'You are a test engineer. Generate 5 meaningful test cases with Input and Expected Output. '
                + 'Then suggest debug print placements. Keep it practical.',
            user: `Code ${scope}:\n\`\`\`${language}\n${target}\n\`\`\``,
        },
        'code-explain': {
            system: 'You are an expert code explainer. For each logical block: state WHAT it does, '
                + 'WHY it does it, note patterns/algorithms, flag potential issues. '
                + 'Use clear headers and bullet points.',
            user: `Explain this ${language} code:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'simulate': {
            system: user_input
                ? 'You are a code runtime simulator. Trace through the code with the given user input, '
                + 'show the expected output step by step, and explain any potential errors.'
                : 'You are a code analyst. Describe exactly what inputs this code needs (type, format, count). '
                + 'Give 2-3 concrete example input sets the user can try.',
            user: user_input
                ? `Code:\n\`\`\`${language}\n${target}\n\`\`\`\n\nUser input: ${user_input}\n\nSimulate this execution.`
                : `What inputs does this code need?\n\n\`\`\`${language}\n${target}\n\`\`\``,
        },
        'reduce-complexity': {
            system: 'You are an algorithm optimisation expert. Provide:\n'
                + '1. Current Complexity Analysis (Time + Space Big-O with explanation)\n'
                + '2. Optimisation Suggestions (ranked by impact, include code snippets)\n'
                + '3. Data Structure Recommendations\n'
                + '4. At the very end, on their own lines:\n'
                + '   EFFICIENCY_SCORE: <0-100>\n'
                + '   SCALABILITY_SCORE: <0-100>',
            user: `Analyse and optimise this ${language} ${scope} code:\n\n\`\`\`\n${target}\n\`\`\``,
        },
        'redesign': {
            system: 'You are a senior software architect. Provide:\n'
                + '1. Brief current design analysis\n'
                + '2. Complete redesigned code implementing the user requirements\n'
                + '3. Changes summary with bullet points',
            user: `Requirements: ${user_input || 'Improve overall design and structure'}\n\n`
                + `Code to redesign:\n\`\`\`${language}\n${target}\n\`\`\``,
        },
    };

    const prompt = prompts[action];
    if (!prompt) {
        return res.status(400).json({ error: `Unknown action: ${action}. Valid: quick-test, generate-tests, code-explain, simulate, reduce-complexity, redesign` });
    }

    try {
        const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://sync-it-ecru.vercel.app',
                'X-Title': 'SynnccIT Testing Page',
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

        if (!aiRes.ok) {
            const errText = await aiRes.text();
            return res.status(502).json({ error: `OpenRouter API error ${aiRes.status}: ${errText.slice(0, 300)}` });
        }

        const data = await aiRes.json();
        const result = data.choices?.[0]?.message?.content?.trim() || 'No response from AI.';

        // Parse scores for reduce-complexity
        let metrics = null;
        if (action === 'reduce-complexity') {
            let efficiency = 50, scalability = 50;
            for (const line of result.split('\n')) {
                if (line.includes('EFFICIENCY_SCORE:')) {
                    try { efficiency = parseInt(line.split(':')[1].trim(), 10); } catch { }
                }
                if (line.includes('SCALABILITY_SCORE:')) {
                    try { scalability = parseInt(line.split(':')[1].trim(), 10); } catch { }
                }
            }
            metrics = { efficiency, scalability };
        }

        return res.json({ result, metrics, test_results: null });

    } catch (err) {
        return res.status(500).json({ error: `Request failed: ${err.message}` });
    }
}
