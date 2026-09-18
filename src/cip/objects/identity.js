'use strict';

/**
 * Server-side Identity Object (Class 0x01) — CIP Vol 1, section 5-2. Every
 * Adapter must have exactly one instance (Instance 1) of this; it's what
 * ListIdentity and explicit Get_Attribute_Single reads against Class 0x01
 * answer with. Read-only here — Set_Attribute_Single always rejected,
 * matching how every real device this driver has tested behaves for
 * Identity (see README Domain B/D).
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class IdentityObject {
    constructor({
        vendorId = 0xffff,
        deviceType = 0x0e,
        productCode = 0x0001,
        revision = { major: 1, minor: 0 },
        productName = 'EIP-Device',
        serialNumber = 0x12345678,
        status = 0x0060,
        state = 3
    } = {}) {
        this.vendorId = vendorId;
        this.deviceType = deviceType;
        this.productCode = productCode;
        this.revision = revision;
        this.productName = productName;
        this.serialNumber = serialNumber;
        this.status = status;
        this.state = state;
    }

    getAttributeSingle(instance, attribute) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        switch (attribute) {
            case 1: { const b = Buffer.alloc(2); b.writeUInt16LE(this.vendorId, 0); return ok(b); }
            case 2: { const b = Buffer.alloc(2); b.writeUInt16LE(this.deviceType, 0); return ok(b); }
            case 3: { const b = Buffer.alloc(2); b.writeUInt16LE(this.productCode, 0); return ok(b); }
            case 4: { const b = Buffer.alloc(2); b.writeUInt8(this.revision.major, 0); b.writeUInt8(this.revision.minor, 1); return ok(b); }
            case 5: { const b = Buffer.alloc(2); b.writeUInt16LE(this.status, 0); return ok(b); }
            case 6: { const b = Buffer.alloc(4); b.writeUInt32LE(this.serialNumber, 0); return ok(b); }
            case 7: {
                const nameBuf = Buffer.from(this.productName, 'ascii');
                return ok(Buffer.concat([Buffer.from([nameBuf.length]), nameBuf]));
            }
            case 8: {
                const b = Buffer.alloc(1);
                b.writeUInt8(this.state !== 0xff ? this.state : 3, 0); // 3 = Operational
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        const b = Buffer.alloc(14);
        b.writeUInt16LE(this.vendorId, 0);
        b.writeUInt16LE(this.deviceType, 2);
        b.writeUInt16LE(this.productCode, 4);
        b.writeUInt8(this.revision.major, 6);
        b.writeUInt8(this.revision.minor, 7);
        b.writeUInt16LE(this.status, 8);
        b.writeUInt32LE(this.serialNumber >>> 0, 10);

        const nameBuf = Buffer.from(this.productName, 'ascii');
        const shortString = Buffer.concat([Buffer.from([nameBuf.length]), nameBuf]);
        const stateBuf = Buffer.from([this.state]);

        return ok(Buffer.concat([b, shortString, stateBuf]));
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

function decodeIdentityAttributesAll(buf) {
    if (!buf || buf.length < 15) {
        throw new RangeError('decodeIdentityAttributesAll: buffer too short');
    }
    const vendorId = buf.readUInt16LE(0);
    const deviceType = buf.readUInt16LE(2);
    const productCode = buf.readUInt16LE(4);
    const revision = { major: buf[6], minor: buf[7] };
    const status = buf.readUInt16LE(8);
    const serialNumber = buf.readUInt32LE(10);
    const nameLen = buf[14];
    const productName = buf.subarray(15, 15 + nameLen).toString('ascii');
    let state = 0xff;
    if (buf.length >= 15 + nameLen + 1) {
        state = buf[15 + nameLen];
    }
    return {
        vendorId,
        deviceType,
        productCode,
        revision,
        status,
        serialNumber,
        productName,
        state
    };
}

module.exports = {
    IdentityObject,
    decodeIdentityAttributesAll
};
