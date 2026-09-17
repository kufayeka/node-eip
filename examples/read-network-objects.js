'use strict';

/**
 * Demonstrates reading and decoding standard ODVA CIP Network Objects:
 * - TCP/IP Interface Object (Class 0xF5)
 * - Ethernet Link Object (Class 0xF6)
 *
 * Usage: node examples/read-network-objects.js [host]
 */

const { Scanner } = require('../src/scanner');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    console.log(`=== Reading Standard CIP Network Objects from ${host} ===\n`);

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`Connected. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    console.log('\n--- TCP/IP Interface Object (Class 0xF5) ---');
    const tcpIp = await scanner.getTcpIpConfig();
    console.log('Status:        ', tcpIp.status === 1 ? '1 (Active / Valid Configuration)' : tcpIp.status);
    console.log('IP Address:    ', tcpIp.ip);
    console.log('Network Mask:  ', tcpIp.netmask);
    console.log('Gateway:       ', tcpIp.gateway);
    console.log('Primary DNS:   ', tcpIp.primaryDns);
    console.log('Secondary DNS: ', tcpIp.secondaryDns);
    console.log('Domain Name:   ', tcpIp.domainName || '(none)');
    console.log('Host Name:     ', tcpIp.hostName || '(none)');

    console.log('\n--- Ethernet Link Object (Class 0xF6) ---');
    const link = await scanner.getEthernetLinkInfo();
    console.log('Speed:         ', link.speedMbps ? `${link.speedMbps} Mbps` : 'unknown');
    console.log('MAC Address:   ', link.macAddress);
    console.log('Interface:     ', link.interfaceLabel);
    if (link.flags) {
        console.log('Link Active:   ', link.flags.linkActive ? 'YES' : 'NO');
        console.log('Duplex Mode:   ', link.flags.fullDuplex ? 'Full Duplex' : 'Half Duplex');
    }

    await scanner.disconnect();
    console.log('\nSession closed cleanly. Network objects successfully read.');
}

main().catch((err) => {
    console.error('FAILED:', err);
    process.exit(1);
});
