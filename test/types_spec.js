'use strict';

const assert = require('assert');
const {
    CipDataTypeCode,
    CIP_DATA_TYPES,
    encodeType,
    decodeType,
    readBit,
    writeBit,
    resolveBitMember,
    encodeShortString,
    decodeShortString,
    encodeCipString,
    decodeCipString
} = require('../src/cip/types');

describe('CIP Data Type System (§28, §29, §30, §31)', () => {
    describe('Elementary Numeric Data Types', () => {
        it('encodes and decodes BOOL correctly', () => {
            const bufTrue = encodeType(CipDataTypeCode.BOOL, true);
            assert.deepStrictEqual(bufTrue, Buffer.from([0x01]));
            assert.strictEqual(decodeType(CipDataTypeCode.BOOL, bufTrue).value, true);

            const bufFalse = encodeType(CipDataTypeCode.BOOL, false);
            assert.deepStrictEqual(bufFalse, Buffer.from([0x00]));
            assert.strictEqual(decodeType(CipDataTypeCode.BOOL, bufFalse).value, false);
        });

        it('encodes and decodes SINT (-128 to 127)', () => {
            const bufPos = encodeType(CipDataTypeCode.SINT, 42);
            assert.strictEqual(decodeType(CipDataTypeCode.SINT, bufPos).value, 42);

            const bufNeg = encodeType(CipDataTypeCode.SINT, -120);
            assert.strictEqual(decodeType(CipDataTypeCode.SINT, bufNeg).value, -120);
        });

        it('encodes and decodes INT (-32768 to 32767) little-endian', () => {
            const buf = encodeType(CipDataTypeCode.INT, -12345);
            assert.strictEqual(buf.length, 2);
            assert.strictEqual(buf.readInt16LE(0), -12345);
            assert.strictEqual(decodeType(CipDataTypeCode.INT, buf).value, -12345);
        });

        it('encodes and decodes DINT (-2147483648 to 2147483647)', () => {
            const val = -987654321;
            const buf = encodeType(CipDataTypeCode.DINT, val);
            assert.strictEqual(buf.length, 4);
            assert.strictEqual(buf.readInt32LE(0), val);
            assert.strictEqual(decodeType(CipDataTypeCode.DINT, buf).value, val);
        });

        it('encodes and decodes LINT (64-bit signed BigInt)', () => {
            const val = -1234567890123456n;
            const buf = encodeType(CipDataTypeCode.LINT, val);
            assert.strictEqual(buf.length, 8);
            assert.strictEqual(decodeType(CipDataTypeCode.LINT, buf).value, val);
        });

        it('encodes and decodes USINT (0 to 255)', () => {
            const buf = encodeType(CipDataTypeCode.USINT, 250);
            assert.strictEqual(buf[0], 250);
            assert.strictEqual(decodeType(CipDataTypeCode.USINT, buf).value, 250);
        });

        it('encodes and decodes UINT (0 to 65535)', () => {
            const buf = encodeType(CipDataTypeCode.UINT, 54321);
            assert.strictEqual(buf.length, 2);
            assert.strictEqual(decodeType(CipDataTypeCode.UINT, buf).value, 54321);
        });

        it('encodes and decodes UDINT (0 to 4294967295)', () => {
            const buf = encodeType(CipDataTypeCode.UDINT, 3000000000);
            assert.strictEqual(buf.length, 4);
            assert.strictEqual(decodeType(CipDataTypeCode.UDINT, buf).value, 3000000000);
        });

        it('encodes and decodes ULINT (64-bit unsigned BigInt)', () => {
            const val = 18000000000000000000n;
            const buf = encodeType(CipDataTypeCode.ULINT, val);
            assert.strictEqual(buf.length, 8);
            assert.strictEqual(decodeType(CipDataTypeCode.ULINT, buf).value, val);
        });

        it('encodes and decodes REAL (IEEE 754 32-bit float)', () => {
            const val = 123.45600128173828; // 32-bit precision float
            const buf = encodeType(CipDataTypeCode.REAL, val);
            assert.strictEqual(buf.length, 4);
            const decoded = decodeType(CipDataTypeCode.REAL, buf).value;
            assert.ok(Math.abs(decoded - 123.456) < 0.001);
        });

        it('encodes and decodes LREAL (IEEE 754 64-bit double)', () => {
            const val = 1234567.890123456;
            const buf = encodeType(CipDataTypeCode.LREAL, val);
            assert.strictEqual(buf.length, 8);
            assert.strictEqual(decodeType(CipDataTypeCode.LREAL, buf).value, val);
        });

        it('encodes and decodes bit-string types BYTE, WORD, DWORD, LWORD', () => {
            assert.strictEqual(decodeType(CipDataTypeCode.BYTE, encodeType(CipDataTypeCode.BYTE, 0xFE)).value, 0xFE);
            assert.strictEqual(decodeType(CipDataTypeCode.WORD, encodeType(CipDataTypeCode.WORD, 0xBEEF)).value, 0xBEEF);
            assert.strictEqual(decodeType(CipDataTypeCode.DWORD, encodeType(CipDataTypeCode.DWORD, 0xCAFEBABE)).value, 0xCAFEBABE);
            assert.strictEqual(decodeType(CipDataTypeCode.LWORD, encodeType(CipDataTypeCode.LWORD, 0x1234567890ABCDEFn)).value, 0x1234567890ABCDEFn);
        });

        it('throws on buffer truncation during decodeType', () => {
            const truncated = Buffer.alloc(2); // DINT needs 4
            assert.throws(() => decodeType(CipDataTypeCode.DINT, truncated, 0), RangeError);
        });
    });

    describe('Bit-Level & Packed Boolean Access (§30)', () => {
        it('reads and writes individual bits accurately', () => {
            const buf = Buffer.alloc(2); // 16 bits
            writeBit(buf, 0, 0, true);
            writeBit(buf, 0, 7, true);
            writeBit(buf, 1, 3, true);

            assert.strictEqual(buf[0], 0b10000001);
            assert.strictEqual(buf[1], 0b00001000);

            assert.strictEqual(readBit(buf, 0, 0), true);
            assert.strictEqual(readBit(buf, 0, 1), false);
            assert.strictEqual(readBit(buf, 0, 7), true);
            assert.strictEqual(readBit(buf, 1, 3), true);
            assert.strictEqual(readBit(buf, 1, 2), false);

            writeBit(buf, 0, 0, false);
            assert.strictEqual(readBit(buf, 0, 0), false);
            assert.strictEqual(buf[0], 0b10000000);
        });

        it('resolves packed bit members by offset or mask', () => {
            const buf = Buffer.from([0b00100101]);
            // Bit 0 = 1, Bit 2 = 1, Bit 5 = 1
            assert.strictEqual(resolveBitMember(buf, { byteOffset: 0, bitOffset: 0 }), true);
            assert.strictEqual(resolveBitMember(buf, { byteOffset: 0, bitOffset: 1 }), false);
            assert.strictEqual(resolveBitMember(buf, { byteOffset: 0, bitOffset: 2 }), true);

            // With mask
            assert.strictEqual(resolveBitMember(buf, { byteOffset: 0, mask: 0x05 }), true); // 0x01 | 0x04 = 0x05
            assert.strictEqual(resolveBitMember(buf, { byteOffset: 0, mask: 0x03 }), false);
        });

        it('validates bit offset range', () => {
            const buf = Buffer.alloc(1);
            assert.throws(() => readBit(buf, 0, 8), RangeError);
            assert.throws(() => writeBit(buf, 0, -1, true), RangeError);
        });
    });

    describe('CIP String Handling (§31)', () => {
        it('encodes and decodes SHORT_STRING (UINT8 length + ASCII)', () => {
            const str = 'DVP-SX3';
            const encoded = encodeShortString(str);
            assert.strictEqual(encoded.length, 1 + 7);
            assert.strictEqual(encoded[0], 7);
            assert.strictEqual(encoded.subarray(1).toString('ascii'), 'DVP-SX3');

            const decoded = decodeShortString(encoded, 0);
            assert.strictEqual(decoded.value, 'DVP-SX3');
            assert.strictEqual(decoded.bytesRead, 8);
        });

        it('encodes and decodes standard CIP STRING (UINT16 length + ASCII)', () => {
            const str = 'EtherNet/IP CIP Adaptation';
            const encoded = encodeCipString(str);
            assert.strictEqual(encoded.length, 2 + str.length);
            assert.strictEqual(encoded.readUInt16LE(0), str.length);

            const decoded = decodeCipString(encoded, 0);
            assert.strictEqual(decoded.value, str);
            assert.strictEqual(decoded.bytesRead, 2 + str.length);
        });

        it('integrates with encodeType/decodeType for string types', () => {
            const shortBuf = encodeType(CipDataTypeCode.SHORT_STRING, 'TestShort');
            assert.strictEqual(decodeType(CipDataTypeCode.SHORT_STRING, shortBuf).value, 'TestShort');

            const cipBuf = encodeType(CipDataTypeCode.STRING, 'TestCip');
            assert.strictEqual(decodeType(CipDataTypeCode.STRING, cipBuf).value, 'TestCip');
        });
    });
});
