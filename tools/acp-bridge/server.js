'use strict';

// ACP worker for SeekerClaw. Run on a separate Node 22+ server account.
// Deliberately no write mode: production code and credentials must stay out of reach.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const AGENTS = new Set(['codex', 'claude', 'pi']);
const MAX_BODY = 12 * 1024;
const MAX_PROMPT_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const MAX_TEXT = 6000;
const MAX_RECORDS = 100;
const ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REPO_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function loadConfig(env = process.env) {
    const token = env.ACP_BRIDGE_TOKEN;
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
        throw new Error('ACP_BRIDGE_TOKEN must be a random secret of 32-256 characters');
    }
    const file = env.ACP_BRIDGE_CONFIG || path.join(__dirname, 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.repos || typeof raw.repos !== 'object'
        || Array.isArray(raw.repos)) throw new Error('config.repos must map names to directories');
    const repos = {};
    for (const [name, dir] of Object.entries(raw.repos)) {
        if (!REPO_PATTERN.test(name) || typeof dir !== 'string' || !path.isAbsolute(dir)) {
            throw new Error('repo entries must use safe names and absolute paths');
        }
        const real = fs.realpathSync(dir);
        if (!fs.statSync(real).isDirectory()) throw new Error('repo path is not a directory');
        repos[name] = real;
    }
    if (!Object.keys(repos).length) throw new Error('configure at least one repo');
    const agents = raw.agents === undefined ? [...AGENTS] : raw.agents;
    if (!Array.isArray(agents) || agents.length === 0 || agents.some(a => !AGENTS.has(a))) {
        throw new Error('agents must be a nonempty subset of codex, claude, pi');
    }
    const host = env.ACP_BRIDGE_HOST || '127.0.0.1';
    // HTTP is intentionally loopback only; use HTTPS reverse proxy for remote access.
    if (host !== '127.0.0.1') throw new Error('ACP_BRIDGE_HOST must be 127.0.0.1');
    const port = Number(env.ACP_BRIDGE_PORT || 8787);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('invalid ACP_BRIDGE_PORT');
    return { token, host, port, repos, agents };
}

function safeEqual(actual, expected) {
    if (typeof actual !== 'string' || !actual.startsWith('Bearer ')) return false;
    const value = actual.slice(7);
    const left = crypto.createHash('sha256').update(value).digest();
    const right = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(left, right);
}

function json(res, code, payload) {
    res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            reject(Object.assign(new Error('application/json required'), { httpCode: 415 }));
            return;
        }
        let size = 0;
        const chunks = [];
        let done = false;
        req.on('data', chunk => {
            if (done) return;
            size += chunk.length;
            if (size > MAX_BODY) {
                done = true;
                reject(Object.assign(new Error('body too large'), { httpCode: 413 }));
                // Keep draining the socket, so an HTTP 413 can still be returned.
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (done) return;
            done = true;
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(Object.assign(new Error('invalid JSON'), { httpCode: 400 })); }
        });
        req.on('aborted', () => { if (!done) { done = true; reject(new Error('request aborted')); } });
        req.on('error', err => { if (!done) { done = true; reject(err); } });
    });
}

function publicJob(job) {
    const { id, agent, repo, status, createdAt, startedAt, endedAt, progress,
        summary, exitCode, error } = job;
    return { id, agent, repo, status, createdAt, startedAt, endedAt,
        progress, summary, exitCode, error };
}

function killProcessGroup(child, signal = 'SIGTERM') {
    if (!child || !child.pid) return;
    try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch { try { child.kill(signal); } catch { /* already stopped */ } }
}

