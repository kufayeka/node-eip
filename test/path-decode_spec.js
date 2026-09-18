'use strict';

const assert = require('assert');
const { encodeEPath, decodeEPath, encodeAssemblyConnectionPath, LogicalType, decodeLogicalSegment, encodeElectronicKeySegment, decodeElectronicKeySegment } = require('../src/cip/path');

describe('CIP EPATH decoding (server-side)', function () {
    it('round-trips a simple Class/Instance/Attribute path through encode+decode', function () {
        const path = encodeEPath({ classId: 0x04, instance: 100, attribute: 3 });
        assert.deepStrictEqual(decodeEPath(path), { classId: 0x04, instance: 100, attribute: 3 });
    });

    it('round-trips 16-bit segments (values > 0xFF)', function () {
        const path = encodeEPath({ classId: 0x352, instance: 2, attribute: 12345 });
        assert.deepStrictEqual(decodeEPath(path), { classId: 0x352, instance: 2, attribute: 12345 });
    });

    it('collects multiple Connection Point segments into an array, in order', function () {
        const path = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });
        assert.deepStrictEqual(decodeEPath(path), { classId: 0x04, instance: 0x80, connectionPoints: [0x64, 0x65] });
    });

    it('decodeLogicalSegment rejects a non-logical-segment byte', function () {
        assert.throws(() => decodeLogicalSegment(Buffer.from([0x01, 0x00]), 0), /not a padded Logical Segment/);
    });

    it('decodeEPath throws on a truncated 16-bit segment', function () {
        assert.throws(() => decodeEPath(Buffer.from([0x21, 0x00])), RangeError);
    });

    describe('Electronic Key Segment (CIP Vol 1, C-1.4.5.2) — 10 bytes, not the generic 2-byte Logical Segment shape', function () {
        it('round-trips every field, including the Compatibility bit', function () {
            const encoded = encodeElectronicKeySegment({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 32, compatibility: true });
            assert.strictEqual(encoded.length, 10);
            assert.strictEqual(encoded[0], 0x34);
            const decoded = decodeElectronicKeySegment(encoded, 0);
            assert.deepStrictEqual(decoded, { keyFormat: 4, vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 32, compatibility: true, bytesConsumed: 10 });
        });

        it('a full connection path with a leading Electronic Key decodes without desyncing the segments after it (the original Path Segment Error bug)', function () {
            const key = encodeElectronicKeySegment({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 });
            const rest = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 100, t2oInstance: 101 });
            const decoded = decodeEPath(Buffer.concat([key, rest]));
            assert.strictEqual(decoded.electronicKey.vendorId, 799);
            assert.deepStrictEqual(decoded.connectionPoints, [100, 101]);
            assert.strictEqual(decoded.instance, 0x80);
        });

        it('matches the documented byte-for-byte example (Vendor 1, Device Type 12, Product Code 184, Major 4, Minor 1)', function () {
            const encoded = encodeElectronicKeySegment({ vendorId: 1, deviceType: 12, productCode: 184, majorRevision: 4, minorRevision: 1 });
            assert.deepStrictEqual(encoded, Buffer.from([0x34, 0x04, 0x01, 0x00, 0x0c, 0x00, 0xb8, 0x00, 0x04, 0x01]));
        });
    });
});
