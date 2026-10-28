'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ACK_RETENTION_MS = 24 * 60 * 60 * 1000;
function pendingDeliveryError(id, cause) {
    const error = new Error('Response saved; awaiting explicit /outbox recovery');
    error.code = 'DELIVERY_PENDING'; error.deliveryId = id; error.cause = cause;
    return error;
}

// App-private, bot-scoped, separate from memory. No automatic replay on restart.
class DeliveryOutbox {
    constructor(directory, namespace = '') {
        this.directory = directory; this.namespace = namespace;
        this.queues = new Map(); this.nextSweepAt = 0; this.unreadableCount = 0;
    }
    file(id) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid delivery ID');
        return path.join(this.directory, id + '.json');
    }
    read(id) {
        const value = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
        if (value.id !== id || !value.parts || typeof value.parts !== 'object' || Array.isArray(value.parts) ||
            typeof value.text !== 'string' || typeof value.chatId !== 'string' ||
            !['ready', 'acknowledged', 'uncertain', 'rejected'].includes(value.state) ||
            Object.values(value.parts).some(p => !p || !['attempting', 'acknowledged', 'uncertain', 'rejected'].includes(p.state) ||
                (p.state === 'acknowledged' && (!Number.isSafeInteger(p.messageId) || p.messageId <= 0))) ||
            (value.state === 'acknowledged' && (!Number.isSafeInteger(value.messageId) || value.messageId <= 0 ||
                !Object.values(value.parts).some(p => p.state === 'acknowledged') ||
                Object.values(value.parts).some(p => p.state === 'attempting' || p.state === 'uncertain')))) {
            throw new Error('Invalid outbox record; preserved for recovery');
        }
        return value;
    }
    save(record) {
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const dest = this.file(record.id);
        const temp = dest + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        let fd;
        try {
            fd = fs.openSync(temp, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
            fs.renameSync(temp, dest);
            const dir = fs.openSync(this.directory, 'r');
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    }
    prune(now = Date.now()) {
        if (now < this.nextSweepAt) return;
        this.nextSweepAt = now + 60000;
        // ACK-only housekeeping must never erase pending/unknown/crashed records
        // or mask the outcome of an attempted POST if storage is failing.
        try {
            for (const name of fs.readdirSync(this.directory)) {
                if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
                try {
                    const record = this.read(name.slice(0, -5));
                    const at = record.acknowledgedAt ?? record.createdAt;
                    if (record.state === 'acknowledged' && Number.isFinite(at) && now - at >= ACK_RETENTION_MS) fs.unlinkSync(this.file(record.id));
                } catch (_) { /* preserve unreadable records */ }
            }
        } catch (_) { /* best-effort cleanup, never a send retry */ }
    }
    prepare(chatId, text, replyTo, key) {
        this.prune();
        const id = crypto.createHash('sha256').update(JSON.stringify([this.namespace, String(chatId), String(key)])).digest('hex').slice(0, 32);
        if (fs.existsSync(this.file(id))) return this.read(id);
        const record = { id, chatId: String(chatId), text, replyTo: replyTo ?? null, createdAt: Date.now(), state: 'ready', parts: {} };
        this.save(record);
        return record;
    }
    async run(id, action) {
        const previous = this.queues.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(action);
        this.queues.set(id, next);
        try { return await next; } finally { if (this.queues.get(id) === next) this.queues.delete(id); }
    }
    async attempt(id, part, send) {
        let record = this.read(id);
        const prior = record.parts[part];
        if (prior?.state === 'acknowledged') return { ok: true, result: { message_id: prior.messageId } };
        if (prior) throw pendingDeliveryError(id);
        record.parts[part] = { state: 'attempting' }; this.save(record);
        try {
            const result = await send();
            record = this.read(id);
            const mid = result?.ok === true ? result.result?.message_id : null;
            record.parts[part] = Number.isSafeInteger(mid) && mid > 0 ? { state: 'acknowledged', messageId: mid }
                : { state: result?.ok === false ? 'rejected' : 'uncertain' };
            this.save(record);
            return result;
        } catch (cause) {
            try {
                record = this.read(id); record.parts[part] = { state: 'uncertain' }; record.state = 'uncertain'; this.save(record);
            } catch (_) { /* the durable ATTEMPTING record still fences replay */ }
            throw pendingDeliveryError(id, cause);
        }
    }
    finish(id, result) {
        try {
            const record = this.read(id);
            const unresolved = Object.values(record.parts).some(p => p.state === 'attempting' || p.state === 'uncertain');
            record.state = unresolved ? 'uncertain' : result?.status || (Number.isSafeInteger(result?.messageId) ? 'acknowledged' : 'uncertain');
            record.messageId = result?.messageId ?? null;
            if (record.state === 'acknowledged' && !Object.values(record.parts).some(p => p.state === 'acknowledged')) record.state = 'uncertain';
            if (record.state === 'acknowledged') {
                record.text = ''; record.acknowledgedAt = Date.now(); // retain only a short-lived dedup tombstone
            }
            this.save(record); this.prune();
            return { ...result, status: record.state, deliveryId: id };
        } catch (cause) { throw pendingDeliveryError(id, cause); }
    }
    list(chatId) {
        this.prune(); this.unreadableCount = 0;
        if (!fs.existsSync(this.directory)) return [];
        return fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).flatMap(n => {
            try { return [this.read(n.slice(0, -5))]; }
            catch (_) { this.unreadableCount++; return []; } // preserve bad files without blocking healthy answers
        })
            .filter(r => r.chatId === String(chatId) && r.state !== 'acknowledged')
            .sort((a, b) => b.createdAt - a.createdAt);
    }
}
module.exports = { DeliveryOutbox, pendingDeliveryError, ACK_RETENTION_MS };
