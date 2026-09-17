'use strict';

const assert = require('assert');
const { encodeEPath, decodeEPath, encodeAssemblyConnectionPath, LogicalType, decodeLogicalSegment } = require('../src/cip/path');

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
});
