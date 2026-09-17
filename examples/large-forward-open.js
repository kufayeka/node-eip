'use strict';

/**
 * Large Forward Open (0x5B) Example (§12, §13).
 *
 * Demonstrates establishing a Class 1/3 connection with 32-bit Network
 * Connection Parameters, supporting connection buffer sizes up to 65,535 bytes
 * (far exceeding classic Forward Open's 505-byte limit).
 *
 * Defaults to live Delta PLC at 192.168.68.250, or accepts custom host via CLI.
 */

const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

const host = process.argv[2] || '192.168.68.250';
const port = parseInt(process.argv[3], 10) || 44818;

async function main() {
    console.log(`=== ODVA Large Forward Open (0x5B) with ${host}:${port} ===\n`);

    const scanner = new Scanner(host, { port });
    await scanner.connect();
    console.log(`Connected. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    // Delta DVP-SX3 assembly instances: Output=100, Input=101 (from EDS)
    const connectionPath = encodeAssemblyConnectionPath({
        outputInstance: 100,
        inputInstance: 101
    });

    console.log('\n[1] Initiating Large_Forward_Open (0x5B)...');
    try {
        const conn = await scanner.openLargeConnection({
            connectionPath,
            otSize: 200, // bytes
            toSize: 200,
            rpiUs: 50000 // 50ms RPI
        });

        console.log('Successfully established connection:');
        console.log(`  O->T Connection ID: 0x${conn.otNetworkConnectionId.toString(16)}`);
        console.log(`  T->O Connection ID: 0x${conn.toNetworkConnectionId.toString(16)}`);
        console.log(`  Connection Serial : ${conn.connectionSerialNumber}`);
        console.log(`  O->T API          : ${conn.otApiUs} µs`);
        console.log(`  T->O API          : ${conn.toApiUs} µs`);
        console.log(`  Is Large (0x5B)   : ${conn.isLarge}`);

        console.log('\n[2] Closing connection via Forward_Close (0x4E)...');
        await scanner.closeConnection(conn);
        console.log('Connection closed cleanly.');
    } catch (err) {
        console.error('Large Forward Open failed:', err.message);
    }

    await scanner.disconnect();
    console.log('\nSession closed cleanly.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
