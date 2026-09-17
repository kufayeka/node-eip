'use strict';

const assert = require('assert');
const { RegisterClass, RegisterInstance, bitAttribute, registerPath, octalLabelToIndex, indexToOctalLabel } = require('../src/delta/registers');

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

    it('encodes M8191 (top of the real M0-M8191 range, docs/dvp-plc-device-ranges.md) with a 16-bit attribute segment', function () {
        const path = registerPath(RegisterClass.M, RegisterInstance.Bit, 8191);
        // Attribute 8191 (0x1FFF) exceeds 0xFF, so the Attribute segment needs the 16-bit padded form.
        assert.deepStrictEqual(path, Buffer.from([0x21, 0x00, 0x53, 0x03, 0x24, 0x01, 0x31, 0x00, 0xff, 0x1f]));
    });

    it('encodes D29999 (top of the real D0-D29999 range) correctly', function () {
        const path = registerPath(RegisterClass.D, RegisterInstance.Word, 29999);
        assert.deepStrictEqual(path, Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x02, 0x31, 0x00, 0x2f, 0x75]));
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

describe('Octal X/Y I/O label conversion (docs/dvp-plc-device-ranges.md, AS-series/SX3 section)', function () {
    it('octalLabelToIndex() parses a label with a letter prefix as base-8', function () {
        assert.strictEqual(octalLabelToIndex('X10'), 8);
        assert.strictEqual(octalLabelToIndex('X0'), 0);
        assert.strictEqual(octalLabelToIndex('X7'), 7);
        assert.strictEqual(octalLabelToIndex('X377'), 255);
        assert.strictEqual(octalLabelToIndex('Y20'), 16);
    });

    it('octalLabelToIndex() also accepts a bare digit string with no letter prefix', function () {
        assert.strictEqual(octalLabelToIndex('377'), 255);
    });

    it('octalLabelToIndex() rejects digits 8 and 9 (not valid octal)', function () {
        assert.throws(() => octalLabelToIndex('X8'), RangeError);
        assert.throws(() => octalLabelToIndex('X19'), RangeError);
    });

    it('indexToOctalLabel() is the exact inverse of octalLabelToIndex()', function () {
        for (const label of ['0', '7', '10', '17', '20', '377']) {
            assert.strictEqual(indexToOctalLabel(octalLabelToIndex(label)), label);
        }
    });

    it('indexToOctalLabel() rejects a negative or non-integer index', function () {
        assert.throws(() => indexToOctalLabel(-1), RangeError);
        assert.throws(() => indexToOctalLabel(1.5), RangeError);
    });
});
