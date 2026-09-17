'use strict';

/**
 * Delta Batch Builder — allows queuing multiple Delta register read/write
 * operations into a single ODVA CIP Multiple Service Packet (0x0A) over the
 * network, executing in a single TCP round-trip.
 */

const { encodeEPath } = require('../cip/path');
const { CipCommonServices } = require('../constants');
const {
    RegisterClass,
    RegisterInstance,
    WordByteWidth,
    ReadOnlyClasses,
    wordInstance,
    bitAttribute
} = require('./registers');

class DeltaBatchBuilder {
    constructor() {
        this.operations = [];
    }

    get length() {
        return this.operations.length;
    }

    _addWordRead(classId, registerNumber) {
        if (WordByteWidth[classId] === undefined) {
            throw new Error(`batch readWord: register class 0x${classId.toString(16)} has no word-mode instance`);
        }
        const width = WordByteWidth[classId];
        const path = encodeEPath({
            classId,
            instance: wordInstance(classId),
            attribute: registerNumber
        });
        this.operations.push({
            label: `readWord(0x${classId.toString(16)}, ${registerNumber})`,
            service: CipCommonServices.GetAttributeSingle,
            path,
            data: Buffer.alloc(0),
            parse: (buf) => (width === 4 ? buf.readInt32LE(0) : buf.readInt16LE(0))
        });
        return this;
    }

    _addWordWrite(classId, registerNumber, value) {
        if (ReadOnlyClasses.has(classId)) {
            throw new Error(`batch writeWord: register class 0x${classId.toString(16)} is read-only`);
        }
        if (WordByteWidth[classId] === undefined) {
            throw new Error(`batch writeWord: register class 0x${classId.toString(16)} has no word-mode instance`);
        }
        const width = WordByteWidth[classId];
        const data = Buffer.alloc(width);
        if (width === 4) {
            data.writeInt32LE(value, 0);
        } else {
            data.writeInt16LE(value, 0);
        }
        const path = encodeEPath({
            classId,
            instance: wordInstance(classId),
            attribute: registerNumber
        });
        this.operations.push({
            label: `writeWord(0x${classId.toString(16)}, ${registerNumber}, ${value})`,
            service: CipCommonServices.SetAttributeSingle,
            path,
            data,
            parse: () => true
        });
        return this;
    }

    _addBitRead(classId, registerNumberOrWord, bitIndex) {
        const attribute = bitIndex === undefined
            ? registerNumberOrWord
            : bitAttribute(registerNumberOrWord, bitIndex);
        const path = encodeEPath({
            classId,
            instance: RegisterInstance.Bit,
            attribute
        });
        this.operations.push({
            label: `readBit(0x${classId.toString(16)}, ${attribute})`,
            service: CipCommonServices.GetAttributeSingle,
            path,
            data: Buffer.alloc(0),
            parse: (buf) => buf.readUInt8(0) !== 0
        });
        return this;
    }

    _addBitWrite(classId, registerNumberOrWord, bitIndexOrValue, maybeValue) {
        if (ReadOnlyClasses.has(classId)) {
            throw new Error(`batch writeBit: register class 0x${classId.toString(16)} is read-only`);
        }
        const hasBitIndex = maybeValue !== undefined;
        const attribute = !hasBitIndex
            ? registerNumberOrWord
            : bitAttribute(registerNumberOrWord, bitIndexOrValue);
        const value = hasBitIndex ? maybeValue : bitIndexOrValue;

        // D register bit writes expect 2 bytes per Delta manual
        const data = classId === RegisterClass.D
            ? Buffer.from([value ? 1 : 0, 0])
            : Buffer.from([value ? 1 : 0]);

        const path = encodeEPath({
            classId,
            instance: RegisterInstance.Bit,
            attribute
        });
        this.operations.push({
            label: `writeBit(0x${classId.toString(16)}, ${attribute}, ${value})`,
            service: CipCommonServices.SetAttributeSingle,
            path,
            data,
            parse: () => true
        });
        return this;
    }

    // Public API mirroring DeltaDevice
    readX(n) { return this._addWordRead(RegisterClass.X, n); }
    readXBit(n, bitIndex) { return this._addBitRead(RegisterClass.X, n, bitIndex); }

    readY(n) { return this._addWordRead(RegisterClass.Y, n); }
    writeY(n, v) { return this._addWordWrite(RegisterClass.Y, n, v); }
    readYBit(n, bitIndex) { return this._addBitRead(RegisterClass.Y, n, bitIndex); }
    writeYBit(n, bitIndexOrValue, maybeValue) {
        return this._addBitWrite(RegisterClass.Y, n, bitIndexOrValue, maybeValue);
    }

    readD(n) { return this._addWordRead(RegisterClass.D, n); }
    writeD(n, v) { return this._addWordWrite(RegisterClass.D, n, v); }
    readDBit(n, bitIndex) { return this._addBitRead(RegisterClass.D, n, bitIndex); }
    writeDBit(n, bitIndexOrValue, maybeValue) {
        return this._addBitWrite(RegisterClass.D, n, bitIndexOrValue, maybeValue);
    }

    readM(n) { return this._addBitRead(RegisterClass.M, n); }
    writeM(n, v) { return this._addBitWrite(RegisterClass.M, n, v); }

    readS(n) { return this._addBitRead(RegisterClass.S, n); }
    writeS(n, v) { return this._addBitWrite(RegisterClass.S, n, v); }

    readT(n) { return this._addWordRead(RegisterClass.T, n); }
    writeT(n, v) { return this._addWordWrite(RegisterClass.T, n, v); }
    readTBit(n) { return this._addBitRead(RegisterClass.T, n); }
    writeTBit(n, v) { return this._addBitWrite(RegisterClass.T, n, v); }

    readC(n) { return this._addWordRead(RegisterClass.C, n); }
    writeC(n, v) { return this._addWordWrite(RegisterClass.C, n, v); }
    readCBit(n) { return this._addBitRead(RegisterClass.C, n); }
    writeCBit(n, v) { return this._addBitWrite(RegisterClass.C, n, v); }

    readHC(n) { return this._addWordRead(RegisterClass.HC, n); }
    writeHC(n, v) { return this._addWordWrite(RegisterClass.HC, n, v); }

    readSM(n) { return this._addBitRead(RegisterClass.SM, n); }
    readSR(n) { return this._addWordRead(RegisterClass.SR, n); }
}

module.exports = { DeltaBatchBuilder };
