// tools/zoho-mail.js — Zoho Mail REST API integration.
//
// Hardened design:
// - OAuth refresh token stays in process.env and is never returned to the model.
// - Access tokens are cached in-process and never logged.
// - API hosts are selected from a fixed regional allowlist (no arbitrary URL env).
// - Read/search tools are side-effect free.
// - zoho_mail_send / zoho_mail_reply are confirmation-gated in confirmation/policy.js.

'use strict';

const https = require('https');
const { URL, URLSearchParams } = require('url');
const { log } = require('../config');

const REGIONS = Object.freeze({
    eu:    { accounts: 'https://accounts.zoho.eu',     mail: 'https://mail.zoho.eu' },
    us:    { accounts: 'https://accounts.zoho.com',    mail: 'https://mail.zoho.com' },
    in:    { accounts: 'https://accounts.zoho.in',     mail: 'https://mail.zoho.in' },
    au:    { accounts: 'https://accounts.zoho.com.au', mail: 'https://mail.zoho.com.au' },
    jp:    { accounts: 'https://accounts.zoho.jp',     mail: 'https://mail.zoho.jp' },
    cn:    { accounts: 'https://accounts.zoho.com.cn', mail: 'https://mail.zoho.com.cn' },
});

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN_SKEW_MS = 60_000;

let tokenCache = {
    accessToken: null,
    expiresAt: 0,
};

function _regionConfig() {
    const raw = String(process.env.ZOHO_REGION || 'eu').trim().toLowerCase();
    const region = REGIONS[raw] ? raw : 'eu';
    return { region, ...REGIONS[region] };
}

function _missingEnv() {
    return ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']
        .filter((key) => !String(process.env[key] || '').trim());
}

function _safeText(value, max) {
    if (value === undefined || value === null) return '';
    const s = String(value);
    return s.length > max ? s.slice(0, max) : s;
}

function _boundedLimit(value, fallback = 10) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.trunc(n), 1), 50);
}

function _assertId(name, value) {
    const s = String(value || '').trim();
    if (!/^\d{1,40}$/.test(s)) {
        throw new Error(`${name} must be a numeric Zoho id`);
    }
    return s;
}

function _requestJson(urlString, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        if (url.protocol !== 'https:') {
            reject(new Error('Zoho API requires HTTPS'));
            return;
        }

        let body = options.body;
        if (body !== undefined && body !== null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
            body = JSON.stringify(body);
        }

        const headers = { ...(options.headers || {}) };
        if (body !== undefined && body !== null) {
            headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers,
            timeout: options.timeout || REQUEST_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            let bytes = 0;

            res.on('data', (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    req.destroy(new Error('Zoho API response exceeded 1 MB'));
                    return;
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data = text;
                if (text) {
                    try { data = JSON.parse(text); } catch (_) { /* keep text */ }
                }
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    data,
                });
            });
        });

        req.on('timeout', () => req.destroy(new Error('Zoho API request timed out')));
        req.on('error', reject);

        if (body !== undefined && body !== null) req.write(body);
        req.end();
    });
}

function _zohoError(prefix, response) {
    const data = response && response.data;
    let detail = '';
    if (data && typeof data === 'object') {
        detail = data.data?.moreInfo ||
            data.data?.errorCode ||
            data.error ||
            data.error_description ||
            data.status?.description ||
            '';
    } else if (typeof data === 'string') {
        detail = data.slice(0, 300);
    }
    const status = response?.status || 0;
    return new Error(`${prefix} failed (HTTP ${status})${detail ? ': ' + detail : ''}`);
}

