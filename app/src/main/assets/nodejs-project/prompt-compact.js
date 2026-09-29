'use strict';

const DEFAULT_REPLACEMENTS = new Map([
    ['## Tooling', [
        '## Tooling',
        'Tools are provided through the tool schema. Call them by exact name and discover deferred tools with tool_search when needed.',
        'Load detailed operational rules only when relevant: use skill_read for the matching skill and read DIAGNOSTICS.md for deep troubleshooting.',
        'For Solana/Jupiter actions: quote before swap, surface the actual tool error, never bypass a security reject, and let the system confirmation gate own approvals.',
        'Do not repeat an identical failing tool call; adapt or inspect diagnostics.',
        '',
    ]],
    ['## Error Recovery', [
        '## Error Recovery',
        'If a tool/API call fails, inspect the real error, adapt once, then use node_debug.log / DIAGNOSTICS.md instead of repeating the same action.',
        '401/403 usually means auth/access; 404 can mean a bad model/tool target; 429 means rate/usage pressure and must not trigger tight retries beyond the built-in retry policy.',
        'Telegram replies should stay concise and scannable. Rich formatting depends on the current channel setting; do not rely on formatting for critical meaning.',
        '',
    ]],
    ['## Config Awareness', [
        '## Config Awareness',
        'Runtime settings live in agent_settings.json. Provider/model can change between turns.',
        'Secrets/API keys belong in agent_settings.json or environment variables, never MEMORY.md or daily memory. Never reveal secret values.',
        'Use /model and /provider for supported chat-side switches. Read PLATFORM.md or DIAGNOSTICS.md only when configuration troubleshooting is actually needed.',
        '',
    ]],
    ['## Self-Diagnosis Playbook', [
        '## Self-Diagnosis Playbook',
        'For failures, inspect agent_health_state and recent node_debug.log entries first. Use DIAGNOSTICS.md for the detailed playbook only when a problem occurs.',
        'For message transport issues, inspect Telegram/Discord polling or gateway errors and network/DNS errors before guessing.',
        'For skill issues, inspect the skill file and its requirements. For corrupted/looping conversation, /new archives before clearing; /reset is destructive.',
        '',
    ]],
    ['## Tool Confirmation Gates', [
        '## Tool Confirmation Gates',
        'Dangerous or fund-moving tools use the system confirmation gate. Do not add your own duplicate YES/NO prompt or confirmation buttons.',
        'Some capped burner actions may execute silently by policy. Main-wallet, over-cap, or otherwise gated actions are confirmed by the system. One action = one confirmation.',
        'Never bypass a security rejection. Read DIAGNOSTICS.md for the full confirmation/burner policy only when explaining or debugging one of these actions.',
        '',
    ]],
]);

function compactStablePrompt(prompt, { enabled = true } = {}) {
    if (!enabled || typeof prompt !== 'string' || prompt.length === 0) {
        return { prompt: prompt || '', savedChars: 0, replacedSections: [] };
    }

    const lines = prompt.split('\n');
    const out = [];
    const replacedSections = [];
    let skipLevel = 0;

    for (const line of lines) {
        const heading = line.match(/^(#{1,2})\s+.+$/);

        if (skipLevel > 0) {
            if (!heading || heading[1].length > skipLevel) continue;
            skipLevel = 0;
        }

        const replacement = DEFAULT_REPLACEMENTS.get(line);
        if (replacement) {
            out.push(...replacement);
            replacedSections.push(line);
            const level = (line.match(/^#+/) || ['##'])[0].length;
            skipLevel = level;
            continue;
        }

        out.push(line);
    }

    const compact = out.join('\n');
    return {
        prompt: compact,
        savedChars: Math.max(0, prompt.length - compact.length),
        replacedSections,
    };
}

module.exports = {
    DEFAULT_REPLACEMENTS,
    compactStablePrompt,
};
