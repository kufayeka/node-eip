'use strict';

const assert = require('assert');
const { DeviceBuilder } = require('../src/device/builder');
const { EdsFile } = require('../src/cip/eds');

describe('BOOL Parameter EDS numeric metadata', () => {
    it('normalizes BOOL min/max/default to numeric 0..1 and keeps runtime boolean values usable', () => {
        const b = new DeviceBuilder({ vendorId: 799, productName: 'BOOL Test' });

        b.addParam({
            code: '02-00',
            name: 'BoolParam1',
            dataType: 'BOOL',
            min: false,
            max: true,
            default: false,
            access: 'rw'
        });

        b.addParam({
            code: '02-01',
            name: 'BoolParam2',
            dataType: 'BOOL',
            default: true,
            access: 'rw'
        });

        const p1 = b.getParam('02-00');
        const p2 = b.getParam('02-01');

        assert.strictEqual(p1.min, 0);
        assert.strictEqual(p1.max, 1);
        assert.strictEqual(p1.default, 0);
        assert.strictEqual(p1.value, 0);

        assert.strictEqual(p2.min, 0);
        assert.strictEqual(p2.max, 1);
        assert.strictEqual(p2.default, 1);
        assert.strictEqual(p2.value, 1);

        const eds = b.generateEds();
        assert.ok(eds.includes('"02-00 BoolParam1"'));
        assert.ok(eds.includes('"02-01 BoolParam2"'));
        assert.ok(!eds.includes(',false,'));
        assert.ok(!eds.includes(',true,'));

        const parsed = EdsFile.parse(eds);
        const e1 = parsed.params.get(1);
        const e2 = parsed.params.get(2);

        assert.strictEqual(e1.dataType, 0x00C1);
        assert.strictEqual(e1.dataSize, 1);
        assert.strictEqual(e1.min, 0);
        assert.strictEqual(e1.max, 1);
        assert.strictEqual(e1.default, 0);

        assert.strictEqual(e2.dataType, 0x00C1);
        assert.strictEqual(e2.dataSize, 1);
        assert.strictEqual(e2.min, 0);
        assert.strictEqual(e2.max, 1);
        assert.strictEqual(e2.default, 1);
    });

    it('also emits numeric 0/1 for BOOL symbolic-tag synthetic Params', () => {
        const b = new DeviceBuilder({ vendorId: 799, productName: 'BOOL Tag Test' });
        b.addTag('FlagOff', 'BOOL', false);
        b.addTag('FlagOn', 'BOOL', true);

        const eds = b.generateEds();

        assert.ok(/"FlagOff"\s*,\n\s*""/.test(eds));
        assert.ok(/"FlagOn"\s*,\n\s*""/.test(eds));
        assert.ok(!eds.includes(',false,'));
        assert.ok(!eds.includes(',true,'));

        const parsed = EdsFile.parse(eds);
        assert.strictEqual(parsed.params.get(1).default, 0);
        assert.strictEqual(parsed.params.get(2).default, 1);
        assert.strictEqual(parsed.params.get(1).min, 0);
        assert.strictEqual(parsed.params.get(1).max, 1);
    });
});
