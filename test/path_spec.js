'use strict';

const assert = require('assert');
const { encodeLogicalSegment, encodeEPath, LogicalType } = require('../src/cip/path');

describe('CIP EPATH (padded logical segments)', function () {
    it('encodes 8-bit Class/Instance/Attribute segments matching well-known byte values', function () {
        assert.deepStrictEqual(encodeLogicalSegment(LogicalType.ClassId, 0x01), Buffer.from([0x20, 0x01]));
        assert.deepStrictEqual(encodeLogicalSegment(LogicalType.InstanceId, 0x01), Buffer.from([0x24, 0x01]));
        assert.deepStrictEqual(encodeLogicalSegment(LogicalType.AttributeId, 0x01), Buffer.from([0x30, 0x01]));
    });

    it('encodes 16-bit segments with a pad byte and little-endian value', function () {
        const seg = encodeLogicalSegment(LogicalType.ClassId, 0x1234);
        assert.deepStrictEqual(seg, Buffer.from([0x21, 0x00, 0x34, 0x12]));
    });

    it('encodes 32-bit segments when the value exceeds 16 bits', function () {
        const seg = encodeLogicalSegment(LogicalType.InstanceId, 0x12345678);
        // 0x20 | (InstanceId=1 << 2) | format=0x02 (32-bit) = 0x26
        assert.deepStrictEqual(seg, Buffer.from([0x26, 0x00, 0x78, 0x56, 0x34, 0x12]));
    });

    it('builds an even-length EPATH for Identity Object Instance 1 Attribute 1', function () {
        const path = encodeEPath({ classId: 0x01, instance: 1, attribute: 1 });
        assert.deepStrictEqual(path, Buffer.from([0x20, 0x01, 0x24, 0x01, 0x30, 0x01]));
        assert.strictEqual(path.length % 2, 0);
    });

    it('omits fields that are left undefined', function () {
        const path = encodeEPath({ classId: 0x01 });
        assert.deepStrictEqual(path, Buffer.from([0x20, 0x01]));
    });
});
