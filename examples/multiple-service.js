'use strict';

/**
 * ODVA CIP Multiple Service Packet (0x0A) Demo (§25)
 *
 * Demonstrates batching multiple CIP requests into a SINGLE network packet
 * targeting the Message Router Object (Class 0x02, Instance 1, Service 0x0A).
 *
 * Validated natively against Delta DVP-SX3 PLC (resolves 5+ requests in <10ms).
 * Includes automatic transparent fallback to individual requests if a remote
 * device lacks 0x0A support.
 *
 * Usage: node examples/multiple-service.js [host]
 */

const { Scanner } = require('../src/scanner');
const { CipClassCodes } = require('../src/constants');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    console.log(`=== ODVA CIP Multiple Service Packet (0x0A) with ${host} ===\n`);

    const scanner = new Scanner(host, { maxInFlight: 1 });
    await scanner.connect();
    console.log(`Connected. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    try {
        console.log('\n[1] Batch reading multiple attributes in ONE single round-trip:');
        const targets = [
            { classId: CipClassCodes.Identity, instance: 1, attribute: 1 },  // Vendor ID
            { classId: CipClassCodes.Identity, instance: 1, attribute: 2 },  // Device Type
            { classId: CipClassCodes.Identity, instance: 1, attribute: 3 },  // Product Code
            { classId: CipClassCodes.Identity, instance: 1, attribute: 7 },  // Product Name
            { classId: CipClassCodes.TcpIpInterface, instance: 1, attribute: 1 } // TCP/IP Status
        ];

        const start = Date.now();
        const results = await scanner.getAttributesMultiple(targets);
        const elapsed = Date.now() - start;

        console.log(`Batch request resolved in ${elapsed} ms:`);
        results.forEach((r, idx) => {
            if (r.error) {
                console.log(`  [${idx}] Class 0x${r.classId.toString(16)} Inst ${r.instance} Attr ${r.attribute}: ERROR 0x${r.generalStatus.toString(16)}`);
            } else {
                let displayVal = r.data.toString('hex');
                if (r.classId === CipClassCodes.Identity && r.attribute === 1) displayVal = `${r.data.readUInt16LE(0)} (Vendor ID)`;
                if (r.classId === CipClassCodes.Identity && r.attribute === 7) displayVal = `"${r.data.subarray(1, 1 + r.data[0]).toString('ascii')}" (Product Name)`;
                if (r.classId === CipClassCodes.TcpIpInterface && r.attribute === 1) displayVal = `${r.data.readUInt32LE(0)} (TCP/IP Status)`;
                console.log(`  [${idx}] Class 0x${r.classId.toString(16).padStart(2, '0')} Inst ${r.instance} Attr ${r.attribute}: ${displayVal}`);
            }
        });

    } finally {
        await scanner.disconnect();
        console.log('\nSession closed cleanly.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
