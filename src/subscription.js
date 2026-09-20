'use strict';

/**
 * Dual-Mode Real-Time Tag Subscription & Watcher Subsystem
 *
 * Supports two distinct operational modes:
 * 1. 'polling' (TCP port 44818):
 *    Periodic explicit polling over TCP. When used with DeltaDevice, batches
 *    all registered registers into a single ODVA CIP Multiple Service Packet (0x0A)
 *    to resolve in a single round-trip (~6ms).
 *
 * 2. 'udp' / 'realtime' (UDP port 2222):
 *    Implicit Class 1 I/O cyclic streaming. Ingests Assembly 101 (200-byte buffer)
 *    and filters/slices each registered tag per word/bit offset.
 *
 * Event Architecture:
 * - 'change' (tag, newValue, oldValue, allValues, timestamp):
 *   Fired only when a register's value changes (by-exception / Change of State).
 * - 'change:<tag>' (newValue, oldValue, timestamp):
 *   Targeted event for specific tag changes.
 * - 'cyclic' (allValues, timestamp) / 'data' (allValues, timestamp):
 *   Fired on every cycle/tick/datagram regardless of whether values changed.
 * - 'error' (err):
 *   Fired on polling failure or UDP reception error.
 */

const EventEmitter = require('events');
const { decodeType } = require('./cip/types');
const { encodeAssemblyConnectionPath } = require('./cip/path');

/**
 * Parses a tag name or descriptor into a normalized tag definition.
 *
 * Examples:
 *   'D0'         -> { name: 'D0', register: 'D', index: 0, type: 'INT', offset: 0 }
 *   'D10'        -> { name: 'D10', register: 'D', index: 10, type: 'INT', offset: 20 }
 *   'D0:REAL'    -> { name: 'D0:REAL', register: 'D', index: 0, type: 'REAL', offset: 0 }
 *   'D0:DINT'    -> { name: 'D0:DINT', register: 'D', index: 0, type: 'DINT', offset: 0 }
 *   'D0:UINT'    -> { name: 'D0:UINT', register: 'D', index: 0, type: 'UINT', offset: 0 }
 *   'Y0'         -> { name: 'Y0', register: 'Y', index: 0, type: 'BOOL', offset: 0, bit: 0 }
 *   'M0'         -> { name: 'M0', register: 'M', index: 0, type: 'BOOL', offset: 0, bit: 0 }
 *   { name: 'X', offset: 4, type: 'INT' }
 *
 * @param {string|object} input
 * @returns {object} Normalized tag definition
 */
function normalizeTag(input) {
    if (!input) {
        throw new TypeError('normalizeTag: tag input cannot be null or undefined');
    }

    if (typeof input === 'object') {
        if (!input.name) {
            throw new Error('normalizeTag: tag object must have a "name" property');
        }
        return {
            name: String(input.name),
            register: input.register ? String(input.register).toUpperCase() : null,
            index: input.index !== undefined ? Number(input.index) : null,
            type: (input.type || 'INT').toUpperCase(),
            offset: input.offset !== undefined ? Number(input.offset) : 0,
            bit: input.bit !== undefined ? Number(input.bit) : null,
            deadband: Number(input.deadband || 0)
        };
    }

    const str = String(input).trim();
    // Parse syntax: REGISTER[INDEX][:TYPE] e.g. D10, D10:REAL, Y0, M100
    const match = str.match(/^([a-zA-Z]+)(\d+)(?::([a-zA-Z0-9]+))?$/);
    if (match) {
        const reg = match[1].toUpperCase();
        const idx = parseInt(match[2], 10);
        const explicitType = match[3] ? match[3].toUpperCase() : null;

        let type = 'INT';
        let offset = 0;
        let bit = null;

        if (reg === 'D') {
            type = explicitType || 'INT';
            offset = idx * 2;
        } else if (reg === 'Y' || reg === 'M' || reg === 'X' || reg === 'S') {
            type = 'BOOL';
            // In word-aligned assemblies: 16 bits per word
            const wordIdx = Math.floor(idx / 16);
            offset = wordIdx * 2;
            bit = idx % 16;
        } else if (reg === 'C' || reg === 'T') {
            type = explicitType || 'INT';
            offset = idx * 2;
        } else if (reg === 'HC') {
            type = explicitType || 'DINT';
            offset = idx * 4;
        }

        return {
            name: str,
            register: reg,
            index: idx,
            type,
            offset,
            bit,
            deadband: 0
        };
    }

    // Default fallback for custom tag string
    return {
        name: str,
        register: null,
        index: null,
        type: 'INT',
        offset: 0,
        bit: null,
        deadband: 0
    };
}

