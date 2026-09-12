'use strict';

const assert = require('assert');
const {
    CORE_TOOL_NAMES,
    usesDeferredToolLoading,
    selectDeferredTools,
    wrapFormatTools,
} = require('../app/src/main/assets/nodejs-project/deferred-tools');

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

console.log('context-lite-check: PASS');
