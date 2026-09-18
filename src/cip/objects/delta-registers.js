'use strict';

/**
 * Delta Electronics Vendor-Specific Objects (Classes 0x350 - 0x359, 0x370 - 0x376)
 *
 * Defined in Delta EtherNet/IP Operation Manual (Chapter 8.12).
 * Implements native Delta PLC register addressing accessible directly over
 * CIP Explicit Messaging (Services 0x0E, 0x10, 0x32, 0x33):
 *
 * - 0x350: X Register (Instance 1: Bit BOOL, Instance 2: Word INT)
 * - 0x351: Y Register (Instance 1: Bit BOOL, Instance 2: Word INT)
 * - 0x352: D Register (Instance 1: Bit BOOL, Instance 2: Word INT)
 * - 0x353: M Register (Instance 1: Bit BOOL)
 * - 0x354: S Register (Instance 1: Bit BOOL)
 * - 0x355: T Register (Instance 1: Bit BOOL, Instance 2: Value INT)
 * - 0x356: C Register (Instance 1: Bit BOOL, Instance 2: Value INT)
 * - 0x357: HC Register (Instance 1: Bit BOOL, Instance 2: Value DINT)
 * - 0x358: SM Register (Instance 1: Bit BOOL)
 * - 0x359: SR Register (Instance 2: Word INT)
 * - 0x370: Control / Status Register
 * - 0x371: Input Register
 * - 0x372: Output Register
 * - 0x373: RTU AI Register
 * - 0x374: RTU AO Register
 * - 0x375: RTU DI Register
 * - 0x376: RTU DO Register
 */

const { EventEmitter } = require('events');
const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class DeltaRegisterStore extends EventEmitter {
    constructor() {
        super();
        // Memory banks (allocate reasonable arrays/typed buffers)
        this.D = new Int16Array(65536); // D0..D65535
        this.M = new Uint8Array(65536); // M0..M65535 (0 or 1)
        this.X = new Uint8Array(4096);  // X0.0..X255.15
        this.Y = new Uint8Array(4096);  // Y0.0..Y255.15
        this.S = new Uint8Array(4096);  // S0..S4095
        this.T = new Uint8Array(4096);  // T bit
        this.TV = new Int16Array(4096); // T current value
        this.C = new Uint8Array(4096);  // C bit
        this.CV = new Int16Array(4096); // C current value
        this.HC = new Int32Array(1024); // HC 32-bit counter
        this.SM = new Uint8Array(4096); // Special M
        this.SR = new Int16Array(4096); // Special D
        this.CR = new Int16Array(256);  // Control Register
        this.SR70 = new Int16Array(256); // Status Register
        this.IR = new Int16Array(256);  // Input Register
        this.OR = new Int16Array(256);  // Output Register
    }

    getD(idx) { return this.D[idx & 0xffff]; }
    setD(idx, val) {
        const i = idx & 0xffff;
        const old = this.D[i];
        this.D[i] = val;
        if (old !== val) this.emit('change', { type: 'D', index: i, value: val });
    }

    getM(idx) { return this.M[idx & 0xffff]; }
    setM(idx, val) {
        const i = idx & 0xffff;
        const b = val ? 1 : 0;
        const old = this.M[i];
        this.M[i] = b;
        if (old !== b) this.emit('change', { type: 'M', index: i, value: b });
    }
}

class DeltaRegisterObject {
    /**
     * @param {number} classId Delta vendor class ID (e.g. 0x352 for D register)
     * @param {DeltaRegisterStore} store Shared register store
     */
    constructor(classId, store) {
        this.classId = classId;
        this.store = store;
    }

