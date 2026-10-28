'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const bundle = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const { DeliveryOutbox } = require(path.join(bundle, 'delivery-outbox'));
const { createRuntimeSettings } = require(path.join(bundle, 'runtime-settings'));
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osz-regression-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function load(name, deps) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(bundle, name), 'utf8'), {
        module, exports: module.exports, Buffer, setTimeout, clearTimeout, console, URL,
        require: id => Object.hasOwn(deps, id) ? deps[id] : require(id.startsWith('.') ? path.join(bundle, id) : id),
    }, { filename: name });
    return module.exports;
}
function fixture(t, mode = 'ok', rich = true) {
    const root = temp(t), workDir = path.join(root, 'workspace'); fs.mkdirSync(workDir);
    const settingsPath = path.join(workDir, 'agent_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ maxStepsPerTurn: 12, heartbeatIntervalMinutes: 60, richMessages: rich }));
    const runtimeSettings = createRuntimeSettings(workDir, { richMessages: rich });
    const calls = [], config = { workDir, BOT_TOKEN: 'synthetic', getOwnerId: () => '1', log: () => {}, RICH_MESSAGES_ENABLED: rich, runtimeSettings };
    let current = mode, counter = 100;
    const tg = load('telegram.js', {
        './config': config, './security': { redactSecrets: x => x }, './web': { isBlockedAddress: () => false },
        './quiesce': { isQuiesced: () => false },
        './http': { httpRequest: async (opts, body) => {
            calls.push({ method: opts.path.split('/').pop(), body }); counter++;
            if (current === 'timeout' || (current === 'partial' && calls.length === 2)) throw new Error('ETIMEDOUT');
            if (current === '429') return { data: { ok: false, error_code: 429, parameters: { retry_after: 10 } } };
            if (current === '503') return { data: { ok: false, error_code: 503 } };
            if (current === 'noid') return { data: { ok: true, result: {} } };
            return { data: { ok: true, result: { message_id: counter } } };
        } },
    });
    return { tg, calls, root, settingsPath, setMode: v => { current = v; } };
}
const opts = { deliveryKey: 'incoming-7:final' };

test('answer is on disk BEFORE the first send and survives a new store instance', async t => {
    const h = fixture(t, 'timeout');
    const record = h.tg.prepareMessage(1, 'synthetic answer', 7, null, opts);
    assert.equal(h.calls.length, 0);
    assert.equal(new DeliveryOutbox(path.join(h.root, 'delivery-outbox')).read(record.id).text, 'synthetic answer');
    const result = await h.tg.sendMessage(1, 'synthetic answer', 7, null, opts);
    assert.equal(result.status, 'uncertain');
    assert.equal(h.calls.length, 1);
    assert.equal(h.tg.getOutbox().read(result.deliveryId).text, 'synthetic answer');
});

test('ambiguous timeout is NOT delivered and repeated invocation does not create another POST', async t => {
    const h = fixture(t, 'timeout');
    const a = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    h.setMode('ok');
    const b = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.equal(a.status, 'uncertain'); assert.equal(b.status, 'uncertain');
    assert.equal(h.calls.length, 1);
});

test('acknowledged send is deduplicated even after Rich flag changes', async t => {
    const h = fixture(t);
    const a = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    fs.writeFileSync(h.settingsPath, '{"richMessages":false}');
    const b = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.equal(a.status, 'acknowledged'); assert.equal(b.messageId, a.messageId);
    assert.equal(h.calls.length, 1);
});

test('stable final delivery key keeps the first answer even if an input is regenerated', async t => {
    const h = fixture(t);
    h.tg.prepareMessage(1, 'first answer', 7, null, opts);
    await h.tg.sendMessage(1, 'regenerated answer', 7, null, opts);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].body.rich_message.markdown, 'first answer');
    await h.tg.sendMessage(1, 'third answer', 7, null, opts);
    assert.equal(h.calls.length, 1);
});

test('crashed READY record with acknowledged prefix cannot change render plans and resend', async t => {
    const h = fixture(t);
    const record = h.tg.prepareMessage(1, 'answer', 7, null, opts);
    record.parts['html:0'] = { state: 'acknowledged', messageId: 123 };
    h.tg.getOutbox().save(record);
    const result = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.equal(result.status, 'uncertain'); assert.equal(h.calls.length, 0);
});