async function _getAccessToken(force = false) {
    const missing = _missingEnv();
    if (missing.length) {
        throw new Error(`Missing Zoho Env Vars: ${missing.join(', ')}`);
    }

    const now = Date.now();
    if (!force && tokenCache.accessToken && tokenCache.expiresAt - TOKEN_SKEW_MS > now) {
        return tokenCache.accessToken;
    }

    const cfg = _regionConfig();
    const body = new URLSearchParams({
        refresh_token: String(process.env.ZOHO_REFRESH_TOKEN).trim(),
        client_id: String(process.env.ZOHO_CLIENT_ID).trim(),
        client_secret: String(process.env.ZOHO_CLIENT_SECRET).trim(),
        grant_type: 'refresh_token',
    }).toString();

    const response = await _requestJson(`${cfg.accounts}/oauth/v2/token`, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    if (response.status < 200 || response.status >= 300 ||
        !response.data || typeof response.data !== 'object' || !response.data.access_token) {
        throw _zohoError('Zoho OAuth refresh', response);
    }

    const expiresSeconds = Number(response.data.expires_in) || 3600;
    tokenCache = {
        accessToken: String(response.data.access_token),
        expiresAt: now + Math.max(60, expiresSeconds) * 1000,
    };

    return tokenCache.accessToken;
}

async function _apiRequest(path, options = {}, retry = true) {
    const cfg = _regionConfig();
    const accessToken = await _getAccessToken(false);
    const headers = {
        'Accept': 'application/json',
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
    };

    const response = await _requestJson(`${cfg.mail}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body,
    });

    if (response.status === 401 && retry) {
        tokenCache = { accessToken: null, expiresAt: 0 };
        await _getAccessToken(true);
        return _apiRequest(path, options, false);
    }

    if (response.status < 200 || response.status >= 300) {
        throw _zohoError('Zoho Mail API', response);
    }

    return response.data;
}

function _accountAddresses(account) {
    const out = new Set();
    for (const candidate of [
        account?.primaryEmailAddress,
        account?.mailboxAddress,
        account?.incomingUserName,
    ]) {
        if (candidate) out.add(String(candidate).toLowerCase());
    }
    if (Array.isArray(account?.emailAddress)) {
        for (const item of account.emailAddress) {
            if (item?.mailId) out.add(String(item.mailId).toLowerCase());
        }
    }
    if (Array.isArray(account?.sendMailDetails)) {
        for (const item of account.sendMailDetails) {
            if (item?.status && item?.fromAddress) out.add(String(item.fromAddress).toLowerCase());
        }
    }
    return out;
}

async function _resolveAccount() {
    const payload = await _apiRequest('/api/accounts');
    const accounts = Array.isArray(payload?.data) ? payload.data : [];
    if (!accounts.length) throw new Error('Zoho Mail returned no accounts for this OAuth user');

    const preferred = String(process.env.ZOHO_MAIL_ADDRESS || '').trim().toLowerCase();
    let account = null;

    if (preferred) {
        account = accounts.find((item) => _accountAddresses(item).has(preferred)) || null;
        if (!account) {
            throw new Error(`ZOHO_MAIL_ADDRESS (${preferred}) was not found in the OAuth user's Zoho Mail accounts`);
        }
    }

    if (!account) {
        account = accounts.find((item) => item?.type === 'ZOHO_ACCOUNT' && item?.enabled !== false) ||
            accounts.find((item) => item?.enabled !== false) ||
            accounts[0];
    }

    const accountId = _assertId('accountId', account.accountId);
    const fromAddress = preferred ||
        String(account.primaryEmailAddress || account.mailboxAddress || account.incomingUserName || '').trim();

    if (!fromAddress) {
        throw new Error('Could not determine a usable Zoho Mail sender address');
    }

    return {
        accountId,
        fromAddress,
        displayName: account.accountDisplayName || account.displayName || '',
        type: account.type || '',
    };
}

function _normalizeMessages(payload) {
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows.map((m) => ({
        messageId: m.messageId != null ? String(m.messageId) : '',
        folderId: m.folderId != null ? String(m.folderId) : '',
        threadId: m.threadId != null ? String(m.threadId) : '',
        fromAddress: m.fromAddress || '',
        sender: m.sender || '',
        toAddress: m.toAddress || m.to || '',
        subject: m.subject || '',
        summary: m.summary || '',
        receivedTime: m.receivedTime || m.receivedtime || null,
        sentDateInGMT: m.sentDateInGMT || null,
        status: m.status || '',
        hasAttachment: Boolean(Number(m.hasAttachment || 0)),
    }));
}

