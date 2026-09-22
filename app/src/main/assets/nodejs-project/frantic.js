// SeekerClaw — frantic.js
// Frantic bounty watcher for Telegram.
// Reads the public board, alerts the owner about new funded/claimable work,
// and only mutates venue state after an explicit owner button tap.
//
// Env vars (Settings -> Env Vars):
//   FRANTIC_ENABLED=1
//   FRANTIC_AGENT_KID=agent-xxxxxx
//   FRANTIC_AGENT_TOKEN=fr_agent_...
// Optional:
//   FRANTIC_POLL_MINUTES=5
//   FRANTIC_MIN_USD=0.01
//   FRANTIC_MAX_USD=10
//   FRANTIC_MAX_ALERTS=3

const fs = require('fs');
const path = require('path');

const HOST = 'gofrantic.com';
const STATE_FILE = 'frantic_watcher_state.json';

let _deps = null;
let _timer = null;
let _inFlight = false;

function envBool(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

function envNumber(name, fallback, min, max) {
    const n = Number(process.env[name]);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function configFromEnv() {
    return {
        enabled: envBool('FRANTIC_ENABLED', false),
        agentKid: String(process.env.FRANTIC_AGENT_KID || '').trim(),
        agentToken: String(process.env.FRANTIC_AGENT_TOKEN || '').trim(),
        pollMinutes: envNumber('FRANTIC_POLL_MINUTES', 5, 1, 120),
        minUsd: envNumber('FRANTIC_MIN_USD', 0.01, 0, 1000000),
        maxUsd: envNumber('FRANTIC_MAX_USD', 10, 0, 1000000),
        maxAlerts: Math.floor(envNumber('FRANTIC_MAX_ALERTS', 3, 1, 10)),
    };
}

function statePath() {
    return path.join(_deps.workDir, STATE_FILE);
}

function loadState() {
    try {
        const p = statePath();
        if (!fs.existsSync(p)) return { seen: [] };
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        const seen = Array.isArray(parsed.seen)
            ? parsed.seen.map(Number).filter(Number.isInteger)
            : [];
        return { seen: seen.slice(-500) };
    } catch (_) {
        return { seen: [] };
    }
}

function saveState(state) {
    try {
        const p = statePath();
        const tmp = p + '.tmp';
        const clean = { seen: [...new Set(state.seen.map(Number).filter(Number.isInteger))].slice(-500) };
        fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
        fs.renameSync(tmp, p);
    } catch (e) {
        _deps.log(`[Frantic] state save failed: ${e.message}`, 'WARN');
    }
}

function markSeen(number) {
    const state = loadState();
    if (!state.seen.includes(number)) {
        state.seen.push(number);
        saveState(state);
    }
}

function isSeen(number) {
    return loadState().seen.includes(number);
}

async function request(method, apiPath, body = null, withAuth = false) {
    const cfg = configFromEnv();
    const headers = {
        'Accept': 'application/json',
        'User-Agent': 'SeekerClaw-Frantic/1.0',
    };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (withAuth && cfg.agentToken) headers.Authorization = `Bearer ${cfg.agentToken}`;

    const { httpRequest } = require('./http');
    const res = await httpRequest({
        hostname: HOST,
        path: apiPath,
        method,
        headers,
        timeout: 30000,
    }, body);

    return res;
}

async function fetchBoard() {
    const res = await request('GET', '/v1/board');
    if (res.status !== 200 || !res.data || res.data.ok !== true) {
        throw new Error(`board HTTP ${res.status}`);
    }
    return res.data.board;
}

function candidateBounties(board, cfg) {
    const rows = Array.isArray(board?.open_bounties)
        ? board.open_bounties
        : (Array.isArray(board?.bounties) ? board.bounties : []);

    return rows.filter((b) => {
        const price = Number(b?.price_usd);
        const slots = Number(b?.claim_slots?.available);
        const claimAvailable = b?.actions?.claim?.available;
        if (!Number.isInteger(Number(b?.number))) return false;
        if (b?.funded !== true) return false;
        if (!Number.isFinite(price) || price < cfg.minUsd || price > cfg.maxUsd) return false;
        if (!Number.isFinite(slots) || slots <= 0) return false;
        if (claimAvailable === false) return false;
        if (b?.work_status && !['open', 'reopened', 'claimable'].includes(String(b.work_status).toLowerCase())) return false;
        return true;
    }).sort((a, b) => {
        const priceDiff = Number(b.price_usd || 0) - Number(a.price_usd || 0);
        if (priceDiff !== 0) return priceDiff;
        return Number(b.number || 0) - Number(a.number || 0);
    });
}

function absoluteUrl(raw, number) {
    if (typeof raw === 'string' && /^https:\/\//i.test(raw)) return raw;
    if (typeof raw === 'string' && raw.startsWith('/')) return `https://${HOST}${raw}`;
    return `https://${HOST}/bounties/${number}`;
}

function compact(s, max = 180) {
    const text = String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
}

async function notifyBounty(bounty, chatId) {
    const n = Number(bounty.number);
    const price = Number(bounty.price_usd || 0);
    const available = Number(bounty.claim_slots?.available || 0);
    const cap = Number(bounty.claim_slots?.capacity || 0);
    const note = compact(bounty.note || bounty.actions?.claim?.reason || '', 220);
    const url = absoluteUrl(bounty.url, n);

    const lines = [
        `💰 Frantic #${n} · $${price.toFixed(2)}`,
        compact(bounty.title || 'Untitled bounty', 180),
        `slots: ${available}/${cap || '?'} available`,
    ];
    if (note) lines.push(note);

    const res = await _deps.telegram('sendMessage', {
        chat_id: chatId,
        text: lines.join('\n'),
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'CLAIM', callback_data: `frantic:claim:${n}` },
                    { text: 'SKIP', callback_data: `frantic:skip:${n}` },
                    { text: 'OPEN', url },
                ],
            ],
        },
    });

    if (!res?.ok) {
        throw new Error(res?.description || 'Telegram send failed');
    }
    markSeen(n);
}

