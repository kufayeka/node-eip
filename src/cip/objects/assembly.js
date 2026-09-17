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

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class AssemblyObject {
    constructor() {
        this.instances = new Map(); // instance number -> Buffer
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

    setData(instance, buf) {
        const current = this.instances.get(instance);
        if (!current) {
            throw new Error(`AssemblyObject.setData: instance ${instance} is not defined`);
        }
        if (buf.length !== current.length) {
            throw new RangeError(`AssemblyObject.setData: instance ${instance} is ${current.length} bytes, got ${buf.length}`);
        }
        buf.copy(current);
        return this;
    }

    /** Convenience helper: defines instance if absent and sets its data. */
    set(instance, buf) {
        if (!this.instances.has(instance) || this.instances.get(instance).length !== buf.length) {
            this.define(instance, buf.length);
        }
        return this.setData(instance, buf);
    }

    getAttributeSingle(instance, attribute) {
        const data = this.instances.get(instance);
        if (!data) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        if (attribute === 3) {
            return ok(data);
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
        if (newData.length !== current.length) {
            return { generalStatus: CipGeneralStatus.TooMuchData, data: Buffer.alloc(0) };
        }
        newData.copy(current);
        return ok(Buffer.alloc(0));
    }
}

module.exports = { AssemblyObject };
