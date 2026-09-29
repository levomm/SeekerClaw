'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60 minutes

let _stateFile = null;
let _log = () => {};
let _cooldownMs = DEFAULT_COOLDOWN_MS;
let _untilMs = 0;
let _reason = null;

function configureUsageLimitGuard({ workDir, logFn, cooldownMs } = {}) {
    if (typeof logFn === 'function') _log = logFn;
    if (Number.isFinite(cooldownMs) && cooldownMs >= 60000) _cooldownMs = cooldownMs;
    if (workDir) {
        _stateFile = path.join(workDir, 'usage_limit_state');
        _load();
    }
}

function _load() {
    if (!_stateFile) return;
    try {
        if (!fs.existsSync(_stateFile)) return;
        const parsed = JSON.parse(fs.readFileSync(_stateFile, 'utf8'));
        const until = Number(parsed?.untilMs) || 0;
        if (until > Date.now()) {
            _untilMs = until;
            _reason = typeof parsed?.reason === 'string' ? parsed.reason : 'usage_limit_reached';
        } else {
            _untilMs = 0;
            _reason = null;
            try { fs.unlinkSync(_stateFile); } catch (_) {}
        }
    } catch (e) {
        _log(`[UsageGuard] Failed to load state: ${e.message}`, 'WARN');
    }
}

function _persist() {
    if (!_stateFile) return;
    try {
        const tmp = _stateFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({
            version: 1,
            untilMs: _untilMs,
            reason: _reason,
            updatedAtMs: Date.now(),
        }), 'utf8');
        fs.renameSync(tmp, _stateFile);
    } catch (e) {
        _log(`[UsageGuard] Failed to persist state: ${e.message}`, 'WARN');
    }
}

function activateUsageLimitCooldown(reason = 'usage_limit_reached', nowMs = Date.now(), durationMs = _cooldownMs) {
    const duration = Number.isFinite(durationMs) && durationMs >= 60000 ? durationMs : _cooldownMs;
    const alreadyActive = _untilMs > nowMs;
    const nextUntil = alreadyActive ? _untilMs : nowMs + duration;
    _untilMs = nextUntil;
    _reason = reason || 'usage_limit_reached';
    _persist();
    return {
        active: true,
        untilMs: _untilMs,
        remainingMs: Math.max(0, _untilMs - nowMs),
        extended: !alreadyActive,
        reason: _reason,
    };
}

function getUsageLimitState(nowMs = Date.now()) {
    if (_untilMs <= nowMs) {
        if (_untilMs > 0) {
            _untilMs = 0;
            _reason = null;
            if (_stateFile) {
                try { fs.unlinkSync(_stateFile); } catch (_) {}
            }
        }
        return { active: false, untilMs: 0, remainingMs: 0, reason: null };
    }
    return {
        active: true,
        untilMs: _untilMs,
        remainingMs: _untilMs - nowMs,
        reason: _reason || 'usage_limit_reached',
    };
}

function isUsageLimitCooldownActive(nowMs = Date.now()) {
    return getUsageLimitState(nowMs).active;
}

function clearUsageLimitCooldown() {
    const wasActive = _untilMs > Date.now();
    _untilMs = 0;
    _reason = null;
    if (_stateFile) {
        try { fs.unlinkSync(_stateFile); } catch (_) {}
    }
    return wasActive;
}

module.exports = {
    DEFAULT_COOLDOWN_MS,
    configureUsageLimitGuard,
    activateUsageLimitCooldown,
    getUsageLimitState,
    isUsageLimitCooldownActive,
    clearUsageLimitCooldown,
};