class Subscription extends EventEmitter {
    /**
     * @param {object} target - DeltaDevice or Scanner instance
     * @param {object} [options]
     * @param {'polling'|'udp'|'realtime'} [options.mode='polling'] - Operating mode
     * @param {number} [options.interval=100] - Polling interval in ms (polling mode)
     * @param {number} [options.rpiMs=20] - Requested Packet Interval in ms (UDP mode)
     * @param {Array<string|object>} [options.tags=[]] - Initial tags to subscribe
     * @param {number} [options.deadband=0] - Global deadband for analog values
     * @param {import('./cip/io-connection').IOConnection} [options.ioConnection] - Existing IOConnection
     * @param {number} [options.assemblyInstance=0x65] - T->O Assembly Instance (Delta 101)
     * @param {number} [options.assemblySize=200] - T->O Assembly payload size in bytes
     */
    constructor(target, options = {}) {
        super();
        if (!target) {
            throw new Error('Subscription: target (DeltaDevice or Scanner) is required');
        }

        this.target = target;
        const rawMode = (options.mode || 'polling').toLowerCase();
        this.mode = rawMode === 'realtime' ? 'udp' : rawMode;
        this.interval = Math.max(5, Number(options.interval || 100));
        this.rpiMs = Math.max(1, Number(options.rpiMs || 20));
        this.deadband = Number(options.deadband || 0);

        // IOConnection strips the 2-byte transport sequence count before emitting 'data',
        // so application assembly data starts at index 0.
        this.dataOffset = options.dataOffset !== undefined
            ? Number(options.dataOffset)
            : 0;

        this.assemblyInstance = options.assemblyInstance || 0x65;
        this.assemblySize = options.assemblySize || 200;
        this.o2tInstance = options.o2tInstance !== undefined ? options.o2tInstance : 0x64;
        this.configInstance = options.configInstance !== undefined ? options.configInstance : 0x80;
        this.ioPort = options.ioPort || 2222;

        this._tags = new Map();
        this._values = new Map();
        this._pollTimer = null;
        this._running = false;
        this._pollingInProgress = false;

        this._ioConnection = options.ioConnection || null;
        this._ownsIoConnection = false;
        this._connectionHandle = null;

        this._onUdpData = this._handleUdpData.bind(this);

        if (Array.isArray(options.tags)) {
            this.subscribe(options.tags);
        }
    }

    /**
     * Subscribes one or more tags.
     * @param {string|object|Array<string|object>} tags
     * @returns {Subscription} this
     */
    subscribe(tags) {
        const list = Array.isArray(tags) ? tags : [tags];
        for (const item of list) {
            const tagDef = normalizeTag(item);
            this._tags.set(tagDef.name, tagDef);
        }
        return this;
    }

    /**
     * Unsubscribes one or more tags.
     * @param {string|Array<string>} tags
     * @returns {Subscription} this
     */
    unsubscribe(tags) {
        const list = Array.isArray(tags) ? tags : [tags];
        for (const item of list) {
            const name = typeof item === 'object' ? item.name : item;
            this._tags.delete(name);
            this._values.delete(name);
        }
        return this;
    }

    /**
     * Returns a list of all currently subscribed tag names.
     * @returns {string[]}
     */
    getTags() {
        return Array.from(this._tags.keys());
    }

    /**
     * Checks whether a tag is subscribed.
     * @param {string} name
     * @returns {boolean}
     */
    hasTag(name) {
        return this._tags.has(name);
    }

    /**
     * Gets the latest cached value of a tag.
     * @param {string} name
     * @returns {any}
     */
    getValue(name) {
        return this._values.get(name);
    }

    /**
     * Returns a snapshot object of all current tag values.
     * @returns {Record<string, any>}
     */
    getValues() {
        const obj = {};
        for (const [k, v] of this._values.entries()) {
            obj[k] = v;
        }
        return obj;
    }

    /**
     * Starts the subscription engine.
     * @returns {Promise<Subscription>}
     */
    async start() {
        if (this._running) return this;
        this._running = true;

        try {
            if (this.mode === 'polling') {
                // Polling Mode (TCP 44818)
                this._pollTimer = setInterval(() => {
                    this._pollOnce().catch((err) => {
                        this.emit('error', err);
                    });
                }, this.interval);

                // Execute initial poll immediately
                this._pollOnce().catch((err) => {
                    this.emit('error', err);
                });
            } else if (this.mode === 'udp') {
                // Real-Time UDP 2222 Mode
                await this._initUdpMode();
            } else {
                throw new Error(`Subscription: invalid mode "${this.mode}". Expected "polling" or "udp"`);
            }
        } catch (err) {
            // _running must not stay stuck true on a failed start -- otherwise a caller's retry
            // (e.g. a Node-RED node re-attempting after a transient error) silently no-ops forever
            // on the `if (this._running) return this;` guard above, instead of actually retrying.
            this._running = false;
            throw err;
        }

        if (!this._sigintHandler) {
            this._sigintHandler = async () => {
                try {
                    await this.stop();
                } catch {}
                process.exit(0);
            };
            process.once('SIGINT', this._sigintHandler);
            process.once('SIGTERM', this._sigintHandler);
        }

        this.emit('start');
        return this;
    }