    getAttributeSingle(instance, attribute, data) {
        if (instance === 0) {
            if (attribute === 1) {
                const b = Buffer.alloc(2);
                b.writeUInt16LE(1, 0); // Class revision
                return ok(b);
            }
            return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }

        const attr = attribute & 0xffff;

        switch (this.classId) {
            case 0x350: { // X Register
                if (instance === 1) { // Bit
                    const val = this.store.X[attr % this.store.X.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                if (instance === 2) { // Word
                    const wordIdx = attr * 16;
                    let wordVal = 0;
                    for (let bit = 0; bit < 16; bit++) {
                        if (this.store.X[wordIdx + bit]) wordVal |= (1 << bit);
                    }
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(wordVal, 0);
                    return ok(b);
                }
                break;
            }

            case 0x351: { // Y Register
                if (instance === 1) { // Bit
                    const val = this.store.Y[attr % this.store.Y.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                if (instance === 2) { // Word
                    const wordIdx = attr * 16;
                    let wordVal = 0;
                    for (let bit = 0; bit < 16; bit++) {
                        if (this.store.Y[wordIdx + bit]) wordVal |= (1 << bit);
                    }
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(wordVal, 0);
                    return ok(b);
                }
                break;
            }

            case 0x352: { // D Register
                if (instance === 1) { // Bit (D0.0 ... D4096.15)
                    const regIdx = Math.floor(attr / 16);
                    const bitIdx = attr % 16;
                    const wordVal = this.store.D[regIdx % this.store.D.length];
                    const bitVal = (wordVal & (1 << bitIdx)) ? 1 : 0;
                    return ok(Buffer.from([bitVal]));
                }
                if (instance === 2) { // Word (D0 ... D65535)
                    const val = this.store.D[attr % this.store.D.length];
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(val, 0);
                    return ok(b);
                }
                break;
            }

            case 0x353: { // M Register (Bit)
                if (instance === 1) {
                    const val = this.store.M[attr % this.store.M.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                break;
            }

            case 0x354: { // S Register (Bit)
                if (instance === 1) {
                    const val = this.store.S[attr % this.store.S.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                break;
            }

            case 0x355: { // T Register
                if (instance === 1) {
                    const val = this.store.T[attr % this.store.T.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                if (instance === 2) {
                    const val = this.store.TV[attr % this.store.TV.length];
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(val, 0);
                    return ok(b);
                }
                break;
            }

            case 0x356: { // C Register
                if (instance === 1) {
                    const val = this.store.C[attr % this.store.C.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                if (instance === 2) {
                    const val = this.store.CV[attr % this.store.CV.length];
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(val, 0);
                    return ok(b);
                }
                break;
            }

            case 0x357: { // HC Register (32-bit counter)
                if (instance === 1) {
                    const val = (this.store.HC[attr % this.store.HC.length] !== 0) ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                if (instance === 2) {
                    const val = this.store.HC[attr % this.store.HC.length];
                    const b = Buffer.alloc(4);
                    b.writeInt32LE(val, 0);
                    return ok(b);
                }
                break;
            }

            case 0x358: { // SM Register (Special M)
                if (instance === 1) {
                    const val = this.store.SM[attr % this.store.SM.length] ? 1 : 0;
                    return ok(Buffer.from([val]));
                }
                break;
            }

            case 0x359: { // SR Register (Special D)
                if (instance === 2) {
                    const val = this.store.SR[attr % this.store.SR.length];
                    const b = Buffer.alloc(2);
                    b.writeInt16LE(val, 0);
                    return ok(b);
                }
                break;
            }

            case 0x370: { // Control / Status Register
                const val = (instance === 1)
                    ? this.store.CR[attr % this.store.CR.length]
                    : this.store.SR70[attr % this.store.SR70.length];
                const b = Buffer.alloc(2);
                b.writeInt16LE(val, 0);
                return ok(b);
            }

            case 0x371: { // Input Register
                const val = this.store.IR[attr % this.store.IR.length];
                const b = Buffer.alloc(2);
                b.writeInt16LE(val, 0);
                return ok(b);
            }

            case 0x372: { // Output Register
                const val = this.store.OR[attr % this.store.OR.length];
                const b = Buffer.alloc(2);
                b.writeInt16LE(val, 0);
                return ok(b);
            }
        }

        return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
    }

    setAttributeSingle(instance, attribute, data) {
        if (instance === 0) {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        const attr = attribute & 0xffff;
        if (!data || data.length === 0) {
            return { generalStatus: CipGeneralStatus.MissingAttributeList, data: Buffer.alloc(0) };
        }

        switch (this.classId) {
            case 0x350: { // X Register (Inputs usually read-only, but virtual can allow set)
                if (instance === 1) {
                    this.store.X[attr % this.store.X.length] = data[0] ? 1 : 0;
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x351: { // Y Register
                if (instance === 1) {
                    this.store.Y[attr % this.store.Y.length] = data[0] ? 1 : 0;
                    return ok(Buffer.alloc(0));
                }
                if (instance === 2 && data.length >= 2) {
                    const wordVal = data.readInt16LE(0);
                    const wordIdx = attr * 16;
                    for (let bit = 0; bit < 16; bit++) {
                        this.store.Y[wordIdx + bit] = (wordVal & (1 << bit)) ? 1 : 0;
                    }
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x352: { // D Register
                if (instance === 1) { // Bit write
                    const regIdx = Math.floor(attr / 16);
                    const bitIdx = attr % 16;
                    let wordVal = this.store.D[regIdx % this.store.D.length];
                    if (data[0]) wordVal |= (1 << bitIdx);
                    else wordVal &= ~(1 << bitIdx);
                    this.store.setD(regIdx, wordVal);
                    return ok(Buffer.alloc(0));
                }
                if (instance === 2 && data.length >= 2) { // Word write
                    const val = data.readInt16LE(0);
                    this.store.setD(attr, val);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x353: { // M Register
                if (instance === 1) {
                    this.store.setM(attr, data[0] ? 1 : 0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x354: { // S Register
                if (instance === 1) {
                    this.store.S[attr % this.store.S.length] = data[0] ? 1 : 0;
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x355: { // T Register
                if (instance === 1) {
                    this.store.T[attr % this.store.T.length] = data[0] ? 1 : 0;
                    return ok(Buffer.alloc(0));
                }
                if (instance === 2 && data.length >= 2) {
                    this.store.TV[attr % this.store.TV.length] = data.readInt16LE(0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x356: { // C Register
                if (instance === 1) {
                    this.store.C[attr % this.store.C.length] = data[0] ? 1 : 0;
                    return ok(Buffer.alloc(0));
                }
                if (instance === 2 && data.length >= 2) {
                    this.store.CV[attr % this.store.CV.length] = data.readInt16LE(0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x357: { // HC Register
                if (instance === 2 && data.length >= 4) {
                    this.store.HC[attr % this.store.HC.length] = data.readInt32LE(0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x370: { // Control Register
                if (instance === 1 && data.length >= 2) {
                    this.store.CR[attr % this.store.CR.length] = data.readInt16LE(0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }

            case 0x372: { // Output Register
                if (data.length >= 2) {
                    this.store.OR[attr % this.store.OR.length] = data.readInt16LE(0);
                    return ok(Buffer.alloc(0));
                }
                break;
            }
        }

        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }

    /**
     * Delta-specific service dispatcher:
     * - 0x32: Read_Parameter (reads register)
     * - 0x33: Write_Parameter (writes register)
     */
    handleService(service, path, data) {
        if (service === 0x32) { // Read_Parameter
            return this.getAttributeSingle(path.instance, path.attribute, data);
        }
        if (service === 0x33) { // Write_Parameter
            return this.setAttributeSingle(path.instance, path.attribute, data);
        }
        return { generalStatus: CipGeneralStatus.ServiceNotSupported, data: Buffer.alloc(0) };
    }
}

module.exports = { DeltaRegisterStore, DeltaRegisterObject };
