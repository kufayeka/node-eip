'use strict';

/**
 * CIP Fragmentation & Large Data Transfer Demonstration (§33, §34).
 *
 * Demonstrates progressive chunking, offset tracking, and automated buffer
 * reassembly for large industrial data attributes exceeding standard MTU limits.
 *
 * 1. Starts a local high-performance EIPAdapter configured with an assembly
 *    instance of 1500 bytes and maxFragmentSize = 400.
 * 2. Connects a Scanner client.
 * 3. Executes `writeLargeAttribute` with 1500 bytes of patterned data, logging
 *    progress events and chunk offsets.
 * 4. Executes `readLargeAttribute`, handling CIP status 0x06 Partial Transfer until
 *    0x00 Success, reassembling the 1500 bytes into a single buffer.
 * 5. Compares initial and reassembled buffers with bit-level verification.
 * 6. (Optional) If remote host is supplied (e.g. Delta DVP-SX3 at 192.168.68.250),
 *    probes the remote target's assembly or identity attributes.
 *
 * Usage: node examples/fragmentation-demo.js [host]
 */

const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { FragmentReader, FragmentWriter } = require('../src/cip/fragmentation');
const { CipClassCodes } = require('../src/constants');
const { encodeEPath } = require('../src/cip/path');

async function runLocalDemo() {
    console.log('=== Step 1: Launching Local EIPAdapter with Chunked Assembly ===');
    const port = 45800 + Math.floor(Math.random() * 1000);
    const adapter = new EIPAdapter({
        port,
        ioPort: port + 1,
        identity: {
            vendorId: 0x031f,
            deviceType: 14,
            productCode: 0x0f06,
            productName: 'node-eip-fragmentation-target',
            serialNumber: 0x88887777
        }
    });

    const assemblyInstance = 150;
    const totalSizeBytes = 1200;
    const maxChunkSize = 350;

    // Configure server assembly with chunked fragmentation support
    adapter.assembly.maxFragmentSize = maxChunkSize;
    adapter.assembly.define(assemblyInstance, totalSizeBytes);

    await adapter.start();
    console.log(`EIPAdapter listening on TCP port ${port}`);

    try {
        console.log('\n=== Step 2: Connecting Scanner Client ===');
        const scanner = new Scanner({ host: '127.0.0.1', port });
        await scanner.connect();
        console.log(`Connected to adapter with session handle 0x${scanner.session.sessionHandle.toString(16)}`);

        console.log('\n=== Step 3: Progressive Write (1200 bytes in 350-byte chunks) ===');
        const writePayload = Buffer.alloc(totalSizeBytes);
        for (let i = 0; i < totalSizeBytes; i++) {
            writePayload[i] = (i * 13 + 7) & 0xff;
        }

        const path = encodeEPath({
            classId: CipClassCodes.Assembly,
            instance: assemblyInstance,
            attribute: 3
        });

        const writer = new FragmentWriter(scanner.session, {
            path,
            data: writePayload,
            chunkSize: maxChunkSize
        });

        writer.on('progress', (p) => {
            console.log(`  [Writer] Progress: ${p.bytesWritten}/${p.totalBytes} bytes (${p.percent}%) — Fragment #${p.fragmentsCount}`);
        });

        const writeRes = await writer.write();
        console.log(`Write complete! Total fragments sent: ${writeRes.fragmentsCount}, Total bytes: ${writeRes.bytesWritten}`);

        console.log('\n=== Step 4: Progressive Read (Handling 0x06 Partial Transfer) ===');
        const reader = new FragmentReader(scanner.session, {
            path,
            chunkSize: maxChunkSize
        });

        reader.on('chunk', (c) => {
            console.log(`  [Reader] Fragment #${c.fragmentIndex}: Received ${c.chunkLength} bytes (total so far: ${c.totalBytes} bytes, isPartial: ${c.isPartial})`);
        });

        const readRes = await reader.read();
        console.log(`Read complete! Total fragments received: ${readRes.fragmentsCount}, Total bytes: ${readRes.totalBytes}`);

        console.log('\n=== Step 5: Data Integrity Verification ===');
        if (Buffer.compare(writePayload, readRes.data) === 0) {
            console.log('SUCCESS: All 1200 bytes match exactly with zero data corruption!');
        } else {
            console.error('ERROR: Reassembled data does not match written data!');
            process.exitCode = 1;
        }

        console.log('\n=== Step 6: Scanner High-Level API Test ===');
        const highLevelRead = await scanner.readLargeAttribute({
            classId: CipClassCodes.Assembly,
            instance: assemblyInstance,
            attribute: 3,
            chunkSize: maxChunkSize
        });
        console.log(`scanner.readLargeAttribute() returned ${highLevelRead.totalBytes} bytes across ${highLevelRead.fragmentsCount} fragments.`);

        await scanner.disconnect();
    } finally {
        await adapter.stop();
        console.log('Adapter stopped cleanly.');
    }
}

async function runLiveHardwareCheck(host) {
    console.log(`\n=== Probing Live Remote Target at ${host} ===`);
    const scanner = new Scanner(host);
    try {
        await scanner.connect();
        console.log(`Session established with live hardware at ${host}`);
        const id = await scanner.getIdentity();
        console.log(`Device: ${id.productName || 'Unknown'} (Vendor: ${id.vendorId}, ProductCode: 0x${(id.productCode || 0).toString(16)})`);

        // Read standard assembly attribute via readLargeAttribute
        console.log('Testing readLargeAttribute on live target Assembly Instance 101...');
        const res = await scanner.readLargeAttribute({
            classId: CipClassCodes.Assembly,
            instance: 101,
            attribute: 3,
            chunkSize: 480
        }).catch((err) => {
            console.log(`  (Note: Hardware assembly 101 read returned: ${err.message})`);
            return null;
        });

        if (res) {
            console.log(`Live hardware returned ${res.totalBytes} bytes in ${res.fragmentsCount} fragment(s).`);
        }
        await scanner.disconnect();
    } catch (err) {
        console.log(`Could not reach or probe hardware at ${host}: ${err.message}`);
    }
}

async function main() {
    await runLocalDemo();
    const host = process.argv[2] || (process.env.PLC_IP || '192.168.68.250');
    if (host) {
        await runLiveHardwareCheck(host);
    }
}

main().catch((err) => {
    console.error('Demonstration failed:', err);
    process.exit(1);
});
