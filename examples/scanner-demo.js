'use strict';

/**
 * Demo of the public Scanner API — the whole point of scanner.js is that
 * this should now be almost all the code a consumer needs to write (no
 * more manual encodeEPath/buildRequest/sendUnconnected plumbing).
 *
 * Usage: node examples/scanner-demo.js <host>
 */

const { Scanner } = require('../src/scanner');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/scanner-demo.js <host>');
        process.exit(1);
    }

    console.log('Discovering devices on the local network...');
    const devices = await Scanner.discover({ timeoutMs: 2000 });
    for (const d of devices) {
        console.log(`  ${d.remoteAddress} — ${d.identity.productName}`);
    }

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`\nConnected to ${host}.`);

    const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
    console.log(`Vendor ID (generic explicit messaging): ${vendorId.readUInt16LE(0)}`);

    console.log(`D0 (Delta register convenience): ${await scanner.readD(0)}`);

    await scanner.disconnect();
    console.log('\nDisconnected.');
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
