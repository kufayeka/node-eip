'use strict';

/**
 * Demonstrates the Delta DVP-ES2-E device profile ('delta:es2'):
 *   - D: 16-bit word read and write via Class 0x352 Instance 1 (Attribute = register number).
 *   - Y/M/S/T/C: Bit-mode read and write via vendor Register Objects (Class 0x351, 0x353..0x356).
 *   - X: Bit-mode read via Class 0x350 (Read-only).
 *   - Octal I/O labels: Y10, X10, etc.
 *   - Batch Operations: Native CIP Multiple Service Packet (0x0A) round-trips.
 *
 * Usage: node examples/delta-es2.js [host]
 */

const { Device } = require('../src/device');

async function main() {
    const host = process.argv[2] || '192.168.68.111';

    console.log(`Connecting to Delta ES2-E at ${host}...`);
    const device = new Device(host, 'delta:es2');
    await device.connect();
    console.log(`Connected! Device profile: ${device.profile.name}\n`);

    try {
        console.log('--- Direct Register Reading ---');
        for (let n = 0; n < 4; n++) {
            console.log(`X${n} = ${await device.readX(n)}`);
        }
        for (let n = 0; n < 4; n++) {
            console.log(`Y${n} = ${await device.readY(n)}`);
        }
        for (let n = 0; n < 4; n++) {
            console.log(`D${n} = ${await device.readD(n)}`);
        }

        console.log('\n--- D Register Word Read/Write (Instance 1) ---');
        const beforeD0 = await device.readD(0);
        await device.writeD(0, 1234);
        const writtenD0 = await device.readD(0);
        await device.writeD(0, beforeD0); // restore
        console.log(`D0: before=${beforeD0}, after write(1234)=${writtenD0}, restored=${await device.readD(0)}`);

        console.log('\n--- Bit Registers Read/Write Round-Trips ---');
        for (const [label, read, write, n] of [
            ['Y0', (i) => device.readYBit(i), (i, v) => device.writeYBit(i, v), 0],
            ['M10', (i) => device.readM(i), (i, v) => device.writeM(i, v), 10],
            ['S10', (i) => device.readS(i), (i, v) => device.writeS(i, v), 10],
            ['C10', (i) => device.readC(i), (i, v) => device.writeC(i, v), 10]
        ]) {
            const before = await read(n);
            await write(n, true);
            const after = await read(n);
            await write(n, before); // restore
            console.log(`${label}: before=${before}, active(true)=${after}, restored=${await read(n)}`);
        }

        console.log('\n--- Octal I/O Labels ---');
        const y10Before = await device.readYBitLabel('Y10');
        await device.writeYBitLabel('Y10', true);
        const y10Active = await device.readYBitLabel('Y10');
        await device.writeYBitLabel('Y10', y10Before);
        console.log(`Y10 (octal 10 = index 8): before=${y10Before}, active=${y10Active}, restored=${await device.readYBitLabel('Y10')}`);

        console.log('\n--- Schema-Driven Batch Operations (CIP 0x0A) ---');
        console.log('Sending batch write to Y0..Y3 and D0..D3 simultaneously in 1 network packet...');
        const batchResults = await device.batch((b) => {
            b.writeYBit(0, true);
            b.writeYBit(1, false);
            b.writeD(0, 500);
            b.writeD(1, 1000);
            b.readYBit(0);
            b.readD(0);
        });
        console.log('Batch results:', batchResults);

        // Clean up
        await device.batch((b) => {
            b.writeYBit(0, false);
            b.writeD(0, beforeD0);
            b.writeD(1, 0);
        });

        console.log('\nES2-E example completed successfully!');
    } finally {
        await device.close();
    }
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
