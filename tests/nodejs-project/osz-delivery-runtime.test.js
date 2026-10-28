'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const bundle = path.resolve(__dirname, '../../app/src/main/assets/nodejs-project');
const { DeliveryOutbox, ACK_RETENTION_MS } = require(path.join(bundle, 'delivery-outbox'));
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
function fixture(t, mode = 'ok', rich = true, extra = {}) {
    const root = extra.root || temp(t), workDir = path.join(root, 'workspace'); fs.mkdirSync(workDir, { recursive: true });
    const settingsPath = path.join(workDir, 'agent_settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ maxStepsPerTurn: 12, heartbeatIntervalMinutes: 60, richMessages: rich }));
    const runtimeSettings = createRuntimeSettings(workDir, { richMessages: rich });
    const calls = [], config = { workDir, BOT_TOKEN: extra.token || 'synthetic', getOwnerId: () => '1', log: () => {}, RICH_MESSAGES_ENABLED: rich, runtimeSettings };
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
function messageHandler(h) {
    const mh = load('message-handler.js', {
        './config': { CHANNEL: 'telegram', workDir: path.dirname(h.settingsPath), config: {} },
        './model-catalog': {}, './telegram-commands': {}, './quiesce': { isQuiesced: () => false },
    });
    const state = { sends: [], done: 0, stats: 0, chats: 0 };
    const noop = async () => {};
    mh.init({
        log: () => {}, getOwnerId: () => '1', sendTyping: noop,
        lastIncomingMessages: new Map(), redactSecrets: x => x,
        createStatusReactionController: () => ({ setQueued: noop, setThinking: noop, setError: noop, clear: noop,
            setDone: async () => { state.done++; } }),
        androidBridgeCall: async endpoint => { if (endpoint === '/stats/message') state.stats++; return {}; },
        prepareMessage: h.tg.prepareMessage, outboxCommand: h.tg.outboxCommand,
        chat: async (_, __, options) => { state.chats++; await options.persistFinal('answer'); return 'answer'; },
        sendMessage: async (...args) => { state.sends.push(args[1]); return h.tg.sendMessage(...args); },
    });
    return { mh, state };
}
const opts = { deliveryKey: 'incoming-7:final' };

test('answer is on disk BEFORE the first send and survives a new store instance', async t => {
    const h = fixture(t, 'timeout');
    const record = h.tg.prepareMessage(1, 'synthetic answer', 7, null, opts);
    assert.equal(h.calls.length, 0);
    assert.equal(new DeliveryOutbox(h.tg.getOutbox().directory).read(record.id).text, 'synthetic answer');
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
    await assert.rejects(store.attempt(record.id, 'rich', async () => { sends++; }), e => e.code === 'DELIVERY_PENDING');
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

test('P1: real handleMessage parses /outbox show string and sends the saved answer', async t => {
    const h = fixture(t, 'timeout');
    const pending = await h.tg.sendMessage(1, 'private synthetic answer', 7, null, opts);
    h.setMode('ok');
    const { mh, state } = messageHandler(h);
    await mh.handleMessage({ chatId: '1', senderId: '1', text: `/outbox show ${pending.deliveryId}`, messageId: 8 });
    assert.equal(state.chats, 0); // recovery must not rerun AI/tools
    assert.equal(h.calls.length, 2); // original ambiguous POST + one explicit retrieval
    assert(h.calls[1].body.rich_message.markdown.includes('private synthetic answer'));
    assert.equal(h.tg.getOutbox().read(pending.deliveryId).text, 'private synthetic answer');
    assert.match(await mh.handleCommand(1, '/outbox', `  show   ${pending.deliveryId}  `), /private synthetic answer/);
    assert.match(await mh.handleCommand(1, '/outbox', 'show ../bad'), /Usage/);
    assert(!String(await mh.handleCommand(2, '/outbox', `show ${pending.deliveryId}`)).includes('private synthetic answer'));
});

for (const mode of ['timeout', 'ok']) test(`post-POST disk failure (${mode}) stays DELIVERY_PENDING and never creates a generic error reply`, async t => {
    const h = fixture(t, mode);
    const record = h.tg.prepareMessage(1, 'answer', 7, null, { deliveryKey: '7:final' });
    const store = h.tg.getOutbox(), originalSave = store.save.bind(store);
    let saves = 0;
    store.save = value => { if (++saves > 1) throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' }); return originalSave(value); };
    const { mh, state } = messageHandler(h);
    await mh.handleMessage({ chatId: '1', senderId: '1', text: 'synthetic prompt', messageId: 7 });
    assert.deepEqual(state.sends, ['answer']); assert.equal(h.calls.length, 1);
    assert.equal(state.done, 0); assert.equal(state.stats, 0);
    assert.equal(store.read(record.id).parts.rich.state, 'attempting');
    assert.equal(store.read(record.id).text, 'answer');
    await assert.rejects(h.tg.sendMessage(1, 'answer', 7, null, { deliveryKey: '7:final' }), e => e.code === 'DELIVERY_PENDING');
    assert.equal(h.calls.length, 1);
    store.save = originalSave;
    assert.equal((await h.tg.sendMessage(1, 'answer', 7, null, { deliveryKey: '7:final' })).status, 'uncertain');
    assert.equal(h.calls.length, 1);
});

test('ACK text clears immediately and only ACK tombstones expire; pending and corrupt records survive', async t => {
    const store = new DeliveryOutbox(path.join(temp(t), 'outbox'));
    const ack = store.prepare(1, 'sensitive synthetic reply', 7, 'ack');
    await store.attempt(ack.id, 'rich', async () => ({ ok: true, result: { message_id: 123 } }));
    store.finish(ack.id, { messageId: 123 });
    assert.equal(store.read(ack.id).text, '');
    const cutoff = Date.now() + ACK_RETENTION_MS + 60001;
    for (const status of ['ready', 'uncertain', 'rejected']) {
        const record = store.prepare(1, 'pending private text', 7, status);
        record.createdAt = 1; record.state = status;
        if (status === 'uncertain') record.parts.rich = { state: 'attempting' };
        store.save(record);
    }
    const recent = store.prepare(1, 'recent reply', 7, 'recent');
    await store.attempt(recent.id, 'rich', async () => ({ ok: true, result: { message_id: 124 } }));
    store.finish(recent.id, { messageId: 124 });
    const recentRecord = store.read(recent.id); recentRecord.acknowledgedAt = cutoff - 1000; store.save(recentRecord);
    const inconsistent = store.prepare(1, 'must not be erased', 7, 'inconsistent');
    inconsistent.state = 'acknowledged'; inconsistent.messageId = 125; inconsistent.parts.rich = { state: 'attempting' }; store.save(inconsistent);
    const corrupt = 'f'.repeat(32); fs.writeFileSync(store.file(corrupt), '{');
    store.prune(cutoff);
    assert(!fs.existsSync(store.file(ack.id)));
    assert(fs.existsSync(store.file(recent.id)));
    assert(fs.readFileSync(store.file(inconsistent.id), 'utf8').includes('must not be erased'));
    assert.equal(fs.readFileSync(store.file(corrupt), 'utf8'), '{');
    for (const status of ['ready', 'uncertain', 'rejected']) {
        const retained = store.prepare(1, 'ignored', 7, status);
        assert.equal(retained.text, 'pending private text');
    }
});

test('bot namespaces isolate pending text and dedup IDs while same-bot token rotation preserves them', async t => {
    const root = temp(t);
    const one = fixture(t, 'timeout', true, { root, token: '100:old-token' });
    const pending = await one.tg.sendMessage(1, 'bot one private text', 7, null, opts);
    const two = fixture(t, 'ok', true, { root, token: '200:other-token' });
    const delivered = await two.tg.sendMessage(1, 'bot two answer', 7, null, opts);
    assert.equal(two.calls.length, 1); assert.equal(delivered.status, 'acknowledged');
    assert.notEqual(delivered.deliveryId, pending.deliveryId);
    assert(!two.tg.outboxCommand(1, `show ${pending.deliveryId}`).includes('bot one private text'));
    const rotated = fixture(t, 'ok', true, { root, token: '100:rotated-token' });
    assert.equal((await rotated.tg.sendMessage(1, 'regenerated', 7, null, opts)).deliveryId, pending.deliveryId);
    assert.equal(rotated.calls.length, 0);
    assert(rotated.tg.outboxCommand(1, `show ${pending.deliveryId}`).includes('bot one private text'));
});

test('ACK cleanup also covers an inactive bot namespace but never its pending answers', async t => {
    const root = temp(t);
    const old = fixture(t, 'ok', true, { root, token: '100:old-token' });
    const ack = await old.tg.sendMessage(1, 'confirmed text', 7, null, opts);
    const store = old.tg.getOutbox(), tombstone = store.read(ack.deliveryId);
    tombstone.acknowledgedAt = Date.now() - ACK_RETENTION_MS - 60001; store.save(tombstone);
    old.setMode('timeout');
    const pending = await old.tg.sendMessage(1, 'keep pending text', 8, null, { deliveryKey: '8:final' });
    const active = fixture(t, 'ok', true, { root, token: '200:active-token' });
    active.tg.getOutbox();
    assert(!fs.existsSync(store.file(ack.deliveryId)));
    assert.equal(store.read(pending.deliveryId).text, 'keep pending text');
});

test('conversational key revocation follows valid removals/blanks and never erases Android keys', t => {
    const dir = temp(t), file = path.join(dir, 'agent_settings.json');
    const source = fs.readFileSync(path.join(bundle, 'config.js'), 'utf8');
    const section = source.slice(source.indexOf('const _knownKeyMap ='), source.indexOf('// Run once at startup\nsyncAgentApiKeys();'));
    const config = { braveApiKey: 'synthetic-android-owned' };
    const context = { fs, path, workDir: dir, config, normalizeSecret: x => x.trim(), log: () => {} };
    vm.runInNewContext(section, context);
    fs.writeFileSync(file, JSON.stringify({ apiKeys: { tavily: 'synthetic-one', brave: 'do-not-override' } }));
    context.syncAgentApiKeys(); assert.equal(config.tavilyApiKey, 'synthetic-one');
    fs.writeFileSync(file, '{'); context.syncAgentApiKeys(); assert.equal(config.tavilyApiKey, 'synthetic-one');
    fs.writeFileSync(file, JSON.stringify({ apiKeys: { tavily: ' ' } })); context.syncAgentApiKeys();
    assert.equal(config.tavilyApiKey, undefined); assert.equal(config.braveApiKey, 'synthetic-android-owned');
    fs.writeFileSync(file, JSON.stringify({ apiKeys: { tavily: 'synthetic-two' } })); context.syncAgentApiKeys();
    assert.equal(config.tavilyApiKey, 'synthetic-two');
    fs.writeFileSync(file, '{}'); context.syncAgentApiKeys();
    assert.equal(config.tavilyApiKey, undefined); assert.equal(config.braveApiKey, 'synthetic-android-owned');
    fs.writeFileSync(file, JSON.stringify({ apiKeys: { tavily: 'synthetic-three' } })); context.syncAgentApiKeys();
    config.tavilyApiKey = 'synthetic-other-owner';
    fs.writeFileSync(file, '{}'); context.syncAgentApiKeys();
    assert.equal(config.tavilyApiKey, 'synthetic-other-owner');
});

test('both full Telegram formatting prompt branches describe live Rich, never a required restart', () => {
    const ai = fs.readFileSync(path.join(bundle, 'ai.js'), 'utf8');
    const section = ai.slice(ai.indexOf('    // Channel formatting'), ai.indexOf('    // Skills section'));
    for (const rich of [false, true]) {
        const lines = []; vm.runInNewContext(section, { CHANNEL: 'telegram', runtimeSettings: { read: () => ({ richMessages: rich }) }, lines });
        const prompt = lines.join('\n');
        assert(prompt.includes('applies live to subsequent sends; no service restart needed'));
        assert(!prompt.includes('it applies after a service restart'));
    }
});

test('actual ChannelConfigScreen exempts Rich from restart, but retains channel/token restart behavior', () => {
    const screen = fs.readFileSync(path.resolve(bundle, '../../java/com/seekerclaw/app/ui/settings/ChannelConfigScreen.kt'), 'utf8');
    assert(screen.includes('if (ChannelSettingsPolicy.requiresRestart(field)) showRestartDialog = true'));
    assert(screen.includes('Applies live to subsequent replies; no restart needed.'));
    assert(!screen.includes('Restart applies the change.'));
});

test('ConfigManager wires full preference and both cross-process preimages into the tested rollback coordinator', () => {
    const source = fs.readFileSync(path.resolve(bundle, '../../java/com/seekerclaw/app/config/ConfigManager.kt'), 'utf8');
    assert(source.includes('val preSavePrefs = sp.all.toMap()'));
    assert(source.includes('val publication = SettingsPublication.finish('));
    assert(source.includes('for ((key, value) in preSavePrefs)'));
    assert.equal((source.match(/val rollbackOk = restoreSavedPrefs\(\)/g) || []).length, 2);
    assert(source.includes('val restored = runCatching { restoreSavedPrefs() }'));
    assert(source.includes('RuntimeStateStore.update { _ -> preForwardRuntime!! }'));
    assert(source.includes('AgentPreferencesStore.restoreSnapshot(preForwardAgentPrefs!!)'));
    assert(source.indexOf('if (!publication.published)') < source.indexOf('// R4 Copilot (BAT-549)'));
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
