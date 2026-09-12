'use strict';

// Provider-aware deferred tool loading.
//
// The agent owns a large tool registry (64 built-ins plus optional MCP tools).
// Sending every schema on every model round wastes context and request bytes.
// For providers that reliably support the tool_search discovery pattern we send
// only a small core set, then add tools discovered by tool_search for the active
// chat. Claude keeps the full set because prompt caching already makes that path
// efficient. OpenRouter also stays full because some small/free models have
// historically emitted raw XML instead of valid tool calls when asked to use
// deferred discovery.

const { AsyncLocalStorage } = require('async_hooks');

const CORE_TOOL_NAMES = new Set([
    'read',
    'write',
    'web_search',
    'web_fetch',
    'datetime',
    'tool_search',
]);

const DEFERRED_PROVIDERS = new Set(['openai', 'xai', 'custom']);
const _chatContext = new AsyncLocalStorage();

class DeferredDiscoveryMap extends Map {
    // ai.js deletes the current chat's discovery set at the start of every turn.
    // Capturing that key here gives provider adapters the correct per-chat context
    // without changing ai.js's hot tool loop. AsyncLocalStorage keeps concurrent
    // chat/cron turns isolated from each other.
    delete(key) {
        _chatContext.enterWith({ chatId: key });
        return super.delete(key);
    }
}

function ensureDeferredDiscoveryMap(current) {
    if (current instanceof DeferredDiscoveryMap) return current;
    const next = new DeferredDiscoveryMap();
    if (current && typeof current[Symbol.iterator] === 'function') {
        for (const [key, value] of current) {
            // Bypass the subclass method intentionally while migrating entries.
            Map.prototype.set.call(next, key, value);
        }
    }
    return next;
}

function currentDeferredChatId() {
    const store = _chatContext.getStore();
    return store ? store.chatId : null;
}

function usesDeferredToolLoading(providerId) {
    return DEFERRED_PROVIDERS.has(String(providerId || '').toLowerCase());
}

function selectDeferredTools(rawTools, discoveredToolNames) {
    const tools = Array.isArray(rawTools) ? rawTools : [];
    const discovered = discoveredToolNames instanceof Set
        ? discoveredToolNames
        : new Set(discoveredToolNames || []);

    return tools.filter((tool) => {
        const name = tool && tool.name;
        return CORE_TOOL_NAMES.has(name) || discovered.has(name);
    });
}

module.exports = {
    CORE_TOOL_NAMES,
    DEFERRED_PROVIDERS,
    DeferredDiscoveryMap,
    ensureDeferredDiscoveryMap,
    currentDeferredChatId,
    usesDeferredToolLoading,
    selectDeferredTools,
};
