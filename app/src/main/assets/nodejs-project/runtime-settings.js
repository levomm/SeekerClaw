'use strict';
const fs = require('fs');
const path = require('path');

// One shared instance per process: failed/partial reads never increase a saved step budget.
function createRuntimeSettings(workDir, cold = {}, log = () => {}) {
    const integer = (v, min, max) => (typeof v === 'number' || typeof v === 'string') && Number.isInteger(Number(v)) && String(v).trim() !== '' && Number(v) >= min && Number(v) <= max ? Number(v) : null;
    const last = {
        maxStepsPerTurn: integer(cold.maxStepsPerTurn, 10, 100) ?? 12,
        heartbeatIntervalMinutes: integer(cold.heartbeatIntervalMinutes, 5, 120) ?? 30,
        richMessages: cold.richMessages !== false,
    };
    let warned = false;
    return {
        read() {
            try {
                const value = JSON.parse(fs.readFileSync(path.join(workDir, 'agent_settings.json'), 'utf8'));
                if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
                for (const [key, min, max] of [['maxStepsPerTurn', 10, 100], ['heartbeatIntervalMinutes', 5, 120]]) {
                    if (value[key] !== undefined) {
                        const n = integer(value[key], min, max);
                        if (n === null) throw new Error('range');
                        // Validate ALL fields before committing a snapshot.
                    }
                }
                if (value.richMessages !== undefined && typeof value.richMessages !== 'boolean') throw new Error('boolean');
                if (value.maxStepsPerTurn !== undefined) last.maxStepsPerTurn = Number(value.maxStepsPerTurn);
                if (value.heartbeatIntervalMinutes !== undefined) last.heartbeatIntervalMinutes = Number(value.heartbeatIntervalMinutes);
                if (value.richMessages !== undefined) last.richMessages = value.richMessages;
                warned = false;
            } catch (_) {
                if (!warned) log('[RuntimeSettings] Live settings unavailable or invalid; retaining last valid values', 'WARN');
                warned = true;
            }
            return { ...last };
        },
    };
}
module.exports = { createRuntimeSettings };
