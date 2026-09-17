'use strict';

/**
 * Full read/write coverage for the 'sx3' device-type profile (also used
 * verbatim by 'es3', see src/delta/device-types/es3.js) — every register
 * type it exposes, every access mode (word/bit), and both 16-bit and
 * 32-bit widths, using the mirror session (test/helpers/mirror-session.js)
 * so each assertion is a genuine write-then-read-back round trip, not just
 * an encoded-request check (those already exist in delta-registers_spec.js).
 */

const assert = require('assert');
const { DeltaDevice } = require('../src/delta/device');
const {
    RegisterClass,
    RegisterInstance,
    bitAttribute,
    registerPath,
    writeWordViaBits,
    readBit,
    writeWord,
    writeBit
} = require('../src/delta/registers');
const deviceTypes = require('../src/delta/device-types');
const { makeMirrorSession } = require('./helpers/mirror-session');

function sx3WithMirror() {
    const device = new DeltaDevice('127.0.0.1', 'sx3');
    const session = makeMirrorSession();
    device.scanner.session = session;
    return { device, session };
}

describe('sx3 profile — full read/write round trip, every register type and width', function () {
    describe('Y (output) — read/write, word mode', function () {
        it('round-trips positive and negative values', async function () {
            const { device } = sx3WithMirror();
            await device.writeY(10, 1234);
            assert.strictEqual(await device.readY(10), 1234);
            await device.writeY(10, -500);
            assert.strictEqual(await device.readY(10), -500);
        });

        it('keeps different Y numbers independent', async function () {
            const { device } = sx3WithMirror();
            await device.writeY(0, 111);
            await device.writeY(1, 222);
            assert.strictEqual(await device.readY(0), 111);
            assert.strictEqual(await device.readY(1), 222);
        });
    });

    describe('Y — bit mode', function () {
        it('round-trips writeYBit/readYBit at a raw bit-attribute number (Y3.5)', async function () {
            const { device } = sx3WithMirror();
            const attr = bitAttribute(3, 5);
            await device.writeYBit(attr, true);
            assert.strictEqual(await device.readYBit(attr), true);
            await device.writeYBit(attr, false);
            assert.strictEqual(await device.readYBit(attr), false);
        });
    });

    describe('X/Y — octal I/O labels (e.g. "X10" = decimal 8)', function () {
        it('writeYBitLabel/readYBitLabel round-trip using the octal label directly', async function () {
            const { device } = sx3WithMirror();
            await device.writeYBitLabel('Y10', true); // Y10 octal = index 8
            assert.strictEqual(await device.readYBitLabel('Y10'), true);
            assert.strictEqual(await device.readYBit(8), true); // same point, plain decimal index
        });

        it('readXBitLabel reflects a value seeded at the equivalent decimal index', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.X, RegisterInstance.Bit, 8); // X10 octal = 8
            session.seed(path, Buffer.from([0x01]));
            assert.strictEqual(await device.readXBitLabel('X10'), true);
        });

        it('covers the full X0-X377 octal range boundary (377 octal = 255 decimal)', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.X, RegisterInstance.Bit, 255);
            session.seed(path, Buffer.from([0x01]));
            assert.strictEqual(await device.readXBitLabel('X377'), true);
        });
    });

    describe('D (data register) — read/write, word mode', function () {
        it('round-trips D0-D10 independently, including negative values', async function () {
            const { device } = sx3WithMirror();
            const expected = {};
            for (let n = 0; n <= 10; n++) {
                expected[n] = n % 2 === 0 ? n * 100 : -(n * 100);
                await device.writeD(n, expected[n]);
            }
            for (let n = 0; n <= 10; n++) {
                assert.strictEqual(await device.readD(n), expected[n]);
            }
        });

        it('reaches the top of the real D0-D29999 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeD(29999, -1);
            assert.strictEqual(await device.readD(29999), -1);
        });
    });

    describe('D — 32-bit (D32, register-pairing Dn low / Dn+1 high)', function () {
        it('round-trips a positive 32-bit value and exposes the underlying words', async function () {
            const { device } = sx3WithMirror();
            await device.writeD32(200, 0x12345678);
            assert.strictEqual(await device.readD32(200), 0x12345678);
            assert.strictEqual(await device.readD(200), 0x5678);
            assert.strictEqual(await device.readD(201), 0x1234);
        });

        it('round-trips a negative 32-bit value', async function () {
            const { device } = sx3WithMirror();
            await device.writeD32(300, -123456789);
            assert.strictEqual(await device.readD32(300), -123456789);
        });
    });

    describe('M (marker/coil) — read/write, bit mode', function () {
        it('round-trips true/false for several M numbers independently', async function () {
            const { device } = sx3WithMirror();
            await device.writeM(0, true);
            await device.writeM(1, false);
            await device.writeM(511, true);
            assert.strictEqual(await device.readM(0), true);
            assert.strictEqual(await device.readM(1), false);
            assert.strictEqual(await device.readM(511), true);
        });

        it('reaches the top of the real M0-M8191 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeM(8191, true);
            assert.strictEqual(await device.readM(8191), true);
        });
    });

    describe('S (step) — read/write, bit mode', function () {
        it('round-trips true/false', async function () {
            const { device } = sx3WithMirror();
            await device.writeS(10, true);
            assert.strictEqual(await device.readS(10), true);
            await device.writeS(10, false);
            assert.strictEqual(await device.readS(10), false);
        });

        it('reaches the top of the real S0-S2047 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeS(2047, true);
            assert.strictEqual(await device.readS(2047), true);
        });
    });

    describe('T (timer, current value) — read/write, word mode (no 32-bit variant exists)', function () {
        it('round-trips a current-value write', async function () {
            const { device } = sx3WithMirror();
            await device.writeT(10, 999);
            assert.strictEqual(await device.readT(10), 999);
        });

        it('reaches the top of the real T0-T511 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeT(511, 1000);
            assert.strictEqual(await device.readT(511), 1000);
        });

        it('has no writeT32/readT32 — the device has no 32-bit timer range (docs/dvp-plc-device-ranges.md)', function () {
            const { device } = sx3WithMirror();
            assert.strictEqual(device.writeT32, undefined);
            assert.strictEqual(device.readT32, undefined);
        });
    });

    describe('C (counter, current value, 16-bit) — read/write, word mode', function () {
        it('round-trips a current-value write', async function () {
            const { device } = sx3WithMirror();
            await device.writeC(10, 888);
            assert.strictEqual(await device.readC(10), 888);
        });

        it('reaches the top of the real C0-C511 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeC(511, 2000);
            assert.strictEqual(await device.readC(511), 2000);
        });
    });

    describe('HC / C32 (high-speed counter, 32-bit) — read/write', function () {
        it('round-trips a 32-bit value via readHC/writeHC directly', async function () {
            const { device } = sx3WithMirror();
            await device.writeHC(0, 123456789);
            assert.strictEqual(await device.readHC(0), 123456789);
        });

        it('round-trips via the readC32/writeC32 alias, confirmed to be the same underlying object as HC', async function () {
            const { device } = sx3WithMirror();
            await device.writeC32(5, 987654321);
            assert.strictEqual(await device.readC32(5), 987654321);
            assert.strictEqual(await device.readHC(5), 987654321);
        });

        it('round-trips a negative 32-bit counter value', async function () {
            const { device } = sx3WithMirror();
            await device.writeHC(1, -2000000000);
            assert.strictEqual(await device.readHC(1), -2000000000);
        });

        it('reaches the top of the real HC0-HC255 range', async function () {
            const { device } = sx3WithMirror();
            await device.writeHC(255, 42);
            assert.strictEqual(await device.readHC(255), 42);
        });
    });

    describe('X (input) — read-only, word and bit mode', function () {
        it('readX reflects a value seeded directly into the device store (X cannot be written)', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.X, RegisterInstance.Word, 2);
            const data = Buffer.alloc(2);
            data.writeInt16LE(1234, 0);
            session.seed(path, data);
            assert.strictEqual(await device.readX(2), 1234);
        });

        it('readXBit reflects a seeded bit value', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.X, RegisterInstance.Bit, 5);
            session.seed(path, Buffer.from([0x01]));
            assert.strictEqual(await device.readXBit(5), true);
        });

        it('the sx3 profile exposes no writeX/writeXBit at all (X is read-only at the class level)', function () {
            const profile = deviceTypes.get('sx3');
            assert.strictEqual(profile.writeX, undefined);
            assert.strictEqual(profile.writeXBit, undefined);
        });

        it('writeWord/writeBit at the registers.js level reject X explicitly', async function () {
            await assert.rejects(() => writeWord({}, RegisterClass.X, 0, 1), /read-only/);
            await assert.rejects(() => writeBit({}, RegisterClass.X, 0, true), /read-only/);
        });
    });

    describe('SM (system marker) — read-only, bit mode', function () {
        it('readSM reflects a seeded value', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.SM, RegisterInstance.Bit, 0);
            session.seed(path, Buffer.from([0x01]));
            assert.strictEqual(await device.readSM(0), true);
        });

        it('writeBit rejects SM explicitly', async function () {
            await assert.rejects(() => writeBit({}, RegisterClass.SM, 0, true), /read-only/);
        });

        it('reaches the top of the real SM0-SM2047 range', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.SM, RegisterInstance.Bit, 2047);
            session.seed(path, Buffer.from([0x01]));
            assert.strictEqual(await device.readSM(2047), true);
        });
    });

    describe('SR (system register) — read-only, word mode via the word-only Instance=1 exception', function () {
        it('readSR reflects a seeded value at Instance 1 (not 2 — SR has no bit mode to share numbering with)', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.SR, RegisterInstance.Bit, 0);
            const data = Buffer.alloc(2);
            data.writeInt16LE(4321, 0);
            session.seed(path, data);
            assert.strictEqual(await device.readSR(0), 4321);
        });

        it('reaches the top of the real SR0-SR2047 range', async function () {
            const { device, session } = sx3WithMirror();
            const path = registerPath(RegisterClass.SR, RegisterInstance.Bit, 2047);
            const data = Buffer.alloc(2);
            data.writeInt16LE(-1, 0);
            session.seed(path, data);
            assert.strictEqual(await device.readSR(2047), -1);
        });
    });

    describe('writeWordViaBits — composes a full word from 16 sequential bit writes', function () {
        it('sets exactly the bits corresponding to the value, each independently readable back', async function () {
            const { session } = sx3WithMirror();
            const pattern = 0b1010000000000101;
            await writeWordViaBits(session, RegisterClass.D, 50, pattern);
            for (let bit = 0; bit < 16; bit++) {
                const expected = ((pattern >> bit) & 1) === 1;
                assert.strictEqual(await readBit(session, RegisterClass.D, 50, bit), expected, `bit ${bit}`);
            }
        });
    });
});

describe('es3 profile — registered separately, same implementation and coverage as sx3', function () {
    it('is registered and exposes the full method surface', function () {
        const profile = deviceTypes.get('es3');
        for (const name of ['readX', 'readXBit', 'readY', 'writeY', 'readYBit', 'writeYBit', 'readD', 'writeD', 'readM', 'writeM', 'readS', 'writeS', 'readT', 'writeT', 'readC', 'writeC', 'readHC', 'writeHC', 'readSM', 'readSR']) {
            assert.strictEqual(typeof profile[name], 'function', `es3 profile missing ${name}`);
        }
    });

    it('round-trips D and HC identically to sx3 (same underlying functions)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es3');
        const session = makeMirrorSession();
        device.scanner.session = session;

        await device.writeD(0, 4242);
        assert.strictEqual(await device.readD(0), 4242);
        await device.writeHC(0, 555555);
        assert.strictEqual(await device.readHC(0), 555555);
    });
});
