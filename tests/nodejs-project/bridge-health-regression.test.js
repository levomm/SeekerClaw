// Offline regression tests. No Android app, sockets, credentials or workspace are accessed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../..');
const bundle = path.join(root, 'app/src/main/assets/nodejs-project');
const serviceDir = path.join(root, 'app/src/main/java/com/seekerclaw/app/service');

function load(name, deps) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(bundle, name), 'utf8'), {
        module, exports: module.exports, Buffer, setTimeout, clearTimeout,
        require(id) {
            if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
            throw new Error(`Unexpected dependency: ${id}`);
        },
    }, { filename: name });
    return module.exports;
}

function transport(outcomes) {
    const requests = [];
    return {
        requests,
        request(options, response) {
            const req = new EventEmitter();
            requests.push(options);
            req.write = () => {};
            req.destroy = () => {};
            req.setTimeout = (ms, fn) => { req.expire = fn; };
            req.end = () => queueMicrotask(() => {
                const outcome = outcomes.shift();
                if (outcome === 'timeout') return req.expire();
                if (outcome instanceof Error) return req.emit('error', outcome);
                const res = new EventEmitter();
                res.statusCode = 200;
                res.headers = {};
                res.setEncoding = () => {};
                response(res);
                res.emit('data', JSON.stringify(outcome));
                res.emit('end');
            });
            return req;
        },
    };
}

test('real bridge.js maps refused connection without unbounded retry', async () => {
    const logs = [];
    const http = transport([new Error('connect ECONNREFUSED 127.0.0.1:8765')]);
    const bridge = load('bridge.js', {
        http,
        './config': { getBridgeToken: () => 'fixture-token', log: msg => logs.push(msg) },
    });
    const result = await bridge.androidBridgeCall('/ping');
    assert.match(result.error, /Android Bridge unavailable:.*ECONNREFUSED/);
    assert.strictEqual(http.requests.length, 1);
    assert.match(logs[0], /Android Bridge error:.*8765/);
});

test('Telegram HTTP transport recovers after timeout independently of failed local bridge', async () => {
    const https = transport(['timeout', { ok: true, result: [] }]);
    const api = load('http.js', {
        http: transport([]), https,
        './config': { API_TIMEOUT_MS: 60000 },
    });
    const options = { hostname: 'api.telegram.org', method: 'POST', path: '/fixture/getUpdates' };
    await assert.rejects(api.httpRequest(options, { timeout: 30 }), /Timeout/);
    const response = await api.httpRequest(options, { timeout: 30 });
    assert.strictEqual(response.data.ok, true);
    assert.strictEqual(https.requests.length, 2);
    assert(https.requests.every(r => r.hostname === 'api.telegram.org'));
});

test('Telegram ECONNABORTED rejects independently and a later request succeeds', async () => {
    const https = transport([Object.assign(new Error('ECONNABORTED'), { code: 'ECONNABORTED' }), { ok: true, result: [] }]);
    const api = load('http.js', { http: transport([]), https, './config': { API_TIMEOUT_MS: 60000 } });
    await assert.rejects(api.httpRequest({ hostname: 'api.telegram.org' }), /ECONNABORTED/);
    assert.strictEqual((await api.httpRequest({ hostname: 'api.telegram.org' })).data.ok, true);
});

test('service wiring checks bridge off-main on reentry and does not restart Node on bind exhaustion', () => {
    const service = fs.readFileSync(path.join(serviceDir, 'SeekerClawService.kt'), 'utf8');
    const reentry = service.slice(service.indexOf('if (NodeBridge.isAlive())'), service.indexOf('// Owner ID may be blank'));
    assert.match(reentry, /scope\.launch \{ checkBridgeHealth\(\) \}/);
    assert(!reentry.includes('updateStatus(ServiceStatus.RUNNING)'));
    assert.match(service, /remaining ERROR; no automatic process restart/);
    assert.match(service, /checkHealth = \{/);
    assert.match(service, /val bridgeHealthy = checkBridgeHealth\(\)/);
    assert.match(service, /runtimeHealth\(\s*nodeAlive = NodeBridge\.isAlive\(\),\s*bridgeHealthy = bridgeHealthy,\s*serviceRequested = shouldRunBridge\(\)/);
    assert.match(service, /start\(appCtx, userInitiated = false\)/);
    assert.match(service, /if \(userInitiated\) userStopSignal\(context\)\.stop\(\)/);
    const node = fs.readFileSync(path.join(serviceDir, 'NodeBridge.kt'), 'utf8');
    assert(!node.includes('updateStatus(ServiceStatus.RUNNING)'));
    const boot = fs.readFileSync(path.join(serviceDir, '../receiver/BootReceiver.kt'), 'utf8');
    assert.match(boot, /start\(context, userInitiated = false\)/);
});

test('watchdog consumes both health signals; only Node death enters process restart path', () => {
    const watchdog = fs.readFileSync(path.join(serviceDir, 'Watchdog.kt'), 'utf8');
    assert.match(watchdog, /val health = checkHealth\(\)/);
    const bridgeFailure = watchdog.slice(watchdog.indexOf('RuntimeHealth.BRIDGE_UNAVAILABLE ->'),
        watchdog.indexOf('RuntimeHealth.HEALTHY ->'));
    assert.match(bridgeFailure, /runtime remains ERROR, no process restart/);
    assert(!bridgeFailure.includes('onDead()'));
    assert.strictEqual((watchdog.match(/onDead\(\)/g) || []).length, 1);
    const nodeFailure = watchdog.slice(watchdog.indexOf('RuntimeHealth.NODE_UNAVAILABLE ->'),
        watchdog.indexOf('RuntimeHealth.BRIDGE_UNAVAILABLE ->'));
    assert.match(nodeFailure, /onDead\(\)/);
});

test('production ping carries bridge token and requires HTTP 200 plus expected response', () => {
    const service = fs.readFileSync(path.join(serviceDir, 'SeekerClawService.kt'), 'utf8');
    const probe = service.slice(service.indexOf('private fun isAndroidBridgeHealthy()'),
        service.indexOf('private fun isAndroidBridgeHealthy()') + 1800);
    assert.match(probe, /127\.0\.0\.1:8765\/ping/);
    assert.match(probe, /setRequestProperty\("X-Bridge-Token", token\)/);
    assert.match(probe, /conn\.responseCode != 200/);
    assert.match(probe, /result\.optString\("status"\) == "ok" && result\.optString\("bridge"\) == "AndroidBridge"/);
    const recovery = fs.readFileSync(path.join(serviceDir, 'BridgeHealth.kt'), 'utf8');
    assert.match(recovery, /withContext\(Dispatchers\.IO\)/);
    assert.match(recovery, /mutex\.withLock \{ recoverLocked\(\) \}/);
});
