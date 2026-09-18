'use strict';

/**
 * Universal EtherNet/IP Network Discovery Scanner
 *
 * 1. Broadcast Scan: Sends UDP broadcast ListIdentity to all local interfaces.
 * 2. Unicast Subnet Sweep: If broadcast is dropped by Wi-Fi APs / switches,
 *    automatically performs a fast concurrent unicast sweep of local /24 subnets.
 *
 * Usage:
 *   node examples/scan-network.js
 *   node examples/scan-network.js 192.168.68.255
 *   node examples/scan-network.js --sweep
 */

const { scanUdp, scanSubnet, ipv4DirectedBroadcasts } = require('../src/encapsulation/discovery');

async function main() {
    const args = process.argv.slice(2);
    const isSweepMode = args.includes('--sweep');
    const customTarget = args.find(a => a !== '--sweep');
    const timeoutMs = 2000;

    const targets = customTarget ? [customTarget] : ipv4DirectedBroadcasts();
    console.log(`\x1b[1m\x1b[36m=== EtherNet/IP Device Network Scanner ===\x1b[0m\n`);

    let devices = [];

    if (!isSweepMode && !customTarget?.endsWith('.0')) {
        console.log(`[1] Probing via UDP Broadcast (${targets.join(', ') || 'none'})...`);
        devices = await scanUdp({ broadcastAddress: customTarget, timeoutMs });
    }

    // If broadcast yielded nothing (very common on Wi-Fi where broadcast is dropped by router)
    if (devices.length === 0) {
        if (!isSweepMode) {
            console.log(`\x1b[33m[!] Broadcast dropped or blocked by Wi-Fi/switch. Switching to Fast Subnet Sweep...\x1b[0m`);
        } else {
            console.log(`[1] Running Fast Subnet Sweep on local /24 interfaces...`);
        }
        devices = await scanSubnet({ timeoutMs });
    }

    if (devices.length === 0) {
        console.log('\n\x1b[31mNo EtherNet/IP devices responded on the network.\x1b[0m');
        return;
    }

    console.log(`\n\x1b[32m✔ Found ${devices.length} EtherNet/IP Device(s):\x1b[0m\n`);
    for (const { remoteAddress, identity } of devices) {
        console.log(`\x1b[1m\x1b[34m[${remoteAddress}]\x1b[0m \x1b[1m${identity.productName}\x1b[0m`);
        console.log(`  Vendor ID    : ${identity.vendorId} (Delta Electronics / Rockwell)`);
        console.log(`  Product Code : ${identity.productCode}`);
        console.log(`  Device Type  : 0x${(identity.deviceType || 0).toString(16).padStart(4, '0')} (${identity.deviceType === 14 ? 'Programmable Controller' : 'Generic'})`);
        console.log(`  Revision     : ${identity.revision.major}.${identity.revision.minor}`);
        console.log(`  Serial Number: ${identity.serialNumber}`);
        console.log(`  Device State : ${identity.state}\n`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
