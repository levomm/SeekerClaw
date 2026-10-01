#!/usr/bin/env node
// hive-fallback.test.js — deterministic regression coverage for OSZ Hive DeepSeek fallback.
//
// Covers:
//  - Hive endpoint/model/key wiring
//  - SSE Accept header
//  - DeepSeek V4 reasoning_content preservation and replay gating
//  - Chat Completions stream assembler preserving reasoning_content
//  - Static fallback wiring in ai.js + cron.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE = path.join(ROOT, 'app/src/main/assets/nodejs-project');

// Stub config before loading http/openrouter/hive.
const configPath = path.join(NODE, 'config.js');
require.cache[configPath] = {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: {
        log: () => {},
        API_TIMEOUT_MS: 5000,
        OPENROUTER_FALLBACK_MODEL: '',
    },
};

process.env.HIVE_API_KEY = 'test_hive_key';
process.env.HIVE_BASE_URL = 'https://api-cdn.thehive.ai/api/v3';
process.env.HIVE_MODEL = 'deepseek-ai/deepseek-v4.1-flash';

const hive = require(path.join(NODE, 'providers/hive.js'));
const { httpChatCompletionsStreamingRequest } = require(path.join(NODE, 'http.js'));

function testAdapter() {
    assert.equal(hive.isConfigured(), true);
    assert.equal(hive.getModel(), 'deepseek-ai/deepseek-v4.1-flash');

    const endpoint = hive.getEndpoint();
    assert.equal(endpoint.protocol, 'https:');
    assert.equal(endpoint.hostname, 'api-cdn.thehive.ai');
    assert.equal(endpoint.path, '/api/v3/chat/completions');

    const headers = hive.buildHeaders();
    assert.equal(headers.Authorization, 'Bearer test_hive_key');
    assert.equal(headers.Accept, 'text/event-stream');
    assert.equal(headers['Content-Type'], 'application/json');

    const parsed = hive.fromApiResponse({
        id: 'hive-turn-1',
        model: 'deepseek-ai/deepseek-v4.1-flash',
        choices: [{
            finish_reason: 'tool_calls',
            message: {
                role: 'assistant',
                content: 'checking',
                reasoning_content: 'reasoning bytes',
                tool_calls: [{
                    id: 'tc1',
                    type: 'function',
                    function: { name: 'echo', arguments: '{}' },
                }],
            },
        }],
        usage: {},
    });

    assert.equal(parsed.reasoningBlocks.length, 1);
    assert.equal(parsed.reasoningBlocks[0].provider, 'hive');
    assert.equal(parsed.reasoningBlocks[0].sourceAdapter, 'hive');
    assert.equal(parsed.reasoningBlocks[0].delegateAdapter, 'openrouter');
    assert.equal(parsed.reasoningBlocks[0].wire.reasoning_content, 'reasoning bytes');

    const replay = hive.toApiMessages([
        { role: 'user', content: 'q' },
        {
            role: 'assistant',
            content: parsed.text,
            toolCalls: parsed.toolCalls,
            reasoningBlocks: parsed.reasoningBlocks,
        },
        { role: 'tool', toolCallId: 'tc1', content: 'ok' },
    ], hive.getModel());

    const assistant = replay.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'reasoning bytes');

    const body = JSON.parse(hive.formatRequest(
        hive.getModel(),
        4096,
        'system',
        [{ role: 'user', content: 'hello' }],
        [],
    ));
    assert.equal(body.model, 'deepseek-ai/deepseek-v4.1-flash');
    assert.equal(body.stream, true);
    assert.equal(body.messages[0].role, 'system');
}

async function testStreamingReasoningPreservation() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"model":"deepseek-ai/deepseek-v4.1-flash","choices":[{"delta":{"reasoning_content":"abc"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"reasoning_content":"123","tool_calls":[{"index":0,"id":"tc1","function":{"name":"echo","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        res.end('data: [DONE]\n\n');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const port = server.address().port;
        const response = await httpChatCompletionsStreamingRequest({
            protocol: 'http:',
            hostname: '127.0.0.1',
            port,
            path: '/chat/completions',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000,
        }, '{}');

        assert.equal(response.status, 200);
        const msg = response.data.choices[0].message;
        assert.equal(msg.reasoning_content, 'abc123');
        assert.equal(msg.tool_calls[0].function.name, 'echo');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function testFallbackWiring() {
    const ai = fs.readFileSync(path.join(NODE, 'ai.js'), 'utf8');
    const cron = fs.readFileSync(path.join(NODE, 'cron.js'), 'utf8');

    assert.match(ai, /\[HiveFallback\] OpenAI usage_limit_reached/);
    assert.match(ai, /providerOverride:\s*'hive'/);
    assert.match(ai, /getUsageLimitState\(\)\.active/);
    assert.match(cron, /HIVE_API_KEY/);
    assert.match(cron, /running .* via Hive DeepSeek fallback/);
}

(async () => {
    testAdapter();
    await testStreamingReasoningPreservation();
    testFallbackWiring();
    console.log('PASS: Hive DeepSeek fallback adapter + stream + wiring');
})().catch((err) => {
    console.error(err.stack || err);
    process.exit(1);
});