async function _searchMessages(searchKey, limit) {
    const account = await _resolveAccount();
    const params = new URLSearchParams({
        searchKey,
        start: '1',
        limit: String(_boundedLimit(limit)),
        includeto: 'true',
        // Zoho otherwise defaults to messages older than ~2 minutes.
        receivedTime: String(Date.now() + 60_000),
    });
    const payload = await _apiRequest(
        `/api/accounts/${account.accountId}/messages/search?${params.toString()}`
    );
    return {
        account: {
            accountId: account.accountId,
            address: account.fromAddress,
        },
        messages: _normalizeMessages(payload),
    };
}

const tools = [
    {
        name: 'zoho_mail_status',
        description: 'Check whether Zoho Mail OAuth is configured and resolve the authenticated mailbox. Never exposes secret values.',
        input_schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
    },
    {
        name: 'zoho_mail_list',
        description: 'List recent emails from the Zoho Mail Inbox. Use unread_only=true to list unread/new mail. Read-only.',
        input_schema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Maximum messages to return (1-50, default 10).' },
                unread_only: { type: 'boolean', description: 'If true, return new/unread mail instead of recent Inbox mail.' },
            },
        },
    },
    {
        name: 'zoho_mail_search',
        description: 'Search Zoho Mail using Zoho search syntax, for example sender:user@example.com, subject:invoice, entire:project, has:attachment, in:Inbox. Read-only.',
        input_schema: {
            type: 'object',
            properties: {
                search_key: { type: 'string', description: 'Zoho Mail searchKey expression.' },
                limit: { type: 'number', description: 'Maximum results (1-50, default 10).' },
            },
            required: ['search_key'],
        },
    },
    {
        name: 'zoho_mail_read',
        description: 'Read the full content of one Zoho Mail message. Use folderId and messageId returned by zoho_mail_list or zoho_mail_search. Read-only.',
        input_schema: {
            type: 'object',
            properties: {
                folder_id: { type: 'string', description: 'Zoho folderId returned by list/search.' },
                message_id: { type: 'string', description: 'Zoho messageId returned by list/search.' },
                include_block_content: { type: 'boolean', description: 'Include quoted/thread block content. Default false.' },
            },
            required: ['folder_id', 'message_id'],
        },
    },
    {
        name: 'zoho_mail_send',
        description: 'Send a new email through the authenticated Zoho Mail account. This tool always requires explicit user confirmation before dispatch.',
        input_schema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient address(es), comma-separated when multiple.' },
                cc: { type: 'string', description: 'Optional CC address(es), comma-separated.' },
                bcc: { type: 'string', description: 'Optional BCC address(es), comma-separated.' },
                subject: { type: 'string', description: 'Email subject.' },
                content: { type: 'string', description: 'Email body.' },
                format: { type: 'string', enum: ['plaintext', 'html'], description: 'Body format. Default plaintext.' },
            },
            required: ['to', 'subject', 'content'],
        },
    },
    {
        name: 'zoho_mail_reply',
        description: 'Reply to an existing Zoho Mail message by messageId. This tool always requires explicit user confirmation before dispatch.',
        input_schema: {
            type: 'object',
            properties: {
                message_id: { type: 'string', description: 'Zoho messageId being replied to.' },
                to: { type: 'string', description: 'Reply recipient address(es).' },
                cc: { type: 'string', description: 'Optional CC address(es).' },
                bcc: { type: 'string', description: 'Optional BCC address(es).' },
                subject: { type: 'string', description: 'Reply subject.' },
                content: { type: 'string', description: 'Reply body.' },
                format: { type: 'string', enum: ['plaintext', 'html'], description: 'Body format. Default plaintext.' },
            },
            required: ['message_id', 'to', 'subject', 'content'],
        },
    },
];

