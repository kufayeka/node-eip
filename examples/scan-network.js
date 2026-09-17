'use strict';

/**
 * Phase 1 network scan: UDP broadcast ListIdentity, vendor-neutral.
 *
 * With no arguments, auto-detects every active local IPv4 interface and
 * broadcasts to each one's subnet-directed address (more reliable than the
 * global 255.255.255.255 on multi-interface hosts — see discovery.js).
 * Pass an explicit address to override that.
 *
 * Usage: node examples/scan-network.js [broadcastAddress] [timeoutMs]
 */

const { scanUdp, ipv4DirectedBroadcasts } = require('../src/encapsulation/discovery');

async function main() {
    const broadcastAddress = process.argv[2] || undefined;
    const timeoutMs = process.argv[3] ? Number(process.argv[3]) : 3000;

    const targets = broadcastAddress ? [broadcastAddress] : ipv4DirectedBroadcasts();
    console.log(`Scanning ${targets.join(', ') || '(no active IPv4 interfaces found)'} for EtherNet/IP devices (${timeoutMs}ms)...`);
    const devices = await scanUdp({ broadcastAddress, timeoutMs });

    if (devices.length === 0) {
        console.log('No devices responded.');
        return;
    }

    for (const { remoteAddress, identity } of devices) {
        console.log(`\n${remoteAddress} — ${identity.productName}`);
        console.log(`  vendorId=${identity.vendorId} deviceType=${identity.deviceType} productCode=${identity.productCode}`);
        console.log(`  revision=${identity.revision.major}.${identity.revision.minor} serial=${identity.serialNumber} state=${identity.state}`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