async function scanOnce() {
    if (_inFlight || !_deps) return;
    const cfg = configFromEnv();
    if (!cfg.enabled) return;
    if (!cfg.agentKid) {
        _deps.log('[Frantic] enabled but FRANTIC_AGENT_KID is missing', 'WARN');
        return;
    }

    const rawChatId = _deps.getOwnerChatId();
    if (!rawChatId) return;
    const chatId = Number(rawChatId);
    if (!Number.isFinite(chatId)) return;

    _inFlight = true;
    try {
        const board = await fetchBoard();
        const fresh = candidateBounties(board, cfg)
            .filter((b) => !isSeen(Number(b.number)))
            .slice(0, cfg.maxAlerts);

        for (const bounty of fresh) {
            await notifyBounty(bounty, chatId);
        }

        if (fresh.length > 0) {
            _deps.log(`[Frantic] sent ${fresh.length} new bounty alert(s)`, 'INFO');
        }
    } catch (e) {
        _deps.log(`[Frantic] scan failed: ${e.message}`, 'WARN');
    } finally {
        _inFlight = false;
    }
}

function callbackNumber(data, action) {
    const m = new RegExp(`^frantic:${action}:(\\d+)$`).exec(String(data || ''));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 ? n : null;
}

async function removeKeyboard(cb) {
    const chatId = cb?.message?.chat?.id;
    const messageId = cb?.message?.message_id;
    if (chatId == null || messageId == null) return;
    await _deps.telegram('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
}

function errorText(res) {
    const d = res?.data;
    if (d && typeof d === 'object') {
        return compact(d.error || d.message || d.reason || d.detail || JSON.stringify(d), 500);
    }
    return compact(d || `HTTP ${res?.status || '?'}`, 500);
}

async function claimBounty(number, cb) {
    const cfg = configFromEnv();
    const chatId = cb?.message?.chat?.id ?? cb?.from?.id;

    if (!cfg.agentKid || !cfg.agentToken) {
        await _deps.telegram('sendMessage', {
            chat_id: chatId,
            text: 'Frantic claim pole seadistatud. Lisa Env Vars alla FRANTIC_AGENT_KID ja FRANTIC_AGENT_TOKEN.',
        });
        return;
    }

    const res = await request('POST', '/v1/claims', {
        bounty: number,
        agent_kid: cfg.agentKid,
    }, true);

    if (res.status >= 200 && res.status < 300 && res.data?.ok === true) {
        await removeKeyboard(cb);
        markSeen(number);
        const fuse = res.data.fuse_expires_at ? `\ndue: ${res.data.fuse_expires_at}` : '';
        const brief = res.data.brief ? `\n\nbrief:\n${compact(res.data.brief, 2500)}` : '';
        await _deps.telegram('sendMessage', {
            chat_id: chatId,
            text: `✅ Frantic #${number} CLAIMED\nclaim: ${res.data.claim_id || '?'}${fuse}${brief}`,
            disable_web_page_preview: true,
        });
        _deps.log(`[Frantic] claimed bounty #${number}`, 'INFO');
        return;
    }

    await _deps.telegram('sendMessage', {
        chat_id: chatId,
        text: `❌ Frantic #${number} claim failed: ${errorText(res)}`,
    });
    _deps.log(`[Frantic] claim #${number} failed HTTP ${res.status}`, 'WARN');
}

async function handleCallback(cb) {
    if (!_deps) return false;
    const data = String(cb?.data || '');

    const claim = callbackNumber(data, 'claim');
    if (claim != null) {
        await claimBounty(claim, cb);
        return true;
    }

    const skip = callbackNumber(data, 'skip');
    if (skip != null) {
        markSeen(skip);
        await removeKeyboard(cb);
        const chatId = cb?.message?.chat?.id ?? cb?.from?.id;
        await _deps.telegram('sendMessage', {
            chat_id: chatId,
            text: `⏭ Frantic #${skip} skipped.`,
            disable_notification: true,
        }).catch(() => {});
        return true;
    }

    return false;
}

function start({ workDir, log, telegram, getOwnerChatId }) {
    if (_deps) return;
    _deps = { workDir, log, telegram, getOwnerChatId };

    const cfg = configFromEnv();
    if (!cfg.enabled) {
        log('[Frantic] watcher disabled (set FRANTIC_ENABLED=1 to enable)', 'DEBUG');
        return;
    }

    if (!cfg.agentKid) {
        log('[Frantic] watcher enabled but FRANTIC_AGENT_KID is missing', 'WARN');
    }
    if (!cfg.agentToken) {
        log('[Frantic] FRANTIC_AGENT_TOKEN missing — alerts work, CLAIM buttons will not', 'WARN');
    }

    const intervalMs = cfg.pollMinutes * 60 * 1000;
    log(`[Frantic] watcher enabled; poll=${cfg.pollMinutes}m range=$${cfg.minUsd}-$${cfg.maxUsd}`, 'INFO');

    // Give Telegram startup a moment to establish the owner chat, then scan.
    setTimeout(() => scanOnce(), 8000);
    _timer = setInterval(() => scanOnce(), intervalMs);
    if (typeof _timer.unref === 'function') _timer.unref();
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
}

module.exports = {
    start,
    stop,
    scanOnce,
    handleCallback,
    // Exported for regression tests.
    _test: {
        configFromEnv,
        candidateBounties,
        callbackNumber,
        absoluteUrl,
    },
};