function createBridge(config, options = {}) {
    if (!config || typeof config.token !== 'string' || config.token.length < 32) {
        throw new Error('bridge requires a 32+ character token');
    }
    const repos = config.repos || {};
    const agents = new Set(config.agents || [...AGENTS]);
    const run = options.spawn || spawn;
    const maxConcurrent = 1; // serial by design; no two agents race in the same checkout
    const maxQueued = 8;
    const timeoutMs = options.timeoutMs || 15 * 60 * 1000;
    const jobs = new Map();
    const queue = [];
    let active = 0;
    let shuttingDown = false;

    function trimHistory() {
        if (jobs.size <= MAX_RECORDS) return;
        for (const [id, job] of jobs) {
            if (jobs.size <= MAX_RECORDS) break;
            if (['done', 'failed', 'cancelled', 'timeout'].includes(job.status)) jobs.delete(id);
        }
    }

    function cancel(job) {
        if (!job || ['done', 'failed', 'cancelled', 'timeout'].includes(job.status)) return false;
        job.status = 'cancelled';
        job.endedAt = new Date().toISOString();
        job.progress = 'Cancelled';
        if (job.child) {
            killProcessGroup(job.child);
            const child = job.child;
            const timer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2000);
            timer.unref();
        } else {
            const i = queue.findIndex(x => x.job === job);
            if (i >= 0) queue.splice(i, 1);
        }
        return true;
    }

    function appendMessage(job, chunk) {
        const update = chunk && chunk.method === 'session/update' && chunk.params?.update;
        if (!update) return;
        if (update.sessionUpdate === 'agent_message_chunk'
            && update.content?.type === 'text' && typeof update.content.text === 'string') {
            job.summary = (job.summary + update.content.text).slice(-MAX_TEXT);
            job.progress = 'Agent responded';
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            // Never relay tool output or arbitrary file contents to a Telegram status reply.
            job.progress = 'Inspecting repository';
        } else if (update.sessionUpdate === 'agent_plan') {
            job.progress = 'Planning';
        }
    }

    function startJob(entry) {
        const { job, prompt } = entry;
        if (job.status !== 'queued') return;
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        job.progress = 'Starting ACP agent';
        active++;
        // No shell, fixed allowlisted agent/checkout, no arbitrary CLI options from callers.
        const args = ['--format', 'json', '--json-strict', '--suppress-reads',
            '--approve-reads', '--non-interactive-permissions', 'deny',
            '--no-terminal', '--timeout', String(Math.ceil(timeoutMs / 1000)),
            '--cwd', repos[job.repo], job.agent, 'exec', prompt];
        let child;
        try {
            child = run(options.acpxBin || 'acpx', args, {
                cwd: repos[job.repo], shell: false, detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            job.child = child;
        } catch {
            active--;
            job.status = 'failed';
            job.error = 'Cannot start acpx process';
            job.endedAt = new Date().toISOString();
            pump();
            return;
        }
        let pending = '';
        let bytes = 0;
        let finished = false;
        const deadline = setTimeout(() => {
            if (finished || job.status !== 'running') return;
            job.status = 'timeout';
            job.error = 'ACP execution timed out';
            job.progress = 'Timed out';
            job.endedAt = new Date().toISOString();
            killProcessGroup(child);
            const fallback = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2000);
            fallback.unref();
        }, timeoutMs + 5000);
        deadline.unref();
        const onFailure = () => {
            if (job.status === 'running') {
                job.status = 'failed';
                job.error = 'ACP process failed to start';
                job.endedAt = new Date().toISOString();
            }
        };
        child.on('error', onFailure);
        child.stdout?.on('data', data => {
            bytes += data.length;
            if (bytes > MAX_OUTPUT_BYTES) {
                job.status = 'failed';
                job.error = 'ACP output limit exceeded';
                job.endedAt = new Date().toISOString();
                killProcessGroup(child);
                return;
            }
            pending += data.toString('utf8');
            if (Buffer.byteLength(pending, 'utf8') > MAX_LINE_BYTES) {
                job.status = 'failed';
                job.error = 'ACP event too large';
                job.endedAt = new Date().toISOString();
                killProcessGroup(child);
                pending = '';
                return;
            }
            let index;
            while ((index = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                if (!line.trim()) continue;
                try { appendMessage(job, JSON.parse(line)); } catch { /* malformed event: ignore */ }
            }
        });
        // Drain stderr but never expose raw subprocess errors or env values in API responses.
        child.stderr?.resume();
        child.on('close', code => {
            if (finished) return;
            finished = true;
            clearTimeout(deadline);
            job.child = null;
            job.exitCode = Number.isInteger(code) ? code : null;
            if (job.status === 'running') {
                job.status = code === 0 ? 'done' : 'failed';
                job.progress = code === 0 ? 'Completed' : 'Agent exited with error';
                if (code !== 0) job.error = `ACP exited with code ${code ?? 'unknown'}`;
                job.endedAt = new Date().toISOString();
            }
            active--;
            pump();
        });
    }

    function pump() {
        if (shuttingDown) return;
        while (active < maxConcurrent && queue.length) startJob(queue.shift());
    }

    const server = http.createServer(async (req, res) => {
        // API must never be exposed as unauthenticated HTTP. A reverse proxy handles HTTPS.
        if (!safeEqual(req.headers.authorization, config.token)) {
            json(res, 401, { error: 'unauthorized' });
            return;
        }
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (req.method === 'GET' && pathname === '/healthz') {
            json(res, 200, { ok: true, running: active, queued: queue.length });
            return;
        }
        if (req.method === 'GET' && pathname === '/v1/jobs') {
            json(res, 200, { jobs: [...jobs.values()].reverse().slice(0, 10).map(publicJob) });
            return;
        }
        const match = /^\/v1\/jobs\/([a-f0-9-]+)(\/cancel)?$/.exec(pathname);
        if (match) {
            const id = match[1];
            if (!ID_PATTERN.test(id)) { json(res, 404, { error: 'not_found' }); return; }
            const job = jobs.get(id);
            if (!job) { json(res, 404, { error: 'not_found' }); return; }
            if (req.method === 'GET' && !match[2]) {
                json(res, 200, publicJob(job));
                return;
            }
            if (req.method === 'POST' && match[2]) {
                if (!cancel(job)) { json(res, 409, { error: 'job already finished', job: publicJob(job) }); return; }
                json(res, 200, publicJob(job));
                pump();
                return;
            }
        }
        if (req.method === 'POST' && pathname === '/v1/jobs') {
            if (shuttingDown) { json(res, 503, { error: 'shutting_down' }); return; }
            if (queue.length >= maxQueued) { json(res, 429, { error: 'queue_full' }); return; }
            let body;
            try { body = await readJson(req); }
            catch (err) { json(res, err.httpCode || 400, { error: err.httpCode === 413 ? 'body_too_large' : 'invalid_request' }); return; }
            if (!body || typeof body !== 'object' || Array.isArray(body)
                || !agents.has(body.agent) || !Object.prototype.hasOwnProperty.call(repos, body.repo)
                || typeof body.prompt !== 'string' || !body.prompt.trim()
                || Buffer.byteLength(body.prompt, 'utf8') > MAX_PROMPT_BYTES
                || body.prompt.includes('\0')) {
                json(res, 400, { error: 'invalid_agent_repo_or_prompt' });
                return;
            }
            const job = {
                id: crypto.randomUUID(), agent: body.agent, repo: body.repo, status: 'queued',
                createdAt: new Date().toISOString(), startedAt: null, endedAt: null,
                progress: 'Queued', summary: '', exitCode: null, error: null, child: null,
            };
            jobs.set(job.id, job);
            queue.push({ job, prompt: body.prompt.trim() });
            trimHistory();
            json(res, 202, publicJob(job));
            // Advance in next tick so the HTTP response returns even for synchronous mocks.
            setImmediate(pump);
            return;
        }
        json(res, 404, { error: 'not_found' });
    });

    function close() {
        shuttingDown = true;
        for (const job of jobs.values()) cancel(job);
        return new Promise(resolve => server.close(resolve));
    }
    return { server, close, getJob: id => jobs.get(id) };
}

if (require.main === module) {
    const config = loadConfig();
    const bridge = createBridge(config);
    bridge.server.listen(config.port, config.host, () => {
        console.log(`ACP bridge listening on ${config.host}:${config.port} (loopback only)`);
    });
    const shutdown = () => { bridge.close().then(() => process.exit(0)); };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

module.exports = { createBridge, loadConfig, safeEqual };
