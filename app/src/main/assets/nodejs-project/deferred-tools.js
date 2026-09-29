'use strict';

// Provider-aware deferred tool loading.
//
// SeekerClaw has a large registry (64 built-ins plus optional MCP tools). Sending
// every schema on every model round burns context and request bytes. Providers
// that reliably support the existing tool_search discovery pattern get a small
// core set first; tools discovered during the active turn are added on the next
// round. Claude stays on the full set because its prompt caching already makes
// that path efficient. OpenRouter stays full because some small/free models have
// historically emitted raw XML instead of valid tool calls with deferred loading.

const CORE_TOOL_NAMES = new Set([
    'read',
    'write',
    'web_search',
    'web_fetch',
    'datetime',
    'tool_search',
]);

const DEFERRED_PROVIDERS = new Set(['openai', 'xai', 'custom']);

function usesDeferredToolLoading(providerId) {
    return DEFERRED_PROVIDERS.has(String(providerId || '').toLowerCase());
}

function getDiscoveredToolNames(chatId = null) {
    const map = global._discoveredToolsByChat;
    if (!(map instanceof Map) || map.size === 0) return new Set();

    // Keep discoveries isolated per chat/cron session. The previous implementation
    // unioned every chat's discoveries, so a background cron turn could silently
    // inflate an unrelated Telegram request with extra tool schemas.
    if (chatId !== null && chatId !== undefined) {
        const direct = map.get(chatId) || map.get(String(chatId));
        if (!direct || typeof direct[Symbol.iterator] !== 'function') return new Set();
        return new Set(direct);
    }

    // Backward-compatible fallback for callers/tests that do not supply a chat id.
    const out = new Set();
    for (const names of map.values()) {
        if (!names || typeof names[Symbol.iterator] !== 'function') continue;
        for (const name of names) out.add(name);
    }
    return out;
}

function resetDiscoveredToolsForChat(chatId) {
    const map = global._discoveredToolsByChat;
    if (!(map instanceof Map)) return false;

    let removed = map.delete(chatId);
    const stringId = String(chatId);
    if (!removed && stringId !== chatId) removed = map.delete(stringId);
    return removed;
}

function selectDeferredTools(rawTools, discoveredToolNames = getDiscoveredToolNames()) {
    const tools = Array.isArray(rawTools) ? rawTools : [];
    const discovered = discoveredToolNames instanceof Set
        ? discoveredToolNames
        : new Set(discoveredToolNames || []);

    return tools.filter((tool) => {
        const name = tool && tool.name;
        return CORE_TOOL_NAMES.has(name) || discovered.has(name);
    });
}

function wrapFormatTools(adapter) {
    if (!adapter || !usesDeferredToolLoading(adapter.id)) return adapter;
    if (adapter.__contextLiteWrapped) return adapter;
    if (typeof adapter.formatTools !== 'function') return adapter;

    const originalFormatTools = adapter.formatTools.bind(adapter);
    adapter.formatTools = (rawTools, chatId = null) => {
        const selected = selectDeferredTools(rawTools, getDiscoveredToolNames(chatId));
        return originalFormatTools(selected);
    };
    Object.defineProperty(adapter, '__contextLiteWrapped', {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    return adapter;
}

module.exports = {
    CORE_TOOL_NAMES,
    DEFERRED_PROVIDERS,
    usesDeferredToolLoading,
    getDiscoveredToolNames,
    resetDiscoveredToolsForChat,
    selectDeferredTools,
    wrapFormatTools,
};