test('concurrent duplicate calls serialize to one visible POST', async t => {
    const h = fixture(t);
    const results = await Promise.all(Array.from({ length: 10 }, () => h.tg.sendMessage(1, 'answer', 7, null, opts)));
    assert(results.every(r => r.status === 'acknowledged'));
    assert.equal(h.calls.length, 1);
});

for (const mode of ['429', '503', 'noid']) test(`${mode} never triggers a second visible fallback or a false success`, async t => {
    const h = fixture(t, mode);
    const result = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.notEqual(result.status, 'acknowledged');
    assert.equal(h.calls.length, 1);
    assert.equal(h.tg.getOutbox().list(1).length, 1);
});

test('partial classic answer stops at first uncertain chunk, retains full answer and acknowledged prefix', async t => {
    const h = fixture(t, 'partial', false);
    const text = 'a'.repeat(9000);
    const result = await h.tg.sendMessage(1, text, 7, null, opts);
    assert.equal(result.status, 'uncertain'); assert.equal(h.calls.length, 2);
    const record = h.tg.getOutbox().read(result.deliveryId);
    assert.equal(record.text, text); assert.equal(record.parts['html:0'].state, 'acknowledged');
    await h.tg.sendMessage(1, text, 7, null, opts);
    assert.equal(h.calls.length, 2);
});

test('crash after persisted ATTEMPTING never replays the POST', async t => {
    const store = new DeliveryOutbox(path.join(temp(t), 'outbox'));
    const record = store.prepare(1, 'answer', 7, 'stable');
    record.parts.rich = { state: 'attempting' }; store.save(record);
    let sends = 0;
    await assert.rejects(store.attempt(record.id, 'rich', async () => { sends++; }), /explicit recovery/);
    assert.equal(sends, 0); assert.equal(store.read(record.id).text, 'answer');
});

test('STOP prevents sending, but retains the response for later explicit recovery', async t => {
    const h = fixture(t); h.tg.stop();
    const result = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.equal(h.calls.length, 0); assert.notEqual(result.status, 'acknowledged');
    assert.equal(h.tg.getOutbox().read(result.deliveryId).text, 'answer');
});

test('/outbox only reveals answers to their original chat and explicit show does not POST', async t => {
    const h = fixture(t, 'timeout');
    const r = await h.tg.sendMessage(1, 'private synthetic answer', 7, null, opts);
    assert.match(h.tg.outboxCommand(1, []), /uncertain/);
    assert.match(h.tg.outboxCommand(1, ['show', r.deliveryId]), /private synthetic answer/);
    assert(!h.tg.outboxCommand(2, ['show', r.deliveryId]).includes('private synthetic answer'));
    assert(!h.tg.outboxCommand(1, ['show', '../bad']).includes('private synthetic answer'));
    assert.equal(h.calls.length, 1);
});

test('outbox storage failure prevents the first network call', async t => {
    const h = fixture(t);
    fs.writeFileSync(path.join(h.root, 'delivery-outbox'), 'not a directory');
    await assert.rejects(h.tg.sendMessage(1, 'answer', 7, null, opts));
    assert.equal(h.calls.length, 0);
});

test('runtime settings retain 12 / 60 across absent, malformed and partial reads', t => {
    const dir = temp(t), file = path.join(dir, 'agent_settings.json');
    const runtime = createRuntimeSettings(dir, { maxStepsPerTurn: 35, heartbeatIntervalMinutes: 30 });
    fs.writeFileSync(file, '{"maxStepsPerTurn":12,"heartbeatIntervalMinutes":60}');
    assert.equal(runtime.read().maxStepsPerTurn, 12);
    for (const value of ['', '{', '[]', '{"maxStepsPerTurn":120}']) {
        fs.writeFileSync(file, value);
        assert.equal(runtime.read().maxStepsPerTurn, 12);
        assert.equal(runtime.read().heartbeatIntervalMinutes, 60);
    }
    fs.unlinkSync(file); assert.equal(runtime.read().maxStepsPerTurn, 12);
    assert.equal(createRuntimeSettings(dir).read().maxStepsPerTurn, 12);
});

test('live Rich toggle applies without restarting the Node process', async t => {
    const h = fixture(t);
    fs.writeFileSync(h.settingsPath, '{"richMessages":false}');
    await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.equal(h.calls[0].method, 'sendMessage');
});

