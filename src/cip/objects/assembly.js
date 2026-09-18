'use strict';

/**
 * Server-side Assembly Object (Class 0x04) — CIP Vol 1, section 5-6.
 * Holds one plain byte buffer per instance, exposed as Attribute 3 (Data)
 * and Attribute 4 (Size); this is exactly the shape this driver already
 * read/wrote against real Delta devices (README Domain E/J), just now on
 * the serving side. The Connection Manager (connection-handler.js) reads
 * the "input"/produced instance's buffer to fill outgoing T->O datagrams,
 * and writes incoming O->T datagrams into the "output"/consumed instance's
 * buffer — this object doesn't know or care which instances are used for
 * I/O connections vs. pure explicit-messaging scratch data.
 *
 * Set_Attribute_Single enforces the exact same size-match rule real Delta
 * hardware was found to enforce (README Domain B): a write whose length
 * doesn't match the instance's current size is rejected with
 * TooMuchData — this was discovered empirically against real hardware,
 * not assumed, so replicating it here isn't guesswork, it's fidelity.
 */

const { EventEmitter } = require('events');
const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class AssemblyObject extends EventEmitter {
    constructor({ maxFragmentSize = 0 } = {}) {
        super();
        this.instances = new Map(); // instance number -> Buffer
        this.maxFragmentSize = maxFragmentSize;
    }

    /** Defines (or resets) an instance with a given byte size, initially all-zero. */
    define(instance, sizeBytes) {
        this.instances.set(instance, Buffer.alloc(sizeBytes));
        return this;
    }

    has(instance) {
        return this.instances.has(instance);
    }

    /** Direct buffer access for the Connection Manager's cyclic I/O — bypasses the CIP service framing. */
    getData(instance) {
        return this.instances.get(instance);
    }

    setData(instance, buf, { silent = false } = {}) {
        const current = this.instances.get(instance);
        if (!current) {
            throw new Error(`AssemblyObject.setData: instance ${instance} is not defined`);
        }
        if (buf.length !== current.length) {
            throw new RangeError(`AssemblyObject.setData: instance ${instance} is ${current.length} bytes, got ${buf.length}`);
        }
        const hasChanged = !buf.equals(current);
        const oldBuf = Buffer.from(current);
        buf.copy(current);
        if (hasChanged) {
            this.emit('change', instance, current, oldBuf);
        }
        if (!silent) {
            this.emit('write', instance, current, oldBuf);
        }
        return this;
    }

    /** Convenience helper: defines instance if absent and sets its data. */
    set(instance, buf) {
        if (!this.instances.has(instance) || this.instances.get(instance).length !== buf.length) {
            this.define(instance, buf.length);
        }
        return this.setData(instance, buf);
    }

    getAttributeSingle(instance, attribute, requestData) {
        if (instance === 0) {
            // Class-level attributes (CIP Vol 1, 4-4.4) — Max Instance/Number
            // of Instances reflect whatever's actually been define()'d so
            // far, since Assembly instances here are created dynamically
            // rather than fixed at startup.
            switch (attribute) {
                case 1: { const b = Buffer.alloc(2); b.writeUInt16LE(2, 0); return ok(b); } // Revision (matches this driver's own EDS exporter's [Assembly] Revision)
                case 2: { const b = Buffer.alloc(2); b.writeUInt16LE(this.instances.size ? Math.max(...this.instances.keys()) : 0, 0); return ok(b); } // Max Instance
                case 3: { const b = Buffer.alloc(2); b.writeUInt16LE(this.instances.size, 0); return ok(b); } // Number of Instances
                default:
                    return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
            }
        }
        const data = this.instances.get(instance);
        if (!data) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        if (attribute === 3) {
            let offset = 0;
            if (requestData && requestData.length >= 4) {
                offset = requestData.readUInt32LE(0);
            }
            const maxChunk = this.maxFragmentSize || 0;
            if (maxChunk > 0 && (data.length - offset) > maxChunk) {
                const slice = data.subarray(offset, offset + maxChunk);
                return { generalStatus: CipGeneralStatus.PartialTransfer, data: slice };
            }
            const slice = offset > 0 ? data.subarray(offset) : data;
            return ok(slice);
        }
        if (attribute === 4) {
            const b = Buffer.alloc(2);
            b.writeUInt16LE(data.length, 0);
            return ok(b);
        }
        return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
    }

    setAttributeSingle(instance, attribute, newData) {
        const current = this.instances.get(instance);
        if (!current) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        if (attribute !== 3) {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }
        // Support chunked writes with 4-byte offset header
        if (newData.length > 4 && this.maxFragmentSize && newData.length < current.length) {
            const offset = newData.readUInt32LE(0);
            const chunk = newData.subarray(4);
            if (offset + chunk.length <= current.length) {
                chunk.copy(current, offset);
                const isFinal = (offset + chunk.length) === current.length;
                return {
                    generalStatus: isFinal ? CipGeneralStatus.Success : CipGeneralStatus.PartialTransfer,
                    data: Buffer.alloc(0)
                };
            }
        }
        if (newData.length !== current.length) {
            return { generalStatus: CipGeneralStatus.TooMuchData, data: Buffer.alloc(0) };
        }
        const hasChanged = !newData.equals(current);
        const oldBuf = Buffer.from(current);
        newData.copy(current);
        if (hasChanged) {
            this.emit('change', instance, current, oldBuf);
        }
        this.emit('write', instance, current, oldBuf);
        return ok(Buffer.alloc(0));
    }
}

module.exports = { AssemblyObject };
