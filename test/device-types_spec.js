'use strict';

const assert = require('assert');
const deviceTypes = require('../src/delta/device-types');

describe('Delta device-type registry', function () {
    it('lists the registered types, including sx3, es3 and es2', function () {
        const types = deviceTypes.list();
        assert.ok(types.includes('sx3'));
        assert.ok(types.includes('es3'));
        assert.ok(types.includes('es2'));
    });

    it('get() returns the sx3 profile with every method present', function () {
        const profile = deviceTypes.get('sx3');
        for (const name of ['readX', 'readY', 'writeY', 'readD', 'writeD', 'readM', 'writeM', 'readS', 'writeS', 'readT', 'writeT', 'readC', 'writeC', 'readHC', 'writeHC', 'readSM', 'readSR']) {
            assert.strictEqual(typeof profile[name], 'function', `sx3 profile missing ${name}`);
        }
    });

    it('get() returns the es2 profile with every method present', function () {
        const profile = deviceTypes.get('es2');
        for (const name of ['readX', 'readY', 'writeY', 'readD', 'writeD', 'readM', 'writeM', 'readS', 'writeS', 'readT', 'writeT', 'readC', 'writeC', 'readHC', 'writeHC', 'readSM', 'readSR']) {
            assert.strictEqual(typeof profile[name], 'function', `es2 profile missing ${name}`);
        }
    });

    it('es2 profile: writeD (unresolved) and readHC/readSM/readSR (class does not exist) still reject clearly', async function () {
        const profile = deviceTypes.get('es2');
        await assert.rejects(() => profile.writeD(/* session */ {}, 0, 1), /not supported for device type "es2"/);
        await assert.rejects(() => profile.readHC(/* session */ {}, 0), /not supported for device type "es2"/);
        await assert.rejects(() => profile.readSM(/* session */ {}, 0), /not supported for device type "es2"/);
        await assert.rejects(() => profile.readSR(/* session */ {}, 0), /not supported for device type "es2"/);
    });

    it('get() throws a helpful error for an unknown device type', function () {
        assert.throws(() => deviceTypes.get('nonexistent-plc'), /Unknown Delta device type "nonexistent-plc"/);
    });
});
