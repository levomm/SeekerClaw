'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleAcpCommand, resolveBridgeConfig } = require('../../app/src/main/assets/nodejs-project/acp-remote');

const VALID = { SEEKER_ACP_URL: 'https://acp.example.org', SEEKER_ACP_TOKEN: '0123456789abcdef0123456789abcdef' };
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';

test('requires HTTPS off-loopback and rejects embedded URL credentials', () => {
    assert.throws(() => resolveBridgeConfig({ ...VALID, SEEKER_ACP_URL: 'http://evil.example' }));
    assert.throws(() => resolveBridgeConfig({ ...VALID, SEEKER_ACP_URL: 'https://x:y@evil.example' }));
    assert.throws(() => resolveBridgeConfig({ ...VALID, SEEKER_ACP_URL: 'https://good.example/other' }));
    assert.equal(resolveBridgeConfig(VALID).url.origin, 'https://acp.example.org');
});

test('help works when bridge is disabled', async () => {
    assert.match(await handleAcpCommand('help', { env: {} }), /ACP delegation/);
    assert.match(await handleAcpCommand('list', { env: {} }), /disabled/);
});

test('submits free-form prompt and returns job identifier', async () => {
    const seen = [];
    const response = await handleAcpCommand('codex seekerclaw Review\nthis module', {
        env: VALID,
        request: async (...args) => {
            seen.push(args);
            return { id: JOB_ID, agent: 'codex', repo: 'seekerclaw', status: 'queued' };
        },
    });
    assert.match(response, new RegExp(JOB_ID));
    assert.equal(seen[0][1], 'POST');
    assert.equal(seen[0][2], '/v1/jobs');
    assert.equal(seen[0][3].prompt, 'Review\nthis module');
});

test('uses GET for status, POST for cancel and rejects malformed job IDs', async () => {
    const ops = [];
    const opts = { env: VALID, request: async (_config, method, route) => {
        ops.push([method, route]);
        return { id: JOB_ID, agent: 'codex', repo: 'seekerclaw', status: 'running' };
    } };
    await handleAcpCommand(`status ${JOB_ID}`, opts);
    await handleAcpCommand(`cancel ${JOB_ID}`, opts);
    assert.deepEqual(ops, [
        ['GET', `/v1/jobs/${JOB_ID}`], ['POST', `/v1/jobs/${JOB_ID}/cancel`],
    ]);
    assert.match(await handleAcpCommand('status ../../../etc/passwd', opts), /ACP delegation/);
});

test('invalid bridge URL reports an error to Telegram instead of crashing handler', async () => {
    const text = await handleAcpCommand('list', { env: { ...VALID, SEEKER_ACP_URL: 'http://unsafe.example' } });
    assert.match(text, /ACP bridge unavailable/);
});
