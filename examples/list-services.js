'use strict';

/**
 * ODVA EtherNet/IP Encapsulation Command 0x0004: ListServices (§1.2)
 *
 * Queries supported encapsulation services from a remote EtherNet/IP device
 * over TCP port 44818 without establishing a session.
 *
 * Returns version, capability flags (e.g. bit 5 = CIP Encapsulation via TCP,
 * bit 8 = CIP Class 0/1 via UDP), and service name (e.g. "Communications").
 *
 * Usage: node examples/list-services.js [host] [port]
 */

const { Scanner } = require('../src/scanner');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const port = process.argv[3] ? Number(process.argv[3]) : 44818;

    console.log(`=== Querying ListServices (0x0004) from ${host}:${port} ===\n`);

    const services = await Scanner.listServices(host, { port });

    console.log('ListServices Response:');
    console.log(`  Protocol Version:  ${services.version}`);
    console.log(`  Capability Flags:  0x${services.capabilityFlags.toString(16).padStart(4, '0')} (${services.capabilityFlags})`);
    console.log(`  Service Name:      "${services.serviceName}"`);
    console.log(`  Supports TCP (EIP):${services.supportsTcp ? ' YES' : ' NO'}`);
    console.log(`  Supports UDP (I/O):${services.supportsUdp ? ' YES' : ' NO'}`);
    console.log('\nQuery completed successfully.');
}

main().catch((err) => {
    console.error('ListServices failed:', err.message);
    process.exit(1);
});