    /**
     * Stops the subscription engine.
     * @returns {Promise<void>}
     */
    async stop() {
        if (!this._running) return;
        this._running = false;

        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }

        if (this._sigintHandler) {
            process.removeListener('SIGINT', this._sigintHandler);
            process.removeListener('SIGTERM', this._sigintHandler);
            this._sigintHandler = null;
        }

        if (this._ioConnection) {
            this._ioConnection.removeListener('data', this._onUdpData);
            if (this._ownsIoConnection) {
                await this._ioConnection.stop();
                const scanner = this.target.scanner || this.target;
                if (this._connectionHandle && scanner && typeof scanner.closeConnection === 'function') {
                    try {
                        await scanner.closeConnection(this._connectionHandle);
                    } catch {}
                    this._connectionHandle = null;
                }
                this._ioConnection = null;
                this._ownsIoConnection = false;
            }
        }

        this.emit('stop');
    }

    /**
     * Initializes Class 1 Real-Time UDP I/O connection if not already provided.
     * @private
     */
    async _initUdpMode() {
        const scanner = this.target.scanner || this.target;

        if (!this._ioConnection) {
            // Auto-open Class 1 I/O connection via Forward_Open
            const connectionPath = encodeAssemblyConnectionPath({
                configInstance: this.configInstance,
                o2tInstance: this.o2tInstance,
                t2oInstance: this.assemblyInstance // Assembly 101 (200 bytes)
            });

            // openConnection() above is the point of no return: once it resolves, the Target has
            // already granted this connection and considers it Exclusive-Owner-ed by us. Everything
            // from here down (createIoConnection, starting the UDP socket/timers) is local and CAN
            // fail on its own (e.g. EADDRINUSE on the local UDP port) with no involvement from the
            // Target at all -- if that happens and we just let the exception propagate, the caller
            // is left holding a connection handle it doesn't know it owns, and this Subscription
            // never sends the matching Forward_Close. The real symptom this caused: a Node-RED node
            // whose 'udp' mode start() throws once (e.g. a transient error) leaves the real PLC
            // believing that connection point is still exclusively owned forever, since nothing
            // else on our side will ever ask it to release it -- every subsequent Forward_Open
            // attempt to the same connection point then fails with extended status 0x0106 (Ownership
            // Conflict), regardless of what is or isn't running locally afterward.
            this._connectionHandle = await scanner.openConnection({
                connectionPath,
                rpiUs: this.rpiMs * 1000,
                otSize: this.assemblySize,
                toSize: this.assemblySize
            });

            try {
                this._ioConnection = scanner.createIoConnection(this._connectionHandle, {
                    port: this.ioPort,
                    rpiMs: this.rpiMs,
                    initialOutputData: Buffer.alloc(this.assemblySize)
                });
                this._ownsIoConnection = true;
                await this._ioConnection.start();
            } catch (err) {
                try { if (this._ioConnection) await this._ioConnection.stop(); } catch {}
                try { await scanner.closeConnection(this._connectionHandle); } catch {}
                this._connectionHandle = null;
                this._ioConnection = null;
                this._ownsIoConnection = false;
                throw err;
            }
        }

        this._ioConnection.on('data', this._onUdpData);
    }

    /**
     * Ingests and filters incoming UDP 2222 Assembly datagram buffer.
     * @param {Buffer} buffer
     * @private
     */
    _handleUdpData(buffer) {
        if (!this._running || !Buffer.isBuffer(buffer)) return;
        this._decodeBuffer(buffer, Date.now());
    }

    /**
     * Decodes and filters buffer for registered tags, emitting change and cyclic events.
     * @param {Buffer} buffer
     * @param {number} timestamp
     * @private
     */
    _decodeBuffer(buffer, timestamp) {
        const currentSnapshot = {};
        const changedTags = [];

        for (const tag of this._tags.values()) {
            let val;
            const effectiveOffset = this.dataOffset + tag.offset;
            try {
                if (tag.bit !== null) {
                    // Bit-level access (e.g. Y0..Y15 in word, or M0..M15)
                    if (effectiveOffset >= buffer.length) continue;
                    if (tag.bit < 8) {
                        val = ((buffer[effectiveOffset] >> tag.bit) & 0x01) === 1;
                    } else {
                        // High byte of word
                        val = ((buffer[effectiveOffset + 1] >> (tag.bit - 8)) & 0x01) === 1;
                    }
                } else {
                    // Word / DWord / Float decoded according to type
                    const decoded = decodeType(tag.type, buffer, effectiveOffset);
                    val = decoded.value;
                }
            } catch {
                continue; // Skip out-of-range or malformed slice
            }

            currentSnapshot[tag.name] = val;

            const hasPrevious = this._values.has(tag.name);
            const oldVal = this._values.get(tag.name);

            if (!hasPrevious || this._isChanged(val, oldVal, tag.deadband || this.deadband)) {
                this._values.set(tag.name, val);
                changedTags.push({ tag: tag.name, newValue: val, oldValue: oldVal });
            }
        }

        // 1. Emit Change of State events (by-exception)
        for (const change of changedTags) {
            this.emit('change', change.tag, change.newValue, change.oldValue, currentSnapshot, timestamp);
            this.emit(`change:${change.tag}`, change.newValue, change.oldValue, timestamp);
        }

        // 2. Emit Cyclic events on every cycle/packet
        this.emit('cyclic', currentSnapshot, timestamp);
        this.emit('data', currentSnapshot, timestamp);
    }

    /**
     * Single polling tick over TCP (44818).
     * @private
     */
    async _pollOnce() {
        if (!this._running || this._pollingInProgress) return;
        if (this._tags.size === 0) return;

        this._pollingInProgress = true;
        const timestamp = Date.now();

        try {
            const currentSnapshot = {};
            const changedTags = [];

            // If target is DeltaDevice, use Multiple Service Packet (0x0A) batch
            if (typeof this.target.batch === 'function') {
                const tagList = Array.from(this._tags.values());

                const results = await this.target.batch((builder) => {
                    for (const tag of tagList) {
                        const reg = tag.register;
                        const idx = tag.index;

                        if (reg === 'D') {
                            builder.readD(idx);
                        } else if (reg === 'Y') {
                            builder.readYBit(idx);
                        } else if (reg === 'M') {
                            builder.readM(idx);
                        } else if (reg === 'X') {
                            builder.readXBit(idx);
                        } else if (reg === 'S') {
                            builder.readS(idx);
                        } else if (reg === 'T') {
                            builder.readT(idx);
                        } else if (reg === 'C') {
                            builder.readC(idx);
                        } else if (reg === 'HC') {
                            builder.readHC(idx);
                        } else if (reg === 'SM') {
                            builder.readSM(idx);
                        } else if (reg === 'SR') {
                            builder.readSR(idx);
                        } else {
                            // Default to D
                            builder.readD(idx || 0);
                        }
                    }
                });

                for (let i = 0; i < tagList.length; i++) {
                    const tag = tagList[i];
                    const val = results[i];
                    currentSnapshot[tag.name] = val;

                    const hasPrevious = this._values.has(tag.name);
                    const oldVal = this._values.get(tag.name);

                    if (!hasPrevious || this._isChanged(val, oldVal, tag.deadband || this.deadband)) {
                        this._values.set(tag.name, val);
                        changedTags.push({ tag: tag.name, newValue: val, oldValue: oldVal });
                    }
                }
            } else {
                // Generic Scanner: read sequentially
                for (const tag of this._tags.values()) {
                    let val;
                    if (tag.register === 'D') {
                        val = await this.target.readD(tag.index);
                    } else if (tag.register === 'Y') {
                        val = await this.target.readYBit(tag.index);
                    } else {
                        val = await this.target.readD(tag.index || 0);
                    }
                    currentSnapshot[tag.name] = val;

                    const hasPrevious = this._values.has(tag.name);
                    const oldVal = this._values.get(tag.name);

                    if (!hasPrevious || this._isChanged(val, oldVal, tag.deadband || this.deadband)) {
                        this._values.set(tag.name, val);
                        changedTags.push({ tag: tag.name, newValue: val, oldValue: oldVal });
                    }
                }
            }

            // Emit Change events
            for (const change of changedTags) {
                this.emit('change', change.tag, change.newValue, change.oldValue, currentSnapshot, timestamp);
                this.emit(`change:${change.tag}`, change.newValue, change.oldValue, timestamp);
            }

            // Emit Cyclic events
            this.emit('cyclic', currentSnapshot, timestamp);
            this.emit('data', currentSnapshot, timestamp);

        } finally {
            this._pollingInProgress = false;
        }
    }

    /**
     * Determines if a value change exceeds the deadband threshold.
     * @private
     */
    _isChanged(newVal, oldVal, deadband = 0) {
        if (typeof newVal === 'number' && typeof oldVal === 'number') {
            return Math.abs(newVal - oldVal) > deadband;
        }
        return newVal !== oldVal;
    }
}

module.exports = {
    Subscription,
    normalizeTag
};