const handlers = {
    async zoho_mail_status() {
        const missing = _missingEnv();
        const cfg = _regionConfig();
        if (missing.length) {
            return {
                configured: false,
                region: cfg.region,
                missing,
                message: 'Add the missing keys in Settings → Env Vars.',
            };
        }
        try {
            const account = await _resolveAccount();
            return {
                configured: true,
                region: cfg.region,
                accountId: account.accountId,
                address: account.fromAddress,
                displayName: account.displayName,
                accountType: account.type,
            };
        } catch (e) {
            log(`[ZohoMail] status failed: ${e.message}`, 'WARN');
            return { configured: true, region: cfg.region, error: e.message };
        }
    },

    async zoho_mail_list(input) {
        try {
            const searchKey = input?.unread_only === true ? 'newMails' : 'in:Inbox';
            return await _searchMessages(searchKey, input?.limit);
        } catch (e) {
            return { error: e.message };
        }
    },

    async zoho_mail_search(input) {
        try {
            const searchKey = _safeText(input?.search_key, 500).trim();
            if (!searchKey) return { error: 'search_key is required' };
            return await _searchMessages(searchKey, input?.limit);
        } catch (e) {
            return { error: e.message };
        }
    },

    async zoho_mail_read(input) {
        try {
            const account = await _resolveAccount();
            const folderId = _assertId('folder_id', input?.folder_id);
            const messageId = _assertId('message_id', input?.message_id);
            const include = input?.include_block_content === true ? 'true' : 'false';
            const payload = await _apiRequest(
                `/api/accounts/${account.accountId}/folders/${folderId}/messages/${messageId}/content?includeBlockContent=${include}`
            );
            return {
                account: account.fromAddress,
                folderId,
                messageId,
                content: payload?.data?.content ?? payload?.data ?? payload,
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async zoho_mail_send(input) {
        try {
            const account = await _resolveAccount();
            const to = _safeText(input?.to, 4000).trim();
            const subject = _safeText(input?.subject, 1000);
            const content = _safeText(input?.content, 200_000);
            if (!to) return { error: 'to is required' };
            if (!content) return { error: 'content is required' };

            const body = {
                fromAddress: account.fromAddress,
                toAddress: to,
                subject,
                content,
                mailFormat: input?.format === 'html' ? 'html' : 'plaintext',
                encoding: 'UTF-8',
            };
            const cc = _safeText(input?.cc, 4000).trim();
            const bcc = _safeText(input?.bcc, 4000).trim();
            if (cc) body.ccAddress = cc;
            if (bcc) body.bccAddress = bcc;

            const payload = await _apiRequest(
                `/api/accounts/${account.accountId}/messages`,
                { method: 'POST', body }
            );
            return {
                sent: true,
                from: account.fromAddress,
                to,
                subject,
                messageId: payload?.data?.messageId != null ? String(payload.data.messageId) : undefined,
            };
        } catch (e) {
            return { error: e.message };
        }
    },

    async zoho_mail_reply(input) {
        try {
            const account = await _resolveAccount();
            const messageId = _assertId('message_id', input?.message_id);
            const to = _safeText(input?.to, 4000).trim();
            const subject = _safeText(input?.subject, 1000);
            const content = _safeText(input?.content, 200_000);
            if (!to) return { error: 'to is required' };
            if (!content) return { error: 'content is required' };

            const body = {
                fromAddress: account.fromAddress,
                toAddress: to,
                subject,
                content,
                action: 'reply',
                mailFormat: input?.format === 'html' ? 'html' : 'plaintext',
                encoding: 'UTF-8',
            };
            const cc = _safeText(input?.cc, 4000).trim();
            const bcc = _safeText(input?.bcc, 4000).trim();
            if (cc) body.ccAddress = cc;
            if (bcc) body.bccAddress = bcc;

            const payload = await _apiRequest(
                `/api/accounts/${account.accountId}/messages/${messageId}`,
                { method: 'POST', body }
            );
            return {
                sent: true,
                replyToMessageId: messageId,
                from: account.fromAddress,
                to,
                subject,
                messageId: payload?.data?.messageId != null ? String(payload.data.messageId) : undefined,
            };
        } catch (e) {
            return { error: e.message };
        }
    },
};

// Test-only hooks. They do not expose secret values.
function _resetTokenCacheForTests() {
    tokenCache = { accessToken: null, expiresAt: 0 };
}

module.exports = {
    tools,
    handlers,
    _regionConfig,
    _missingEnv,
    _resetTokenCacheForTests,
};
