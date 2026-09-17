'use strict';

/**
 * es2 profile — D/T/C addressing per the DVP-SE/ES2-E/DVP26SE manual's own
 * Appendix B.5.2 (docs/delta-cip-object-reference.md), corrected 2026-09
 * from the earlier Assembly-window-based D read + "writeD unsupported"
 * implementation. These are encoding/round-trip tests against a fake
 * session (test/helpers/mirror-session.js) — NOT yet confirmed against
 * real hardware, since the device was offline at the time this was
 * written. See src/delta/README.md Domain J for live-validation status.
 */

const assert = require('assert');
const { DeltaDevice } = require('../src/delta/device');
const { RegisterClass, RegisterInstance, registerPath } = require('../src/delta/registers');
const { makeMirrorSession } = require('./helpers/mirror-session');

function es2WithMirror() {
    const device = new DeltaDevice('127.0.0.1', 'es2');
    const session = makeMirrorSession();
    device.scanner.session = session;
    return { device, session };
}

describe('es2 profile — D Register (0x352, Instance 1, flat Attribute = D number)', function () {
    it('round-trips D0 and D9999 (the documented ES2-E range boundary)', async function () {
        const { device } = es2WithMirror();
        await device.writeD(0, 10);
        assert.strictEqual(await device.readD(0), 10);
        await device.writeD(9999, -1);
        assert.strictEqual(await device.readD(9999), -1);
    });

    it('D1600 is a real, independent register — not "bit 0 of D100" (the old, incorrect formula)', async function () {
        const { device } = es2WithMirror();
        await device.writeD(1600, 4242);
        await device.writeD(100, 7);
        assert.strictEqual(await device.readD(1600), 4242);
        assert.strictEqual(await device.readD(100), 7);
    });

    it('writeD sends a 2-byte INT payload to Instance 1 (not Instance 2)', async function () {
        const { device, session } = es2WithMirror();
        await device.writeD(3, 1234);
        const key = registerPath(RegisterClass.D, RegisterInstance.Bit, 3).toString('hex');
        assert.deepStrictEqual(session.store.get(key), Buffer.from([0xd2, 0x04]));
    });
});

describe('es2 profile — T/C numeric register value (Instance 2, previously assumed absent)', function () {
    it('readT/writeT round-trip a 16-bit current value', async function () {
        const { device } = es2WithMirror();
        await device.writeT(10, 999);
        assert.strictEqual(await device.readT(10), 999);
    });

    it('readC/writeC round-trip a 16-bit current value below the 32-bit boundary (C199)', async function () {
        const { device } = es2WithMirror();
        await device.writeC(199, 888);
        assert.strictEqual(await device.readC(199), 888);
    });

    it('readC/writeC switch to a 4-byte DINT payload at the documented 32-bit boundary (C200+)', async function () {
        const { device, session } = es2WithMirror();
        await device.writeC(200, 100000);
        assert.strictEqual(await device.readC(200), 100000);
        const key = registerPath(RegisterClass.C, RegisterInstance.Word, 200).toString('hex');
        assert.strictEqual(session.store.get(key).length, 4);
    });

    it('readC32/writeC32 on DeltaDevice are the same C-register mechanism, no separate HC class', async function () {
        const { device } = es2WithMirror();
        await device.writeC32(254, 123456789);
        assert.strictEqual(await device.readC32(254), 123456789);
    });

    it('readTBit/writeTBit and readCBit/writeCBit still address the separate contact-bit instance', async function () {
        const { device, session } = es2WithMirror();
        await device.writeTBit(10, true);
        assert.strictEqual(await device.readTBit(10), true);
        const key = registerPath(RegisterClass.T, RegisterInstance.Bit, 10).toString('hex');
        assert.ok(session.store.has(key));
    });
});

describe('es2 profile — still-unsupported classes (confirmed absent via a full class sweep)', function () {
    it('readHC/writeHC/readSM/readSR reject clearly', async function () {
        const profile = require('../src/delta/device-types').get('es2');
        await assert.rejects(() => profile.readHC({}, 0), /not supported for device type "es2"/);
        await assert.rejects(() => profile.writeHC({}, 0, 1), /not supported for device type "es2"/);
        await assert.rejects(() => profile.readSM({}, 0), /not supported for device type "es2"/);
        await assert.rejects(() => profile.readSR({}, 0), /not supported for device type "es2"/);
    });
});
