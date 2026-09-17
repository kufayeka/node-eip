'use strict';

const assert = require('assert');
const deviceTypes = require('../src/delta/device-types');

describe('Delta device-type registry', function () {
    it('lists the registered types, including sx3 and es2', function () {
        const types = deviceTypes.list();
        assert.ok(types.includes('sx3'));
        assert.ok(types.includes('es2'));
    });

    it('get() returns the sx3 profile with every method present', function () {
        const profile = deviceTypes.get('sx3');
        for (const name of ['readX', 'readY', 'writeY', 'readD', 'writeD', 'readM', 'writeM', 'readS', 'writeS', 'readT', 'writeT', 'readC', 'writeC', 'readHC', 'writeHC', 'readSM', 'readSR']) {
            assert.strictEqual(typeof profile[name], 'function', `sx3 profile missing ${name}`);
        }
    });

    it('get() returns the es2 profile, with unconfirmed methods present but throwing', async function () {
        const profile = deviceTypes.get('es2');
        assert.strictEqual(typeof profile.readD, 'function');
        await assert.rejects(() => profile.readX(/* session */ {}, 0), /not supported for device type "es2"/);
    });

    it('get() throws a helpful error for an unknown device type', function () {
        assert.throws(() => deviceTypes.get('nonexistent-plc'), /Unknown Delta device type "nonexistent-plc"/);
    });
});
