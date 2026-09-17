'use strict';

/**
 * Phase 2 smoke test: cyclic Class 1 I/O data — Forward_Open a connection,
 * then listen on UDP :2222 for the Target's produced (T->O) datagrams and
 * print what arrives. Also produces our own (O->T) datagrams at the
 * negotiated RPI so the connection doesn't time out — filled with all-zero
 * bytes, matching the device's already-observed current state (instance
 * 100's Data attribute read all zero in examples/get-attribute.js earlier),
 * so this does not change anything on the device.
 *
 * This is the direct, vendor-neutral CIP mechanism underneath what
 * Rockwell markets as "Produced/Consumed Tags" — here we're consuming the
 * Target's produced data generically via its Assembly Object, not via a
 * Logix-specific Symbol path.
 *
 * Usage: node examples/io-listen.js <host> [listenSeconds]
 */

const dgram = require('dgram');
const { EIPSession } = require('../src/client');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-connection');
const { EIP_IO_UDP_PORT } = require('../src/constants');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const listenSeconds = process.argv[3] ? Number(process.argv[3]) : 3;

    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

    const connection = await session.openConnection({ connectionPath, rpiUs: 20000, otSize: 200, toSize: 200 });
    console.log(`Forward_Open OK — T->O connection id 0x${connection.toNetworkConnectionId.toString(16)}, O->T connection id 0x${connection.otNetworkConnectionId.toString(16)}, RPI ${connection.toApiUs / 1000}ms`);

    const udp = dgram.createSocket('udp4');
    let received = 0;
    let lastSequenceNumber = null;
    let lastData = null;
    const seenPayloads = new Set();

    udp.on('message', (msg) => {
        let parsed;
        try {
            parsed = parseIoDatagram(msg);
        } catch {
            return; // not a valid I/O datagram — ignore
        }
        if (parsed.connectionId !== connection.toNetworkConnectionId) {
            return; // belongs to a different connection sharing this port
        }
        received++;
        lastSequenceNumber = parsed.sequenceNumber;
        lastData = parsed.data;
        seenPayloads.add(parsed.data.toString('hex'));
    });

    await new Promise((resolve, reject) => {
        udp.once('error', reject);
        udp.bind(EIP_IO_UDP_PORT, resolve);
    });
    console.log(`Listening on UDP :${EIP_IO_UDP_PORT} for ${listenSeconds}s...`);

    // Keep the connection alive by producing our own O->T data at the
    // negotiated RPI (all-zero, non-destructive — see file header).
    let otSequenceNumber = 0;
    const otData = Buffer.alloc(200);
    const rpiMs = Math.max(1, Math.round(connection.otApiUs / 1000));
    const sendTimer = setInterval(() => {
        otSequenceNumber++;
        const datagram = buildIoDatagram({ connectionId: connection.otNetworkConnectionId, sequenceNumber: otSequenceNumber, data: otData });
        udp.send(datagram, EIP_IO_UDP_PORT, host);
    }, rpiMs);

    await new Promise((resolve) => setTimeout(resolve, listenSeconds * 1000));
    clearInterval(sendTimer);
    udp.close();

    console.log(`\nReceived ${received} T->O datagram(s). Last sequence number: ${lastSequenceNumber}`);
    console.log(`Distinct payloads seen: ${seenPayloads.size}`);
    if (lastData) {
        console.log(`Last payload (${lastData.length} bytes): ${lastData.toString('hex')}`);
    }

    await session.closeConnection(connection);
    await session.close();
    console.log('\nConnection and session closed.');
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
