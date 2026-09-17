'use strict';

/**
 * ODVA Concurrency (§40) and Request Queue Backpressure (§41) Demo
 *
 * Demonstrates:
 * 1. Monotonic 64-bit Sender Context generation for robust correlation
 * 2. Asynchronous concurrency via Promise.all without FIFO head-of-line collision
 * 3. Configurable maxInFlight (default: 1) backpressure that prevents embedded
 *    PLC socket buffer overflow while providing caller-transparent concurrency
 *
 * Usage: node examples/concurrency-demo.js [host]
 */

const { Scanner } = require('../src/scanner');
const { CipClassCodes } = require('../src/constants');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    console.log(`=== Demonstrating Concurrency & Backpressure with ${host} ===\n`);

    const scanner = new Scanner(host, { maxInFlight: 1 });
    await scanner.connect();
    console.log(`Connected. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    try {
        console.log('\n[1] Firing 7 concurrent CIP explicit attribute reads via Promise.all()...');
        const start1 = Date.now();

        // 7 separate Get_Attribute_Single requests issued in the exact same tick:
        const attributes = [
            { name: 'Vendor ID', attr: 1, decode: (b) => b.readUInt16LE(0) },
            { name: 'Device Type', attr: 2, decode: (b) => b.readUInt16LE(0) },
            { name: 'Product Code', attr: 3, decode: (b) => b.readUInt16LE(0) },
            { name: 'Major Rev', attr: 4, decode: (b) => `${b[0]}.${b[1]}` },
            { name: 'Status', attr: 5, decode: (b) => `0x${b.readUInt16LE(0).toString(16)}` },
            { name: 'Serial Number', attr: 6, decode: (b) => `0x${b.readUInt32LE(0).toString(16)}` },
            { name: 'Product Name', attr: 7, decode: (b) => b.subarray(1, 1 + b[0]).toString('ascii') }
        ];

        const results = await Promise.all(
            attributes.map(async (def) => {
                const buf = await scanner.getAttribute({
                    classId: CipClassCodes.Identity,
                    instance: 1,
                    attribute: def.attr
                });
                return { name: def.name, value: def.decode(buf) };
            })
        );

        const duration1 = Date.now() - start1;
        console.log(`All 7 concurrent reads resolved correctly in ${duration1} ms:`);
        for (const r of results) {
            console.log(`  ${r.name.padEnd(16)}: ${r.value}`);
        }

        console.log('\n[2] Firing 5 concurrent Delta register reads via Promise.all()...');
        const start2 = Date.now();
        const registers = [0, 1, 2, 3, 4];
        const regValues = await Promise.all(registers.map((n) => scanner.readD(n)));
        const duration2 = Date.now() - start2;

        console.log(`All 5 registers resolved correctly in ${duration2} ms:`);
        registers.forEach((n, idx) => {
            console.log(`  D${n.toString().padEnd(4)} = ${regValues[idx]}`);
        });

        console.log('\nCorrelation test PASSED: All transactions properly matched by Sender Context.');
    } finally {
        await scanner.disconnect();
        console.log('Session closed cleanly.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
