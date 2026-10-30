'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createBridge } = require('./server');

const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';
const ID = /^[0-9a-f-]{36}$/;

function fakeSpawnFactory() {
    const children = [];
    const calls = [];
    function spawn(command, args, opts) {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => setImmediate(() => child.emit('close', null));
        calls.push({ command, args, opts });
        children.push(child);
        return child;
    }
    return { spawn, children, calls };
}

async function fixture() {
    const runner = fakeSpawnFactory();
    const bridge = createBridge({
        token: TOKEN, repos: { seekerclaw: '/srv/acp/repos/SeekerClaw' }, agents: ['codex', 'claude'],
    }, { spawn: runner.spawn, timeoutMs: 1500 });
    await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${bridge.server.address().port}`;
    async function api(method, route, payload, token = TOKEN) {
        const resp = await fetch(`${url}${route}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
            body: payload ? JSON.stringify(payload) : undefined,
        });
        return { status: resp.status, data: await resp.json() };
    }
    return { bridge, runner, api, async close() { await bridge.close(); } };
}

async function tick() { await new Promise(resolve => setImmediate(resolve)); }

function finish(child, reply = 'Report complete', code = 0) {
    child.stdout.write(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
    }) + '\n');
    child.stdout.end();
    child.emit('close', code);
}

test('rejects missing and incorrect bearer tokens', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.api('GET', '/v1/jobs', null, 'bad-token')).status, 401);
        assert.equal((await f.api('GET', '/healthz')).status, 200);
    } finally { await f.close(); }
});

test('rejects arbitrary agents, repositories and missing prompts', async () => {
    const f = await fixture();
    try {
        for (const payload of [
            { agent: 'sh', repo: 'seekerclaw', prompt: 'hi' },
            { agent: 'codex', repo: '../../etc', prompt: 'hi' },
            { agent: 'codex', repo: 'seekerclaw', prompt: '' },
            { agent: 'codex', repo: 'seekerclaw', prompt: 'bad\0prompt' },
        ]) assert.equal((await f.api('POST', '/v1/jobs', payload)).status, 400);
        assert.equal(f.runner.calls.length, 0);
    } finally { await f.close(); }
});

test('runs approved agent without a shell, parses ACP output and exposes no tool contents', async () => {
    const f = await fixture();
    try {
        const response = await f.api('POST', '/v1/jobs', {
            agent: 'codex', repo: 'seekerclaw', prompt: 'Inspect README and do not change anything',
        });
        assert.equal(response.status, 202);
        assert.match(response.data.id, ID);
        await tick();
        assert.equal(f.runner.calls.length, 1);
        const c = f.runner.calls[0];
        assert.equal(c.command, 'acpx');
        assert.equal(c.opts.cwd, '/srv/acp/repos/SeekerClaw');
        assert.equal(c.opts.shell, false);
        assert.deepEqual(c.args.slice(0, 4), ['--format', 'json', '--json-strict', '--suppress-reads']);
        assert.equal(c.args.includes('--approve-reads'), true);
        assert.equal(c.args.includes('--no-terminal'), true);
        assert.equal(c.args.at(-1), 'Inspect README and do not change anything');
        f.runner.children[0].stdout.write(JSON.stringify({
            method: 'session/update', params: { update: {
                sessionUpdate: 'tool_call', title: 'Secret contents', rawOutput: 'DO NOT LEAK',
            } },
        }) + '\n');
        finish(f.runner.children[0]);
        const detail = await f.api('GET', `/v1/jobs/${response.data.id}`);
        assert.equal(detail.data.status, 'done');
        assert.equal(detail.data.summary, 'Report complete');
        assert.equal(JSON.stringify(detail.data).includes('DO NOT LEAK'), false);
        assert.equal(detail.data.prompt, undefined);
    } finally { await f.close(); }
});

test('serializes jobs and can cancel queued jobs', async () => {
    const f = await fixture();
    try {
        const post = () => f.api('POST', '/v1/jobs', { agent: 'codex', repo: 'seekerclaw', prompt: 'Review it' });
        const first = (await post()).data;
        const second = (await post()).data;
        await tick();
        assert.equal(f.runner.calls.length, 1);
        const cancelled = await f.api('POST', `/v1/jobs/${second.id}/cancel`);
        assert.equal(cancelled.data.status, 'cancelled');
        finish(f.runner.children[0]);
        await tick();
        assert.equal(f.runner.calls.length, 1);
        assert.equal((await f.api('GET', `/v1/jobs/${first.id}`)).data.status, 'done');
    } finally { await f.close(); }
});

test('reports adapter failure without exposing stderr', async () => {
    const f = await fixture();
    try {
        const job = (await f.api('POST', '/v1/jobs', { agent: 'codex', repo: 'seekerclaw', prompt: 'Review it' })).data;
        await tick();
        f.runner.children[0].stderr.write('SECRET_ACCESS_TOKEN');
        f.runner.children[0].emit('close', 9);
        const detail = (await f.api('GET', `/v1/jobs/${job.id}`)).data;
        assert.equal(detail.status, 'failed');
        assert.equal(detail.exitCode, 9);
        assert.equal(JSON.stringify(detail).includes('SECRET_ACCESS_TOKEN'), false);
    } finally { await f.close(); }
});
