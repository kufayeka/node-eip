'use strict';

/**
 * ODVA CIP Data Types (§28-§31) & Multi-Hop Port Segment Routing (§19-§20) Demo
 *
 * Demonstrates:
 * 1. Centralized CIP Data Type System: encoding/decoding elementary types,
 *    bit-level packed booleans, and CIP strings.
 * 2. Multi-Hop Port Segment EPATH construction and decoding.
 *
 * Usage: node examples/routing-and-types.js
 */

const {
    CipDataTypeCode,
    encodeType,
    decodeType,
    readBit,
    writeBit,
    resolveBitMember,
    encodeShortString,
    decodeShortString,
    encodeCipString,
    decodeCipString
} = require('../src/cip/types');

const {
    encodePortSegment,
    decodePortSegment,
    encodeRoutePath,
    encodeEPath,
    decodeEPath
} = require('../src/cip/path');

function main() {
    console.log('=== ODVA CIP Data Type System & Multi-Hop Routing Demo ===\n');

    // 1. Elementary Types
    console.log('[1] CIP Elementary Data Types:');
    const samples = [
        { type: CipDataTypeCode.BOOL, name: 'BOOL', val: true },
        { type: CipDataTypeCode.INT, name: 'INT', val: -1234 },
        { type: CipDataTypeCode.DINT, name: 'DINT', val: 98765432 },
        { type: CipDataTypeCode.LINT, name: 'LINT', val: 123456789012345n },
        { type: CipDataTypeCode.REAL, name: 'REAL', val: 3.14159 },
        { type: CipDataTypeCode.SHORT_STRING, name: 'SHORT_STRING', val: 'DVP-SX3' },
        { type: CipDataTypeCode.STRING, name: 'STRING', val: 'EtherNet/IP Conformance' }
    ];

    for (const s of samples) {
        const encoded = encodeType(s.type, s.val);
        const decoded = decodeType(s.type, encoded);
        console.log(`  ${s.name.padEnd(14)}: raw [${encoded.toString('hex')}] -> decoded: ${decoded.value}`);
    }

    // 2. Bit-level & Packed Booleans (§30)
    console.log('\n[2] Bit-Level & Packed Boolean Structures:');
    const statusByte = Buffer.from([0b10100101]);
    console.log(`  Packed Byte: 0x${statusByte.toString('hex')} (binary: ${statusByte[0].toString(2).padStart(8, '0')})`);
    console.log(`    Bit 0 (Alarm Active):       ${readBit(statusByte, 0, 0)}`);
    console.log(`    Bit 1 (Running):            ${readBit(statusByte, 0, 1)}`);
    console.log(`    Bit 2 (Ready):              ${readBit(statusByte, 0, 2)}`);
    console.log(`    Bit 5 (Remote Mode):        ${readBit(statusByte, 0, 5)}`);
    console.log(`    Mask Check (Ready + Alarm): ${resolveBitMember(statusByte, { byteOffset: 0, mask: 0x05 })}`);

    // 3. Port Segment Multi-Hop Routing (§19, §20)
    console.log('\n[3] CIP Multi-Hop Port Segment Routing:');
    // Multi-hop route:
    // Hop 1: Port 2 (Ethernet) to remote IP "192.168.68.250"
    // Hop 2: Port 1 (Backplane) to Slot 0 (PLC Processor)
    // Target: Message Router / Identity Object (Class 0x01, Instance 1)
    const hops = [
        { port: 2, linkAddress: '192.168.68.250' },
        { port: 1, linkAddress: 0 }
    ];
    const target = { classId: 0x01, instance: 1 };

    const routePath = encodeRoutePath(hops, target);
    console.log(`  Encoded Route EPATH (${routePath.length} bytes): ${routePath.toString('hex')}`);

    const parsedPath = decodeEPath(routePath);
    console.log('  Decoded Route Path:');
    parsedPath.portSegments.forEach((hop, idx) => {
        console.log(`    Hop ${idx + 1}: Port ${hop.port} -> Link Address: "${hop.linkAddress}"`);
    });
    console.log(`    Target: Class 0x${parsedPath.classId.toString(16).padStart(2, '0')}, Instance ${parsedPath.instance}`);

    console.log('\nAll Priority 4 demonstrations completed successfully.');
}

main();
