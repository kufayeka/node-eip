'use strict';

/**
 * Phase 3 self-test: starts our own EIPAdapter, then drives it with our
 * own client-side code (scanUdpUnicast, probeTcp, EIPSession/Scanner) —
 * full loopback validation of discovery, session management, explicit
 * messaging (Identity + Assembly), and the Forward_Open/Forward_Close
 * request/response round trip.
 *
 * Note on cyclic UDP I/O: this demo does NOT attempt a full-duplex UDP
 * data loopback on one machine. Both sides of EtherNet/IP I/O always use
 * the same fixed port (2222) — on separate physical devices that's a
 * non-issue, but on a single host it means an Adapter and a Scanner can't
 * both bind port 2222 at once to test the full data path against each
 * other locally. The cyclic-I/O *logic* (producing the right bytes at the
 * right RPI, consuming into the right buffer) is covered instead by
 * test/connection-handler_spec.js with a mocked send function, and the
 * wire *format* (io-connection.js) is the exact code already validated
 * live against real Delta hardware in Phase 2. Real cross-device I/O
 * validation is the natural next step once another host is available.
 *
 * Usage: node examples/adapter-demo.js
 */

const { EIPAdapter } = require('../src/adapter');
const { EIPSession } = require('../src/client');
const { scanUdpUnicast, probeTcp } = require('../src/encapsulation/discovery');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

const TEST_PORT = 44820; // non-standard, so this never collides with a real device/adapter on the LAN
const HOST = '127.0.0.1';

async function main() {
    const adapter = new EIPAdapter({
        port: TEST_PORT,
        address: HOST,
        identity: {
            vendorId: 0xffff,
            deviceType: 14,
            productCode: 1,
            revision: { major: 1, minor: 0 },
            productName: 'node-eip test adapter',
            serialNumber: 0x00000001
        }
    });
    adapter.defineAssembly(100, 4); // O->T ("Output") — what a Scanner writes into us
    adapter.defineAssembly(101, 4); // T->O ("Input") — what we report back

    await adapter.start();
    console.log(`Adapter listening on ${HOST}:${TEST_PORT} (TCP + UDP)`);

    try {
        console.log('\n--- UDP unicast ListIdentity ---');
        const identity = await scanUdpUnicast(HOST, { port: TEST_PORT });
        console.log(`OK: ${identity.productName}, vendorId=${identity.vendorId}`);

        console.log('\n--- TCP ListIdentity (no session) ---');
        const identity2 = await probeTcp(HOST, { port: TEST_PORT });
        console.log(`OK: ${identity2.productName}`);

        console.log('\n--- TCP ListServices (no session) ---');
        const { Scanner } = require('../src/scanner');
        const services = await Scanner.listServices(HOST, { port: TEST_PORT });
        console.log(`OK: Service "${services.serviceName}", Flags=0x${services.capabilityFlags.toString(16)}, TCP=${services.supportsTcp}, UDP=${services.supportsUdp}`);

        console.log('\n--- RegisterSession / explicit messaging / UnRegisterSession ---');
        const scanner = new Scanner(HOST, { port: TEST_PORT });
        await scanner.connect();
        const session = scanner.session;
        console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

        console.log('\n--- High-level Scanner Object Methods on Adapter ---');
        const identityAll = await scanner.getAttributesAll({ classId: 1 });
        console.log(`GetAttributesAll (Identity 0x01): Vendor=${identityAll.decoded.vendorId}, Product="${identityAll.decoded.productName}"`);

        const tcpConfig = await scanner.getTcpIpConfig();
        console.log(`Get TCP/IP Config (0xF5): IP=${tcpConfig.ip}, Netmask=${tcpConfig.netmask}, Host="${tcpConfig.hostName}"`);

        const ethInfo = await scanner.getEthernetLinkInfo();
        console.log(`Get Ethernet Link (0xF6): Speed=${ethInfo.speedMbps} Mbps, MAC=${ethInfo.macAddress}`);

        const { buildRequest } = require('../src/cip/message-router');
        const { encodeEPath } = require('../src/cip/path');
        const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

        const getVendorId = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: 0x01, instance: 1, attribute: 1 }) });
        const vendorIdResp = await session.sendUnconnected(getVendorId);
        console.log(`Get Vendor ID: status=0x${vendorIdResp.generalStatus.toString(16)}, value=${vendorIdResp.data.readUInt16LE(0)}`);

        const setAssembly = buildRequest({ service: CipCommonServices.SetAttributeSingle, path: encodeEPath({ classId: 0x04, instance: 100, attribute: 3 }), data: Buffer.from([9, 8, 7, 6]) });
        const setResp = await session.sendUnconnected(setAssembly);
        console.log(`Set Assembly 100 Data: status=0x${setResp.generalStatus.toString(16)}`);
        console.log(`Adapter's own buffer for instance 100 now:`, adapter.assembly.getData(100));

        const badSizeSet = buildRequest({ service: CipCommonServices.SetAttributeSingle, path: encodeEPath({ classId: 0x04, instance: 100, attribute: 3 }), data: Buffer.alloc(2) });
        const badSizeResp = await session.sendUnconnected(badSizeSet);
        console.log(`Set Assembly 100 with WRONG size (2 bytes instead of 4): status=0x${badSizeResp.generalStatus.toString(16)} (expect 0x15 TooMuchData)`);

        console.log('\n--- Forward_Open / Forward_Close ---');
        const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 100, t2oInstance: 101 });
        const connection = await session.openConnection({ connectionPath, rpiUs: 20000, otSize: 4, toSize: 4 });
        console.log('Forward_Open OK:', {
            otNetworkConnectionId: '0x' + connection.otNetworkConnectionId.toString(16),
            toNetworkConnectionId: '0x' + connection.toNetworkConnectionId.toString(16),
            otApiUs: connection.otApiUs,
            toApiUs: connection.toApiUs
        });

        const closed = await session.closeConnection(connection);
        console.log('Forward_Close OK:', { connectionSerialNumber: '0x' + closed.connectionSerialNumber.toString(16) });

        await session.close();
        console.log('\nSession closed.');
    } finally {
        await adapter.stop();
        console.log('Adapter stopped.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.stack || err.message);
    process.exit(1);
});
