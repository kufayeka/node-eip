'use strict';

/**
 * Universal CIP Device Client
 *
 * Connects to any PLC and exposes dynamic read, write, and batch APIs
 * driven strictly by the PLC's DeviceProfile.
 */

const { Scanner } = require('../scanner');
const { BatchBuilder } = require('./batch-builder');
const { CipCommonServices } = require('../constants');
const { getProfile } = require('./registry');

class Device {
    constructor(hostOrOpts, profileOrKey, opts = {}) {
        let host;
        let scannerOpts;

        if (typeof hostOrOpts === 'object' && hostOrOpts !== null) {
            host = hostOrOpts.host;
            scannerOpts = { autoReconnect: true, reconnectDelayMs: 200, ...hostOrOpts };
        } else {
            host = hostOrOpts;
            scannerOpts = { autoReconnect: true, reconnectDelayMs: 200, ...opts };
        }

        if (typeof profileOrKey === 'string') {
            this.profile = getProfile(profileOrKey);
        } else if (profileOrKey && typeof profileOrKey.resolveAddress === 'function') {
            this.profile = profileOrKey;
        } else {
            throw new TypeError('Device: profileOrKey must be a registered profile key string or a DeviceProfile instance');
        }

        this.host = host;
        this.scanner = new Scanner(host, scannerOpts);

        // Proxy to support direct register helper methods (readD, writeD, readYBit, writeY, etc.)
        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target || typeof prop !== 'string') {
                    return target[prop];
                }

                // Check for write<Register>Bit / read<Register>Bit
                const writeBitMatch = /^write([A-Za-z]+)Bit$/.exec(prop);
                if (writeBitMatch && target.profile.hasRegister(writeBitMatch[1])) {
                    return (indexOrLabel, value, maybeValue) => {
                        const hasBitIdx = maybeValue !== undefined;
                        const bitIndex = hasBitIdx ? value : undefined;
                        const val = hasBitIdx ? maybeValue : value;
                        return target.write(writeBitMatch[1], indexOrLabel, val, { mode: 'bit', bitIndex });
                    };
                }

                const readBitMatch = /^read([A-Za-z]+)Bit$/.exec(prop);
                if (readBitMatch && target.profile.hasRegister(readBitMatch[1])) {
                    return (indexOrLabel, bitIndex) => target.read(readBitMatch[1], indexOrLabel, { mode: 'bit', bitIndex });
                }

                // Check for write<Register> / read<Register>
                const writeMatch = /^write([A-Za-z]+)$/.exec(prop);
                if (writeMatch && target.profile.hasRegister(writeMatch[1])) {
                    return (indexOrLabel, value) => target.write(writeMatch[1], indexOrLabel, value);
                }

                const readMatch = /^read([A-Za-z]+)$/.exec(prop);
                if (readMatch && target.profile.hasRegister(readMatch[1])) {
                    return (indexOrLabel) => target.read(readMatch[1], indexOrLabel);
                }

                // Check for profile custom methods
                if (target.profile.customMethods && typeof target.profile.customMethods[prop] === 'function') {
                    return (...args) => target.profile.customMethods[prop](target, ...args);
                }

                return undefined;
            }
        });
    }

    async connect() {
        return this.scanner.connect();
    }

    async disconnect() {
        return this.scanner.disconnect();
    }

    get session() {
        return this.scanner.session;
    }

    /**
     * Reads a register value directly.
     */
    async read(regName, indexOrLabel, options = {}) {
        const resolved = this.profile.resolveAddress(regName, indexOrLabel, options);
        if (resolved.access === 'w') {
            throw new Error(`Register "${regName}" is write-only`);
        }

        const data = await this.scanner.getAttribute({
            classId: resolved.classId,
            instance: resolved.instance,
            attribute: resolved.attribute
        });

        return this.profile.decodeValue(resolved, data);
    }

    /**
     * Writes a register value directly.
     */
    async write(regName, indexOrLabel, value, options = {}) {
        const resolved = this.profile.resolveAddress(regName, indexOrLabel, options);
        if (resolved.access === 'r') {
            throw new Error(`Register "${regName}" is read-only`);
        }

        const data = this.profile.encodeValue(resolved, value);
        await this.scanner.setAttribute({
            classId: resolved.classId,
            instance: resolved.instance,
            attribute: resolved.attribute,
            data
        });

        return true;
    }

    /**
     * Executes multiple register operations in a single ODVA CIP Multiple Service Packet (0x0A) round-trip.
     */
    async batch(builderFn) {
        if (typeof builderFn !== 'function') {
            throw new TypeError('batch: builderFn must be a function');
        }
        if (!this.profile.capabilities.multipleServicePacket) {
            throw new Error(`Device "${this.profile.vendor} ${this.profile.model}" does not support Multiple Service Packet (batch)`);
        }

        const builder = new BatchBuilder(this.profile);
        builderFn(builder);
        if (builder.operations.length === 0) return [];

        const requests = builder.operations.map(op => ({
            service: op.service,
            path: op.path,
            data: op.data
        }));

        const responses = await this.scanner.sendMultipleRequests(requests);
        return responses.map((res, i) => {
            const op = builder.operations[i];
            if (res.generalStatus !== 0) {
                throw new Error(`${op.label}: batch request failed with CIP status 0x${res.generalStatus.toString(16)}`);
            }
            return op.parse(res.data);
        });
    }
}

module.exports = { Device };