test('persisted STOP marker fences tracked delivery without deleting the answer', async t => {
    const h = fixture(t);
    fs.writeFileSync(path.join(h.root, 'service_user_stopped'), 'stopped');
    const result = await h.tg.sendMessage(1, 'answer', 7, null, opts);
    assert.notEqual(result.status, 'acknowledged'); assert.equal(h.calls.length, 0);
    assert.equal(h.tg.getOutbox().read(result.deliveryId).text, 'answer');
});

test('Tavily search refreshes conversational keys before using the selected provider', async () => {
    let refreshed = false;
    const web = load('tools/web.js', {
        '../config': { config: {}, log: () => {}, getSearchProvider: () => 'tavily', syncAgentApiKeys: () => { refreshed = true; } },
        '../security': { wrapSearchResults: x => x },
        '../web': { cacheGet: () => null, cacheSet: () => {}, searchTavily: async () => { assert(refreshed); return { provider: 'tavily' }; } },
    });
    assert.equal((await web.handlers.web_search({ query: 'synthetic' }, 1)).provider, 'tavily');
});

test('heartbeat 60 stays 60 after corruption and is checked at the one-minute scheduler tick', t => {
    const h = fixture(t);
    const main = fs.readFileSync(path.join(bundle, 'main.js'), 'utf8');
    const begin = main.indexOf('function getHeartbeatIntervalMs() {');
    const fn = '(' + main.slice(begin, main.indexOf('\n}\n', begin) + 2) + ')();';
    const runtime = createRuntimeSettings(path.dirname(h.settingsPath));
    assert.equal(vm.runInNewContext(fn, { require: () => ({ runtimeSettings: runtime }) }), 3600000);
    fs.writeFileSync(h.settingsPath, '{');
    assert.equal(vm.runInNewContext(fn, { require: () => ({ runtimeSettings: runtime }) }), 3600000);
    assert(main.includes('}, 60 * 1000)'));
});

test('delta self-awareness survives Hardened prompt compaction and documents new recovery/error paths', () => {
    const { compactStablePrompt } = require(path.join(bundle, 'prompt-compact'));
    const prompt = compactStablePrompt('## Error Recovery\nold\n## Config Awareness\nold').prompt;
    for (const term of ['/outbox', '/outbox show', 'STOP', 'last valid', 'maxStepsPerTurn', 'controlled restart']) assert(prompt.includes(term), term);
    const diagnostics = fs.readFileSync(path.join(bundle, 'DIAGNOSTICS.md'), 'utf8');
    for (const term of ['delivery unconfirmed', 'Response saved', 'Failed to publish', 'Live settings unavailable', '429/5xx']) assert(diagnostics.includes(term), term);
    assert(!prompt.includes('exactly-once guarantee'));
    const ai = fs.readFileSync(path.join(bundle, 'ai.js'), 'utf8');
    const memory = fs.readFileSync(path.join(bundle, 'tools/memory.js'), 'utf8');
    assert(!ai.includes('pick it up immediately')); assert(!memory.includes('pick them up immediately'));
    assert(ai.includes('Do not promise immediate adoption by every tool'));
});

test('HTTP response abort rejects rather than hanging forever', async () => {
    let res;
    const req = new EventEmitter(); req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {};
    req.end = () => { res = new EventEmitter(); res.setEncoding = () => {}; responder(res); res.emit('aborted'); };
    let responder;
    const api = load('http.js', { './config': { API_TIMEOUT_MS: 100 }, https: { request: (_, cb) => { responder = cb; return req; } } });
    await assert.rejects(api.httpRequest({ hostname: 'synthetic.invalid' }), /aborted/);
});

test('final persistence is wired before checkpoint deletion and pending delivery cannot mark final done', async t => {
    const ai = fs.readFileSync(path.join(bundle, 'ai.js'), 'utf8');
    const block = ai.slice(ai.indexOf('const assistantMessage = textContent.text;'), ai.indexOf('return assistantMessage;'));
    assert(block.indexOf('await options.persistFinal') < block.indexOf('cleanupChatCheckpoints'));
    const h = fixture(t, 'timeout');
    const mh = load('message-handler.js', { './config': { CHANNEL: 'telegram', config: {} }, './model-catalog': {}, './telegram-commands': {} });
    mh.init({ sendMessage: h.tg.sendMessage, log: () => {} });
    await assert.rejects(mh.deliverAgentText(1, 'answer', 7, 7), e => e.code === 'DELIVERY_PENDING');
    const text = fs.readFileSync(path.join(bundle, 'message-handler.js'), 'utf8');
    assert(text.includes("if (error.code === 'DELIVERY_PENDING')"));
});
