// SeekerClaw — providers/hive.js
// Internal fallback adapter for Hive.ai DeepSeek.
// Not exposed as a primary Settings provider: it is activated automatically
// when OpenAI returns usage_limit_reached and HIVE_API_KEY is configured.

'use strict';

const openrouter = require('./openrouter');

const DEFAULT_BASE_URL = 'https://api-cdn.thehive.ai/api/v3';
const DEFAULT_MODEL = 'deepseek-ai/deepseek-v4.1-flash';

function env(name, fallback = '') {
    const v = process.env[name];
    return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function getModel() {
    return env('HIVE_MODEL', DEFAULT_MODEL);
}

function isConfigured() {
    return !!env('HIVE_API_KEY');
}

function getApiKey() {
    return env('HIVE_API_KEY');
}

function getEndpoint() {
    const raw = env('HIVE_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
    const u = new URL(raw + '/chat/completions');
    return {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
    };
}

function buildHeaders(apiKey) {
    const key = apiKey || getApiKey();
    return {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${key}`,
    };
}

function fromApiResponse(raw) {
    const parsed = openrouter.fromApiResponse(raw);
    if (Array.isArray(parsed.reasoningBlocks)) {
        parsed.reasoningBlocks = parsed.reasoningBlocks.map((blk) => ({
            ...blk,
            provider: 'hive',
            sourceAdapter: 'hive',
            delegateAdapter: 'openrouter',
            sourceModel: raw && raw.model ? raw.model : (blk.sourceModel || getModel()),
        }));
    }
    return parsed;
}

function formatRequest(model, maxTokens, systemPrompt, messages, tools) {
    const body = {
        model: model || getModel(),
        stream: true,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
    };
    if (tools && tools.length > 0) body.tools = tools;
    return JSON.stringify(body);
}

function classifyError(status, data) {
    const base = openrouter.classifyError(status, data);
    const msg = String(base && base.userMessage ? base.userMessage : `Hive.ai error (${status}).`)
        .replace(/OpenRouter/gi, 'Hive.ai');
    return { ...(base || {}), userMessage: msg };
}

function classifyNetworkError(err) {
    const base = openrouter.classifyNetworkError(err);
    return {
        ...base,
        userMessage: String(base && base.userMessage ? base.userMessage : 'Hive.ai network error.')
            .replace(/OpenRouter/gi, 'Hive.ai'),
    };
}

module.exports = {
    id: 'hive',
    name: 'Hive.ai DeepSeek',

    getEndpoint,
    buildHeaders,
    getModel,
    getApiKey,
    isConfigured,
    streamProtocol: 'chat-completions',

    toApiMessages: openrouter.toApiMessages,
    fromApiResponse,
    formatSystemPrompt: openrouter.formatSystemPrompt,
    formatTools: openrouter.formatTools,
    formatRequest,
    formatVision: openrouter.formatVision,

    classifyError,
    classifyNetworkError,
    normalizeUsage: openrouter.normalizeUsage,
    parseRateLimitHeaders: openrouter.parseRateLimitHeaders,

    supportsCache: false,
    authTypes: ['api_key'],
};
