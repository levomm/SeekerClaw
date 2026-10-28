'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// App-private, separate from workspace memory. No automatic replay on restart.
class DeliveryOutbox {
    constructor(directory) { this.directory = directory; this.queues = new Map(); }
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
                (p.state === 'acknowledged' && !Number.isSafeInteger(p.messageId)))) {
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
    prepare(chatId, text, replyTo, key) {
        const id = crypto.createHash('sha256').update(JSON.stringify([String(chatId), String(key)])).digest('hex').slice(0, 32);
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
        if (prior) {
            // Any persisted attempt (including a crash) is never replayed implicitly.
            const error = new Error('Delivery requires explicit recovery'); error.code = 'DELIVERY_PENDING'; error.deliveryId = id; throw error;
        }
        record.parts[part] = { state: 'attempting' }; this.save(record);
        let result;
        try { result = await send(); }
        catch (error) {
            record = this.read(id); record.parts[part] = { state: 'uncertain' }; record.state = 'uncertain'; this.save(record);
            throw error;
        }
        record = this.read(id);
        const mid = result?.ok === true ? result.result?.message_id : null;
        record.parts[part] = Number.isSafeInteger(mid) ? { state: 'acknowledged', messageId: mid }
            : { state: result?.ok === false ? 'rejected' : 'uncertain' };
        this.save(record);
        return result;
    }
    finish(id, result) {
        const record = this.read(id);
        const unresolved = Object.values(record.parts).some(p => p.state === 'attempting' || p.state === 'uncertain');
        record.state = unresolved ? 'uncertain' : result?.status || (Number.isSafeInteger(result?.messageId) ? 'acknowledged' : 'uncertain');
        record.messageId = result?.messageId ?? null;
        this.save(record);
        return { ...result, status: record.state, deliveryId: id };
    }
    list(chatId) {
        if (!fs.existsSync(this.directory)) return [];
        return fs.readdirSync(this.directory).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(n => this.read(n.slice(0, -5)))
            .filter(r => r.chatId === String(chatId) && r.state !== 'acknowledged')
            .sort((a, b) => b.createdAt - a.createdAt);
    }
}
module.exports = { DeliveryOutbox };
