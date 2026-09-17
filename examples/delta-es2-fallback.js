'use strict';

/**
 * Demonstrates the full 'es2' device-type profile (src/delta/device-types/es2.js)
 * — read for X/Y/M/D and read+write round trips for Y/M/S/T/C, all
 * confirmed live against a real DVP32ES2-E (README Domain J):
 *   - X/Y/M/S/T/C: real bit-mode read/write via Delta's vendor Register
 *     Objects (Class 0x350-0x356) — write confirmed by watching the
 *     physical device's own live monitor turn the bit on.
 *   - D: read-only, via the Assembly-window mirror (Instance 101) — its
 *     vendor Register Object (Class 0x352) exists and answers requests,
 *     but is a separate, disconnected scratch store, not the real D-table.
 *     Writing D is not currently possible via CIP on this device.
 *
 * This example writes to M/Y/S/T/C and restores them afterward — safe to
 * run against a non-production device.
 *
 * Usage: node examples/delta-es2-fallback.js <host>
 */

const { DeltaDevice } = require('../src/delta/device');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/delta-es2-fallback.js <host>');
        process.exit(1);
    }

    const device = new DeltaDevice(host, 'es2');
    await device.connect();

    try {
        console.log('--- Read (X/Y/M read-only view, D via Assembly mirror) ---');
        for (let n = 0; n < 4; n++) console.log(`X${n} = ${await device.readX(n)}`);
        for (let n = 0; n < 4; n++) console.log(`Y${n} = ${await device.readY(n)}`);
        for (let n = 0; n < 4; n++) console.log(`M${n} = ${await device.readM(n)}`);
        for (let n = 0; n < 4; n++) console.log(`D${n} = ${await device.readD(n)}`);

        console.log('\n--- Write round trip (M50, Y10, S10, T10, C10) ---');
        for (const [label, read, write, n] of [
            ['M50', device.readM.bind(device), device.writeM.bind(device), 50],
            ['Y10', device.readY.bind(device), device.writeY.bind(device), 10],
            ['S10', device.readS.bind(device), device.writeS.bind(device), 10],
            ['T10', device.readT.bind(device), device.writeT.bind(device), 10],
            ['C10', device.readC.bind(device), device.writeC.bind(device), 10]
        ]) {
            const before = await read(n);
            await write(n, true);
            const after = await read(n);
            await write(n, before); // restore
            console.log(`${label}: before=${before} after(true)=${after} restored=${await read(n)}`);
        }

        console.log('\n--- writeD (expected to fail clearly — no confirmed write path) ---');
        try {
            await device.writeD(0, 123);
            console.log('UNEXPECTED: writeD succeeded');
        } catch (err) {
            console.log(`writeD correctly rejected: ${err.message}`);
        }
    } finally {
        await device.disconnect();
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
