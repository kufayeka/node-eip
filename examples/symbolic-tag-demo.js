'use strict';

/**
 * ANSI Extended Symbol Segment & Symbolic Tag Addressing Demonstration (§26, §27).
 *
 * Demonstrates symbolic tag addressing per ODVA CIP Vol 1 Appendix C-1.4.3:
 * 1. Encodes and decodes ANSI Extended Symbol Segment (0x91) with 16-bit word padding.
 * 2. Parses complex symbolic paths: simple tags, struct member dot navigation,
 *    and array subscript indices (e.g. "Tanks[0].Level").
 * 3. Encodes Tag Connection Paths for Produced/Consumed Tag I/O Connections.
 * 4. Starts a local EIPAdapter with symbolic tags and performs read/write operations
 *    via `scanner.readTag()` and `scanner.writeTag()`.
 * 5. (Optional) Probes remote target (e.g. Delta DVP-SX3 at 192.168.68.250).
 *
 * Usage: node examples/symbolic-tag-demo.js [host]
 */

const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const {
    encodeSymbolicPath,
    decodeSymbolicPath,
    encodeTagConnectionPath
} = require('../src/cip/path');

async function runLocalDemo() {
    console.log('=== Step 1: Symbolic Path Encoding & Decoding ===');
    const testPaths = [
        'TotalCount',
        'Motor.Speed',
        'Tanks[2]',
        'PackagingLines[0].Motors[1].TargetRPM'
    ];

    for (const p of testPaths) {
        const encoded = encodeSymbolicPath(p);
        const decoded = decodeSymbolicPath(encoded);
        console.log(`  Path: "${p}"`);
        console.log(`    Wire bytes (${encoded.length} bytes): ${encoded.toString('hex')}`);
        console.log(`    Decoded path: "${decoded.tagPath}" (match: ${p === decoded.tagPath})`);
    }

    console.log('\n=== Step 2: Produced / Consumed Tag Connection Path ===');
    const tagConnPath = encodeTagConnectionPath({
        configTag: 'ControllerConfig',
        o2tTag: 'Line1_ConsumedData',
        t2oTag: 'Line1_ProducedData'
    });
    console.log(`  Produced/Consumed Tag Connection Path (${tagConnPath.length} bytes):`);
    console.log(`    Hex: ${tagConnPath.toString('hex')}`);

    console.log('\n=== Step 3: Local EIPAdapter with Symbolic Tags ===');
    const port = 46200 + Math.floor(Math.random() * 1000);
    const adapter = new EIPAdapter({
        port,
        ioPort: port + 1,
        identity: {
            vendorId: 0x031f,
            deviceType: 14,
            productCode: 0x0f06,
            productName: 'node-eip-symbolic-adapter'
        }
    });

    // Define symbolic tags on adapter
    adapter.defineTag('MotorSpeed', 'INT', 1750);
    adapter.defineTag('TankLevel', 'REAL', 85.75);
    adapter.defineTag('SystemReady', 'BOOL', true);
    adapter.defineTag('RecipeName', 'STRING', 'Batch_Alloy_X');

    await adapter.start();
    console.log(`EIPAdapter listening on TCP port ${port}`);

    try {
        const scanner = new Scanner({ host: '127.0.0.1', port });
        await scanner.connect();
        console.log(`Scanner connected to adapter with session handle 0x${scanner.session.sessionHandle.toString(16)}`);

        console.log('\n=== Step 4: Reading Symbolic Tags ===');
        const speed = await scanner.readTag('MotorSpeed', { dataType: 'INT' });
        console.log(`  MotorSpeed (INT):   ${speed.value} rpm (raw: ${speed.data.toString('hex')})`);

        const level = await scanner.readTag('TankLevel', { dataType: 'REAL' });
        console.log(`  TankLevel (REAL):   ${level.value.toFixed(2)} % (raw: ${level.data.toString('hex')})`);

        const ready = await scanner.readTag('SystemReady', { dataType: 'BOOL' });
        console.log(`  SystemReady (BOOL): ${ready.value}`);

        const recipe = await scanner.readTag('RecipeName', { dataType: 'STRING' });
        console.log(`  RecipeName (STR):   "${recipe.value}"`);

        console.log('\n=== Step 5: Writing Symbolic Tags ===');
        console.log('  Writing MotorSpeed = 2800, SystemReady = false, TankLevel = 92.4...');
        await scanner.writeTag('MotorSpeed', 2800, { dataType: 'INT' });
        await scanner.writeTag('SystemReady', false);
        await scanner.writeTag('TankLevel', 92.4, { dataType: 'REAL' });

        const newSpeed = await scanner.readTag('MotorSpeed', { dataType: 'INT' });
        const newReady = await scanner.readTag('SystemReady', { dataType: 'BOOL' });
        const newLevel = await scanner.readTag('TankLevel', { dataType: 'REAL' });

        console.log(`  Updated MotorSpeed:   ${newSpeed.value} rpm`);
        console.log(`  Updated SystemReady: ${newReady.value}`);
        console.log(`  Updated TankLevel:   ${newLevel.value.toFixed(2)} %`);

        await scanner.disconnect();
    } finally {
        await adapter.stop();
        console.log('Adapter stopped cleanly.');
    }
}

async function runLiveHardwareCheck(host) {
    console.log(`\n=== Probing Live Remote Target at ${host} for Symbolic Addressing ===`);
    const scanner = new Scanner(host);
    try {
        await scanner.connect();
        const id = await scanner.getIdentity();
        console.log(`Connected to: ${id.productName || 'PLC'} at ${host}`);

        // Try reading a test symbolic tag
        console.log('Attempting symbolic read on tag "D0"...');
        try {
            const res = await scanner.readTag('D0');
            console.log(`Target accepted symbolic tag read! Bytes: ${res.data.toString('hex')}`);
        } catch (err) {
            console.log(`Target responded: ${err.message}`);
            console.log('(Note: Delta SX-3 requires Logical Class/Instance/Attribute for register access, whereas Logix and Delta SYMBOL_ANSI connections accept tag names)');
        }
        await scanner.disconnect();
    } catch (err) {
        console.log(`Could not reach ${host}: ${err.message}`);
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
