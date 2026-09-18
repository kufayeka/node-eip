'use strict';

/**
 * Port Object (Class 0xF4) — CIP Vol 1, section 5-16.
 *
 * Mandatory CIP object for communication port enumeration and routing.
 * Used by Delta EIP Builder and Rockwell tools to display "Port Status" and
 * map communication interfaces to their respective Ethernet Link (0xF6)
 * and TCP/IP Interface (0xF5) objects.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class PortObject {
    constructor({
        portNumber = 1,
        portName = 'Port 1',
        portType = 4 // 4 = EtherNet/IP
    } = {}) {
        this.portNumber = portNumber;
        this.portName = portName;
        this.portType = portType;
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
                case 8: { // Entry Port
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(this.portNumber, 0);
                    return ok(b);
                }
                case 9: { // All Ports (Array of Struct { Type: UINT, Number: UINT })
                    const b = Buffer.alloc(4);
                    b.writeUInt16LE(this.portType, 0);
                    b.writeUInt16LE(this.portNumber, 2);
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
            case 1: { // Port Type (4 = EtherNet/IP)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(this.portType, 0);
                return ok(b);
            }
            case 2: { // Port Number
                const b = Buffer.alloc(2);
                b.writeUInt16LE(this.portNumber, 0);
                return ok(b);
            }
            case 3: { // Link Object (EPATH pointing to Ethernet Link Class 0xF6 Instance 1: 0x20, 0xF6, 0x24, 0x01)
                return ok(Buffer.from([0x20, 0xf6, 0x24, 0x01]));
            }
            case 4: { // Port Name (SHORT_STRING)
                const strBuf = Buffer.from(this.portName, 'ascii');
                return ok(Buffer.concat([Buffer.from([strBuf.length]), strBuf]));
            }
            case 7: { // Node Address (EPATH pointing to TCP/IP Class 0xF5 Instance 1: 0x20, 0xF5, 0x24, 0x01)
                return ok(Buffer.from([0x20, 0xf5, 0x24, 0x01]));
            }
            case 10: { // Routing Capabilities (UDINT)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(0, 0);
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance === 0) {
            const b = Buffer.alloc(6);
            b.writeUInt16LE(1, 0); // Revision
            b.writeUInt16LE(1, 2); // Max Instance
            b.writeUInt16LE(1, 4); // Number of Instances
            return ok(b);
        }
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        // Instance 1 Attributes All: Type(2), Number(2), Link Object(4), Port Name(SHORT_STRING)
        const header = Buffer.alloc(4);
        header.writeUInt16LE(this.portType, 0);
        header.writeUInt16LE(this.portNumber, 2);
        const linkObj = Buffer.from([0x20, 0xf6, 0x24, 0x01]);
        const nameBuf = Buffer.from(this.portName, 'ascii');
        const shortStr = Buffer.concat([Buffer.from([nameBuf.length]), nameBuf]);

        return ok(Buffer.concat([header, linkObj, shortStr]));
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

module.exports = { PortObject };
