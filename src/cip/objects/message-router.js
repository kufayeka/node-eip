'use strict';

/**
 * Message Router Object (Class 0x02) — CIP Vol 1, section 5-4.
 *
 * Mandatory CIP object present in every conformant CIP device.
 * Hosts the "Implemented Object List" (Attribute 1), which configuration tools
 * (Delta EIP Builder, Rockwell Studio 5000, RSNetWorx) and scanners query
 * to discover all supported CIP object classes on the device.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class MessageRouterObject {
    /**
     * @param {object} [options]
     * @param {number[]} [options.supportedClasses] Array of CIP class IDs implemented
     * @param {number} [options.maxConnections=16]
     */
    constructor({
        supportedClasses = [
            0x01, 0x02, 0x04, 0x06, 0x0f, 0x47, 0x48, 0xf4, 0xf5, 0xf6,
            0x350, 0x351, 0x352, 0x353, 0x354, 0x355, 0x356, 0x357, 0x358, 0x359,
            0x370, 0x371, 0x372
        ],
        maxConnections = 16
    } = {}) {
        this.supportedClasses = Array.from(new Set(supportedClasses));
        this.maxConnections = maxConnections;
    }

    addClass(classId) {
        if (!this.supportedClasses.includes(classId)) {
            this.supportedClasses.push(classId);
        }
    }

    _buildObjectListBuffer() {
        const count = this.supportedClasses.length;
        const buf = Buffer.alloc(2 + count * 2);
        buf.writeUInt16LE(count, 0);
        for (let i = 0; i < count; i++) {
            buf.writeUInt16LE(this.supportedClasses[i] & 0xffff, 2 + i * 2);
        }
        return buf;
    }

    getAttributeSingle(instance, attribute) {
        if (instance === 0) {
            switch (attribute) {
                case 1: { // Revision
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                case 2: { // Max Instance
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                case 3: { // Number of Instances
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                default:
                    return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
            }
        }

        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        switch (attribute) {
            case 1: {
                // Implemented Object List: Number of Classes (UINT16) + Classes (UINT16[])
                return ok(this._buildObjectListBuffer());
            }
            case 2: {
                // Number Available (UINT16)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(this.maxConnections, 0);
                return ok(b);
            }
            case 3: {
                // Number Active (UINT16)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(1, 0);
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance === 0) {
            const b = Buffer.alloc(6);
            b.writeUInt16LE(1, 0); // Rev
            b.writeUInt16LE(1, 2); // Max Inst
            b.writeUInt16LE(1, 4); // Num Inst
            return ok(b);
        }
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        const objList = this._buildObjectListBuffer();
        const stats = Buffer.alloc(4);
        stats.writeUInt16LE(this.maxConnections, 0);
        stats.writeUInt16LE(1, 2);

        return ok(Buffer.concat([objList, stats]));
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

module.exports = { MessageRouterObject };
