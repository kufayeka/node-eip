'use strict';

/**
 * Class 1 Real-Time I/O Demonstration (§14, §15, §16, §17).
 *
 * Demonstrates full-duplex cyclic implicit messaging against Delta DVP-SX3 (or any ODVA device):
 * 1. Establishes session & negotiates connection via Forward_Open.
 * 2. Creates and starts IOConnection engine on UDP port 2222.
 * 3. Originator cyclically transmits O->T datagrams at negotiated RPI (20ms).
 * 4. Target cyclically transmits T->O input assembly datagrams.
 * 5. IOConnection validates sequence progression, detects any packet loss, and prints telemetry.
 * 6. Cleanly closes connection via Forward_Close and unregisters session.
 *
 * Usage: node examples/class1-cyclic-io.js [host] [durationSeconds]
 */

const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const durationSeconds = process.argv[3] ? Number(process.argv[3]) : 3;

    console.log(`Connecting to EtherNet/IP target at ${host}...`);
    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`Session established with handle 0x${scanner.session.sessionHandle.toString(16)}`);

    // Delta DVP-SX3 standard assembly connection:
    // O->T: Instance 100 (0x64), 200 bytes
    // T->O: Instance 101 (0x65), 200 bytes
    // Config: Instance 128 (0x80)
    const connectionPath = encodeAssemblyConnectionPath({
        configInstance: 0x80,
        o2tInstance: 0x64,
        t2oInstance: 0x65
    });

    console.log(`Opening Class 1 I/O connection (RPI: 20ms, O->T: 200 bytes, T->O: 200 bytes)...`);
    const conn = await scanner.openConnection({
        connectionPath,
        rpiUs: 20000,
        otSize: 200,
        toSize: 200
    });

    console.log(`Connection negotiated:`);
    console.log(`  O->T Connection ID: 0x${conn.otNetworkConnectionId.toString(16)}`);
    console.log(`  T->O Connection ID: 0x${conn.toNetworkConnectionId.toString(16)}`);
    console.log(`  T->O Actual API:    ${conn.toApiUs / 1000} ms`);

    const io = scanner.createIoConnection(conn, {
        rpiMs: 20,
        initialOutputData: Buffer.alloc(200)
    });

    let rxCount = 0;
    io.on('data', (data, meta) => {
        rxCount++;
        if (rxCount === 1 || rxCount % 25 === 0) {
            console.log(`[T->O RX #${rxCount}] Seq: ${meta.sequenceNumber}, Status: ${meta.status}, Length: ${data.length} bytes, First 4 bytes: ${data.slice(0, 4).toString('hex')}`);
        }
    });

    io.on('packetLost', (info) => {
        console.warn(`[WARN] Packet lost! Missed ${info.lost} packet(s) at sequence ${info.sequenceNumber}`);
    });

    io.on('timeout', (info) => {
        console.error(`[TIMEOUT] Watchdog expired: no data received in ${info.elapsed}ms`);
    });

    console.log(`Starting cyclic I/O engine for ${durationSeconds} seconds...`);
    await io.start();

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

    console.log(`\nStopping cyclic I/O engine...`);
    await io.stop();

    const stats = io.getStats();
    console.log(`\nI/O Connection Statistics:`);
    console.log(`  State:            ${stats.state}`);
    console.log(`  Packets Sent:     ${stats.sent}`);
    console.log(`  Packets Received: ${stats.received}`);
    console.log(`  Packets Lost:     ${stats.lost}`);
    console.log(`  Duplicates:       ${stats.duplicates}`);
    console.log(`  Out of Order:     ${stats.outOfOrder}`);
    console.log(`  Final Sequence:   ${stats.lastSequenceNumber}`);

    console.log(`\nTearing down connection via Forward_Close...`);
    await scanner.closeConnection(conn);
    console.log(`Connection closed successfully.`);

    await scanner.disconnect();
    console.log(`Session closed cleanly.`);
}

main().catch((err) => {
    console.error(`Error:`, err.message);
    process.exit(1);
});
