'use strict';

/**
 * Live full read/write validation for the 'sx3' device-type profile
 * (also used verbatim by 'es3') against a real DVP-SX3 — every register
 * type, every access mode (word/bit), 16-bit and 32-bit, closing the
 * open items in src/delta/README.md's 'sx3' table (writeYBit round trip,
 * writeT/writeC/writeHC round trip, writeC32 round trip).
 *
 * Writable registers are written, read back to confirm, then restored to
 * their original value. Read-only registers (X, SM, SR) are only read.
 * Uses high, unlikely-to-be-wired-to-anything point numbers for Y to
 * minimize the chance of a real physical output twitching.
 *
 * Usage: node examples/delta-sx3-full-roundtrip.js <host>
 */

const { Device } = require('../src/device');

async function roundTrip(label, read, write, testValue) {
    const before = await read();
    await write(testValue);
    const after = await read();
    await write(before);
    const restored = await read();
    const ok = after === testValue && restored === before;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: before=${before} wrote=${testValue} readback=${after} restored=${restored}`);
    return ok;
}

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/delta-sx3-full-roundtrip.js <host>');
        process.exit(1);
    }

    const device = new Device(host, 'delta:sx3');
    await device.connect();
    const results = [];

    try {
        console.log('--- Read-only registers (X, SM, SR) ---');
        for (let n = 0; n < 3; n++) console.log(`X${n} = ${await device.readX(n)}`);
        for (let n = 0; n < 3; n++) console.log(`X${n}.0 (bit) = ${await device.readXBit(n * 16)}`);
        for (let n = 0; n < 3; n++) console.log(`SM${n} = ${await device.readSM(n)}`);
        for (let n = 0; n < 3; n++) console.log(`SR${n} = ${await device.readSR(n)}`);

        console.log('\n--- Write/read round trips (word mode) ---');
        results.push(await roundTrip('Y50', () => device.readY(50), (v) => device.writeY(50, v), 4321));
        results.push(await roundTrip('D50', () => device.readD(50), (v) => device.writeD(50, v), 6789));
        results.push(await roundTrip('M100', () => device.readM(100), (v) => device.writeM(100, v), true));
        results.push(await roundTrip('S20', () => device.readS(20), (v) => device.writeS(20, v), true));
        results.push(await roundTrip('T20', () => device.readT(20), (v) => device.writeT(20, v), 555));
        results.push(await roundTrip('C20', () => device.readC(20), (v) => device.writeC(20, v), 777));

        console.log('\n--- Bit mode ---');
        results.push(await roundTrip('Y50.3 (bit)', () => device.readYBit(50 * 16 + 3), (v) => device.writeYBit(50 * 16 + 3, v), true));

        console.log('\n--- Octal I/O labels (e.g. "Y62" octal = decimal 50) ---');
        results.push(await roundTrip('Y62 (octal label)', () => device.readYBitLabel('Y62'), (v) => device.writeYBitLabel('Y62', v), true));
        console.log(`X0 via label = ${await device.readXBitLabel('X0')}, X10 (octal, = decimal 8) via label = ${await device.readXBitLabel('X10')}`);

        console.log('\n--- 32-bit ---');
        results.push(await roundTrip('D32 @ D250/D251', () => device.readD32(250), (v) => device.writeD32(250, v), 0x12345678));
        results.push(await roundTrip('HC0', () => device.readHC(0), (v) => device.writeHC(0, v), 123456789));
        results.push(await roundTrip('C32 (readC32/writeC32 alias) @ HC1', () => device.readC32(1), (v) => device.writeC32(1, v), 987654321));

        const allOk = results.every(Boolean);
        console.log(`\n${allOk ? 'ALL ROUND TRIPS OK' : 'SOME ROUND TRIPS FAILED — see FAIL lines above'}`);
    } finally {
        await device.disconnect();
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
