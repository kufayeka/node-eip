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
    console.log(`Vendor ID (Identity Object 0x01): ${vendorId.readUInt16LE(0)}`);

    const serialNum = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 6 });
    console.log(`Serial Number (Identity Object 0x01): 0x${serialNum.readUInt32LE(0).toString(16)}`);

    console.log('\n(For vendor-specific PLC register access like D, Y, M, use the universal Device client: new Device(host, "delta:sx3"))');

    await scanner.disconnect();
    console.log('\nDisconnected cleanly.');

}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
