'use strict';

/**
 * Connection Manager Object (Class 0x06) — CIP Vol 1, Chapter 5-2.
 *
 * Implements standard ODVA Connection Manager Object and Delta EtherNet/IP
 * specifications (Delta Operation Manual Chapter 8.6).
 * Maintains statistics of Forward_Open, Forward_Close, connection rejects,
 * and timeouts for SCADA diagnostics and Delta EIP Builder.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class ConnectionManagerObject {
    constructor() {
        this.openRequests = 0;
        this.openFormatRejects = 0;
        this.openResourceRejects = 0;
        this.openOtherRejects = 0;
        this.closeRequests = 0;
        this.closeFormatRejects = 0;
        this.closeOtherRejects = 0;
        this.connectionTimeouts = 0;
    }

    recordOpenRequest(success = true, rejectType = null) {
        this.openRequests = (this.openRequests + 1) & 0xffff;
        if (!success) {
            if (rejectType === 'format') this.openFormatRejects = (this.openFormatRejects + 1) & 0xffff;
            else if (rejectType === 'resource') this.openResourceRejects = (this.openResourceRejects + 1) & 0xffff;
            else this.openOtherRejects = (this.openOtherRejects + 1) & 0xffff;
        }
    }

    recordCloseRequest(success = true, rejectType = null) {
        this.closeRequests = (this.closeRequests + 1) & 0xffff;
        if (!success) {
            if (rejectType === 'format') this.closeFormatRejects = (this.closeFormatRejects + 1) & 0xffff;
            else this.closeOtherRejects = (this.closeOtherRejects + 1) & 0xffff;
        }
    }

    recordTimeout() {
        this.connectionTimeouts = (this.connectionTimeouts + 1) & 0xffff;
    }

    getAttributeSingle(instance, attribute) {
        if (instance === 0) {
            switch (attribute) {
                case 1: { // Class Revision
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

        const b = Buffer.alloc(2);
        switch (attribute) {
            case 1: // Open Requests
                b.writeUInt16LE(this.openRequests, 0);
                return ok(b);
            case 2: // Open Format Rejects
                b.writeUInt16LE(this.openFormatRejects, 0);
                return ok(b);
            case 3: // Open Resource Rejects
                b.writeUInt16LE(this.openResourceRejects, 0);
                return ok(b);
            case 4: // Open Other Rejects
                b.writeUInt16LE(this.openOtherRejects, 0);
                return ok(b);
            case 5: // Close Requests
                b.writeUInt16LE(this.closeRequests, 0);
                return ok(b);
            case 6: // Close Format Rejects
                b.writeUInt16LE(this.closeFormatRejects, 0);
                return ok(b);
            case 7: // Close Other Rejects
                b.writeUInt16LE(this.closeOtherRejects, 0);
                return ok(b);
            case 8: // Connection Timeouts
                b.writeUInt16LE(this.connectionTimeouts, 0);
                return ok(b);
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

        const b = Buffer.alloc(16);
        b.writeUInt16LE(this.openRequests, 0);
        b.writeUInt16LE(this.openFormatRejects, 2);
        b.writeUInt16LE(this.openResourceRejects, 4);
        b.writeUInt16LE(this.openOtherRejects, 6);
        b.writeUInt16LE(this.closeRequests, 8);
        b.writeUInt16LE(this.closeFormatRejects, 10);
        b.writeUInt16LE(this.closeOtherRejects, 12);
        b.writeUInt16LE(this.connectionTimeouts, 14);

        return ok(b);
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

module.exports = { ConnectionManagerObject };
