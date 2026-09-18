'use strict';

/**
 * Quality of Service (QoS) Object (Class 0x48) — CIP Vol 2, Chapter 5-5.
 *
 * Mandatory object for modern EtherNet/IP devices. Configures DSCP priority
 * tagging for Class 1 cyclic I/O and explicit messaging traffic.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class QoSObject {
    constructor({
        tag8021QEnable = 0,
        dscpPtpEvent = 59,
        dscpPtpGeneral = 47,
        dscpUrgent = 55,
        dscpScheduled = 47,
        dscpHigh = 43,
        dscpLow = 31,
        dscpExplicit = 27
    } = {}) {
        this.tag8021QEnable = tag8021QEnable;
        this.dscpPtpEvent = dscpPtpEvent;
        this.dscpPtpGeneral = dscpPtpGeneral;
        this.dscpUrgent = dscpUrgent;
        this.dscpScheduled = dscpScheduled;
        this.dscpHigh = dscpHigh;
        this.dscpLow = dscpLow;
        this.dscpExplicit = dscpExplicit;
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
            case 1: return ok(Buffer.from([this.tag8021QEnable]));
            case 2: return ok(Buffer.from([this.dscpPtpEvent]));
            case 3: return ok(Buffer.from([this.dscpPtpGeneral]));
            case 4: return ok(Buffer.from([this.dscpUrgent]));
            case 5: return ok(Buffer.from([this.dscpScheduled]));
            case 6: return ok(Buffer.from([this.dscpHigh]));
            case 7: return ok(Buffer.from([this.dscpLow]));
            case 8: return ok(Buffer.from([this.dscpExplicit]));
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance === 0) {
            const b = Buffer.alloc(6);
            b.writeUInt16LE(1, 0);
            b.writeUInt16LE(1, 2);
            b.writeUInt16LE(1, 4);
            return ok(b);
        }
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        return ok(Buffer.from([
            this.tag8021QEnable,
            this.dscpPtpEvent,
            this.dscpPtpGeneral,
            this.dscpUrgent,
            this.dscpScheduled,
            this.dscpHigh,
            this.dscpLow,
            this.dscpExplicit
        ]));
    }

    setAttributeSingle(instance, attribute, data) {
        if (instance !== 1 || !data || data.length < 1) {
            return { generalStatus: CipGeneralStatus.InvalidParameterValue, data: Buffer.alloc(0) };
        }
        const val = data.readUInt8(0);
        switch (attribute) {
            case 1: this.tag8021QEnable = val; break;
            case 2: this.dscpPtpEvent = val; break;
            case 3: this.dscpPtpGeneral = val; break;
            case 4: this.dscpUrgent = val; break;
            case 5: this.dscpScheduled = val; break;
            case 6: this.dscpHigh = val; break;
            case 7: this.dscpLow = val; break;
            case 8: this.dscpExplicit = val; break;
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
        return ok(Buffer.alloc(0));
    }
}

module.exports = { QoSObject };
