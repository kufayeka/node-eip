'use strict';

/**
 * ODVA CIP Common Service 0x01: Get_Attribute_All (§7)
 *
 * Retrieves all attributes of an object instance in a single request/response
 * round-trip. Demonstrates reading:
 * - Identity Object (Class 0x01, Instance 1)
 * - TCP/IP Interface Object (Class 0xF5, Instance 1)
 * - Ethernet Link Object (Class 0xF6, Instance 1)
 *
 * Usage: node examples/get-attributes-all.js [host]
 */

const { Scanner } = require('../src/scanner');
const { CipClassCodes } = require('../src/constants');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    console.log(`=== Querying CIP Get_Attribute_All (0x01) from ${host} ===\n`);

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`Connected. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    try {
        // 1. Identity Object (Class 0x01, Instance 1)
        console.log('\n[1] Identity Object (Class 0x01, Instance 1):');
        const identity = await scanner.getAttributesAll({ classId: CipClassCodes.Identity, instance: 1 });
        console.log(`  Raw Payload (${identity.data.length} bytes): ${identity.data.toString('hex')}`);
        if (identity.decoded) {
            console.log('  Decoded Attributes:');
            console.log(`    Vendor ID:      ${identity.decoded.vendorId}`);
            console.log(`    Device Type:    ${identity.decoded.deviceType}`);
            console.log(`    Product Code:   ${identity.decoded.productCode}`);
            console.log(`    Revision:       ${identity.decoded.revision.major}.${identity.decoded.revision.minor}`);
            console.log(`    Status:         0x${identity.decoded.status.toString(16).padStart(4, '0')}`);
            console.log(`    Serial Number:  0x${identity.decoded.serialNumber.toString(16)} (${identity.decoded.serialNumber})`);
            console.log(`    Product Name:   "${identity.decoded.productName}"`);
            console.log(`    State:          ${identity.decoded.state}`);
        }

        // 2. TCP/IP Interface Object (Class 0xF5, Instance 1)
        console.log('\n[2] TCP/IP Interface Object (Class 0xF5, Instance 1):');
        try {
            const tcpIp = await scanner.getAttributesAll({ classId: CipClassCodes.TcpIpInterface, instance: 1 });
            console.log(`  Raw Payload (${tcpIp.data.length} bytes): ${tcpIp.data.toString('hex')}`);
        } catch (err) {
            console.log(`  Note: ${err.message}`);
        }

        // 3. Ethernet Link Object (Class 0xF6, Instance 1)
        console.log('\n[3] Ethernet Link Object (Class 0xF6, Instance 1):');
        try {
            const ethLink = await scanner.getAttributesAll({ classId: CipClassCodes.EthernetLink, instance: 1 });
            console.log(`  Raw Payload (${ethLink.data.length} bytes): ${ethLink.data.toString('hex')}`);
        } catch (err) {
            console.log(`  Note: ${err.message}`);
        }

    } finally {
        await scanner.disconnect();
        console.log('\nSession closed cleanly.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
