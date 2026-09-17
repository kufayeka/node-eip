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
        vendorId,
        deviceType,
        productCode,
        revision = { major: 1, minor: 0 },
        productName,
        serialNumber,
        status = 0,
        state = 0xff
    }) {
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
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

module.exports = { IdentityObject };
