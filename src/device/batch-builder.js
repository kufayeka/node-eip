'use strict';

/**
 * Universal Profile-Driven Batch Builder
 *
 * Queues register read/write operations into an ODVA CIP Multiple Service Packet (0x0A)
 * based strictly on the active DeviceProfile's schema.
 */

const { encodeEPath } = require('../cip/path');
const { CipCommonServices } = require('../constants');

class BatchBuilder {
    constructor(profile) {
        if (!profile || typeof profile.resolveAddress !== 'function') {
            throw new TypeError('BatchBuilder requires a valid DeviceProfile instance');
        }
        this.profile = profile;
        this.operations = [];

        // Dynamic helper methods for registers in this profile (e.g. readD, writeD, readY, writeYBit)
        return new Proxy(this, {
            get: (target, prop) => {
                if (prop in target || typeof prop !== 'string') {
                    return target[prop];
                }

                // Check for read<Register> / write<Register> / read<Register>Bit / write<Register>Bit
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

                const writeMatch = /^write([A-Za-z]+)$/.exec(prop);
                if (writeMatch && target.profile.hasRegister(writeMatch[1])) {
                    return (indexOrLabel, value) => target.write(writeMatch[1], indexOrLabel, value);
                }

                const readMatch = /^read([A-Za-z]+)$/.exec(prop);
                if (readMatch && target.profile.hasRegister(readMatch[1])) {
                    return (indexOrLabel) => target.read(readMatch[1], indexOrLabel);
                }

                // Custom method from profile
                if (target.profile.customMethods && typeof target.profile.customMethods[prop] === 'function') {
                    return (...args) => target.profile.customMethods[prop](target, ...args);
                }

                return undefined;
            }
        });
    }

    get length() {
        return this.operations.length;
    }

    /**
     * Queues a register read operation.
     */
    read(regName, indexOrLabel, options = {}) {
        const resolved = this.profile.resolveAddress(regName, indexOrLabel, options);
        if (resolved.access === 'w') {
            throw new Error(`Register "${regName}" is write-only`);
        }

        const path = encodeEPath({
            classId: resolved.classId,
            instance: resolved.instance,
            attribute: resolved.attribute
        });

        this.operations.push({
            label: `read(${regName}, ${indexOrLabel})`,
            service: CipCommonServices.GetAttributeSingle,
            path,
            data: Buffer.alloc(0),
            parse: (buf) => this.profile.decodeValue(resolved, buf)
        });

        return this;
    }

    /**
     * Queues a register write operation.
     */
    write(regName, indexOrLabel, value, options = {}) {
        const resolved = this.profile.resolveAddress(regName, indexOrLabel, options);
        if (resolved.access === 'r') {
            throw new Error(`Register "${regName}" is read-only`);
        }

        const data = this.profile.encodeValue(resolved, value);
        const path = encodeEPath({
            classId: resolved.classId,
            instance: resolved.instance,
            attribute: resolved.attribute
        });

        this.operations.push({
            label: `write(${regName}, ${indexOrLabel}, ${value})`,
            service: CipCommonServices.SetAttributeSingle,
            path,
            data,
            parse: () => true
        });

        return this;
    }
}

module.exports = { BatchBuilder };
