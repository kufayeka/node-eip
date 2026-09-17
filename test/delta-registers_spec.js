'use strict';

const assert = require('assert');
const { RegisterClass, RegisterInstance, bitAttribute, registerPath } = require('../src/delta/registers');

describe('Delta vendor-specific register addressing', function () {
    it('encodes D100 (word mode) as Class 0x352 Instance 2 Attribute 100', function () {
        const path = registerPath(RegisterClass.D, RegisterInstance.Word, 100);
        // 0x20 0x352(16-bit->0x21 0x00 0x52 0x03) 0x24 0x02 0x30 0x64(100<=0xFF, 8-bit)
        assert.deepStrictEqual(path, Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x02, 0x30, 0x64]));
    });

    it('encodes M50 (bit-only) as Class 0x353 Instance 1 Attribute 50', function () {
        const path = registerPath(RegisterClass.M, RegisterInstance.Bit, 50);
        assert.deepStrictEqual(path, Buffer.from([0x21, 0x00, 0x53, 0x03, 0x24, 0x01, 0x30, 0x32]));
    });

    it('flattens word+bit into a sequential bit attribute (word*16 + bit)', function () {
        assert.strictEqual(bitAttribute(0, 0), 0);
        assert.strictEqual(bitAttribute(0, 1), 1);
        assert.strictEqual(bitAttribute(1, 0), 16);
        assert.strictEqual(bitAttribute(100, 5), 1605);
    });

    it('rejects an out-of-range bit index', function () {
        assert.throws(() => bitAttribute(0, 16), RangeError);
        assert.throws(() => bitAttribute(0, -1), RangeError);
    });
});
