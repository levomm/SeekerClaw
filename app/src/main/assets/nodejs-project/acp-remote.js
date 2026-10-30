'use strict';

// Optional ACP bridge client. Uses the existing Settings -> Env Vars bridge;
// never stores API tokens or full prompts in logs or conversation checkpoints.
const https = require('https');
const http = require('http');

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const REPO_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const AGENTS = new Set(['codex', 'claude', 'pi']);
const MAX_REPLY = 3500;

function resolveBridgeConfig(env = process.env) {
    const address = env.SEEKER_ACP_URL;
    const token = env.SEEKER_ACP_TOKEN;
    if (!address || !token) return null;
    if (typeof token !== 'string' || token.length < 32) throw new Error('Invalid bridge token');
    let url;
    try { url = new URL(address); } catch { throw new Error('Invalid bridge URL'); }
    const local = url.protocol === 'http:' && url.hostname === '127.0.0.1';
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash
        || url.search || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error('Bridge URL must be HTTPS and contain no credentials, query, or path');
    }
    return { url, token };
}

function request(config, method, route, payload = null, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
        const dest = new URL(route, config.url.origin);
        const body = payload == null ? null : JSON.stringify(payload);
        const client = dest.protocol === 'https:' ? https : http;
        const req = client.request({
            protocol: dest.protocol,
            hostname: dest.hostname,
            port: dest.port || undefined,
            path: dest.pathname,
            method,
            headers: {
                'authorization': `Bearer ${config.token}`,
                'accept': 'application/json',
                ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
            },
        }, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
                if (Buffer.byteLength(data, 'utf8') > 64 * 1024) req.destroy(new Error('Bridge reply too large'));
            });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { reject(new Error('Invalid JSON reply from ACP bridge')); return; }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    const code = /^[a-z0-9_ -]{1,80}$/i.test(parsed.error || '') ? parsed.error : 'request_failed';
                    reject(new Error(`Bridge HTTP ${res.statusCode}: ${code}`));
                    return;
                }
                resolve(parsed);
            });
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error('ACP bridge request timed out')));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function formatJob(job) {
    const status = String(job.status || 'unknown');
    const details = [
        `ACP job: ${String(job.id || '?')}`,
        `${String(job.agent || '?')} | ${String(job.repo || '?')} | ${status}`,
    ];
    if (job.progress) details.push(`Progress: ${String(job.progress).slice(0, 120)}`);
    if (job.error) details.push(`Error: ${String(job.error).slice(0, 160)}`);
    if (job.summary) details.push(`\n${String(job.summary).slice(-MAX_REPLY)}`);
    return details.join('\n');
}

function help() {
    return 'ACP delegation (Codex / Claude / Pi):\n'
        + '/acp codex seekerclaw Review the current architecture\n'
        + '/acp claude krobekarss Review checkout failures\n'
        + '/acp list\n'
        + '/acp status <job-id>\n'
        + '/acp cancel <job-id>\n'
        + 'Audit mode only. No automatic writes/deploys.';
}

async function handleAcpCommand(args, opts = {}) {
    const tokens = String(args || '').trim().split(/\s+/);
    const verb = (tokens[0] || '').toLowerCase();
    if (!verb || verb === 'help') return help();
    try {
        const config = resolveBridgeConfig(opts.env || process.env);
        if (!config) return 'ACP is disabled. Set SEEKER_ACP_URL and SEEKER_ACP_TOKEN in Settings -> Env Vars.';
        const makeRequest = opts.request || request;
        if (verb === 'list' && tokens.length === 1) {
            const result = await makeRequest(config, 'GET', '/v1/jobs');
            if (!Array.isArray(result.jobs) || !result.jobs.length) return 'No ACP jobs yet.';
            return result.jobs.map(j => `${j.id} | ${j.agent} | ${j.repo} | ${j.status}`).join('\n').slice(0, MAX_REPLY);
        }
        if ((verb === 'status' || verb === 'cancel') && tokens.length === 2 && JOB_ID.test(tokens[1])) {
            const route = `/v1/jobs/${tokens[1]}` + (verb === 'cancel' ? '/cancel' : '');
            return formatJob(await makeRequest(config, verb === 'cancel' ? 'POST' : 'GET', route));
        }
        if (AGENTS.has(verb) && tokens.length >= 3 && REPO_NAME.test(tokens[1])) {
            // Preserve the original free-form prompt including line breaks, but not the command prefix.
            const match = String(args).trim().match(/^\S+\s+\S+\s+([\s\S]+)$/);
            const prompt = match && match[1].trim();
            if (!prompt || Buffer.byteLength(prompt, 'utf8') > 8 * 1024) return 'ACP prompt must be 1-8192 bytes.';
            const job = await makeRequest(config, 'POST', '/v1/jobs', { agent: verb, repo: tokens[1], prompt });
            return `ACP job queued.\n${formatJob(job)}\n\nCheck later: /acp status ${job.id}`;
        }
        return help();
    } catch (e) {
        // Never include a request body, auth header, or raw adapter stderr in error text.
        const message = String(e?.message || 'request failed');
        return `ACP bridge unavailable: ${message.slice(0, 160)}`;
    }
}

module.exports = { handleAcpCommand, resolveBridgeConfig, formatJob, request };
