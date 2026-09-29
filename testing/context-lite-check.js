'use strict';

const assert = require('assert');
const {
    CORE_TOOL_NAMES,
    usesDeferredToolLoading,
    getDiscoveredToolNames,
    resetDiscoveredToolsForChat,
    selectDeferredTools,
    wrapFormatTools,
} = require('../app/src/main/assets/nodejs-project/deferred-tools');
const { compactStablePrompt } = require('../app/src/main/assets/nodejs-project/prompt-compact');

const sample = [
    { name: 'read' },
    { name: 'write' },
    { name: 'web_search' },
    { name: 'web_fetch' },
    { name: 'datetime' },
    { name: 'tool_search' },
    { name: 'android_call' },
    { name: 'solana_swap' },
];

assert.deepStrictEqual(
    selectDeferredTools(sample, new Set()).map(t => t.name),
    [...CORE_TOOL_NAMES],
    'cold turn should expose only core tools'
);

assert.deepStrictEqual(
    selectDeferredTools(sample, new Set(['android_call'])).map(t => t.name),
    [...CORE_TOOL_NAMES, 'android_call'],
    'discovered tool should be added on the next round'
);

assert.strictEqual(usesDeferredToolLoading('openai'), true);
assert.strictEqual(usesDeferredToolLoading('xai'), true);
assert.strictEqual(usesDeferredToolLoading('custom'), true);
assert.strictEqual(usesDeferredToolLoading('claude'), false);
assert.strictEqual(usesDeferredToolLoading('openrouter'), false);

global._discoveredToolsByChat = new Map([
    ['tg:owner', new Set(['android_call'])],
    ['cron:frantic', new Set(['solana_swap'])],
]);
assert.deepStrictEqual(
    getDiscoveredToolNames('tg:owner'),
    new Set(['android_call']),
    'Telegram discovery must not inherit cron-discovered tools'
);
assert.deepStrictEqual(
    getDiscoveredToolNames('cron:frantic'),
    new Set(['solana_swap']),
    'cron discovery must stay isolated from Telegram'
);
assert.strictEqual(resetDiscoveredToolsForChat('tg:owner'), true);
assert.deepStrictEqual(
    getDiscoveredToolNames('tg:owner'),
    new Set(),
    'fresh user turn must clear only that chat scratch state'
);
assert.deepStrictEqual(
    getDiscoveredToolNames('cron:frantic'),
    new Set(['solana_swap']),
    'clearing Telegram scratch must not erase another session'
);

const adapter = {
    id: 'openai',
    formatTools(tools) { return tools.map(t => t.name); },
};
wrapFormatTools(adapter);
global._discoveredToolsByChat = new Map([['chat', new Set(['solana_swap'])]]);
assert.deepStrictEqual(
    adapter.formatTools(sample),
    [...CORE_TOOL_NAMES, 'solana_swap'],
    'wrapped adapter should honor tool_search discoveries'
);

const openRouterAdapter = {
    id: 'openrouter',
    formatTools(tools) { return tools.map(t => t.name); },
};
wrapFormatTools(openRouterAdapter);
assert.deepStrictEqual(
    openRouterAdapter.formatTools(sample),
    sample.map(t => t.name),
    'OpenRouter must keep the full toolset until model capability detection is reliable'
);

const promptFixture = [
    '## Tooling',
    'very long tooling manual line 1',
    'very long tooling manual line 2',
    '### Burner policy (BAT-1013)',
    'very long burner details',
    '## Project Context',
    '## MEMORY.md',
    'remember-this-exactly',
    '## Error Recovery',
    'very long recovery manual',
].join('\n');

const compactedFixture = compactStablePrompt(promptFixture);
assert.ok(
    compactedFixture.replacedSections.includes('## Tooling')
        && compactedFixture.replacedSections.includes('## Error Recovery'),
    'compact profile should replace the selected static manual sections'
);
assert.ok(
    compactedFixture.prompt.includes('## MEMORY.md\nremember-this-exactly'),
    'prompt compaction must preserve MEMORY.md content byte-for-byte'
);
assert.ok(
    !compactedFixture.prompt.includes('very long burner details'),
    'nested tooling/burner manual should be replaced by compact guidance'
);
assert.ok(
    !compactedFixture.prompt.includes('very long recovery manual'),
    'error-recovery manual should be replaced by compact guidance'
);

const secondaryFixture = [
    '## Diagnostics',
    'huge diagnostics manual',
    '## Heartbeats',
    'huge heartbeat manual',
    '## Session Memory',
    'huge session memory manual',
    '## Project Context',
    '## MEMORY.md',
    'memory-v3-keep-me-exactly',
].join('\n');

const secondaryCompacted = compactStablePrompt(secondaryFixture);
assert.ok(
    secondaryCompacted.replacedSections.includes('## Diagnostics')
        && secondaryCompacted.replacedSections.includes('## Heartbeats')
        && secondaryCompacted.replacedSections.includes('## Session Memory'),
    'secondary static manuals should be compacted'
);
assert.ok(
    secondaryCompacted.prompt.includes('## MEMORY.md\nmemory-v3-keep-me-exactly'),
    'secondary compaction must preserve persistent memory content'
);
assert.ok(!secondaryCompacted.prompt.includes('huge diagnostics manual'));
assert.ok(!secondaryCompacted.prompt.includes('huge heartbeat manual'));
assert.ok(!secondaryCompacted.prompt.includes('huge session memory manual'));

console.log('context-lite-check: PASS');
