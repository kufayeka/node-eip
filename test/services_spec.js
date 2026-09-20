'use strict';

const assert = require('assert');
const {
    buildListServicesRequest,
    buildListServicesResponse,
    parseListServicesResponse
} = require('../src/encapsulation/services');
const { decodeMessage } = require('../src/encapsulation/header');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { buildRequest } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { CipClassCodes, EncapsulationCommands, EncapsulationStatus, CipCommonServices, CipGeneralStatus } = require('../src/constants');

describe('ListServices (0x0004) & Get_Attribute_All (0x01) (§1.2, §7)', function () {

    describe('ListServices encapsulation command', function () {
        it('builds a valid ListServices request', function () {
            const req = buildListServicesRequest();
            assert.strictEqual(req.readUInt16LE(0), EncapsulationCommands.ListServices);
            assert.strictEqual(req.readUInt16LE(2), 0); // length 0
            assert.strictEqual(req.readUInt32LE(4), 0); // session handle 0
            assert.strictEqual(req.readUInt32LE(8), 0); // status 0
        });

        it('round-trips ListServices response', function () {
            const context = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
            const resp = buildListServicesResponse({
                senderContext: context,
                version: 1,
                capabilityFlags: 0x0120,
                serviceName: 'Communications'
            });

            const decoded = decodeMessage(resp);
            assert.strictEqual(decoded.header.command, EncapsulationCommands.ListServices);
            assert.deepStrictEqual(decoded.header.senderContext, context);

            const parsed = parseListServicesResponse(decoded);
            assert.strictEqual(parsed.version, 1);
            assert.strictEqual(parsed.capabilityFlags, 0x0120);
            assert.strictEqual(parsed.serviceName, 'Communications');
            assert.strictEqual(parsed.supportsTcp, true);
            assert.strictEqual(parsed.supportsUdp, true);
        });

        it('parses real Delta SX3 ListServices wire packet', function () {
            // Captured from live Delta SX3:
            const raw = Buffer.from(
                '04001a00000000000000000000000000000000000000000001000001140001002001436f6d6d756e69636174696f6e732000',
                'hex'
            );
            const decoded = decodeMessage(raw);
            const parsed = parseListServicesResponse(decoded);
            assert.strictEqual(parsed.version, 1);
            assert.strictEqual(parsed.capabilityFlags, 0x0120);
            assert.strictEqual(parsed.serviceName, 'Communications');
            assert.strictEqual(parsed.supportsTcp, true);
            assert.strictEqual(parsed.supportsUdp, true);
        });
    });

    describe('EIPAdapter ListServices & GetAttributeAll loopback', function () {
        let adapter;
        let scanner;
        const testPort = 44835;

        before(async function () {
            adapter = new EIPAdapter({
                port: testPort,
                address: '127.0.0.1',
                identity: {
                    vendorId: 799,
                    deviceType: 14,
                    productCode: 3846,
                    productName: 'LoopbackAdapter',
                    serialNumber: 0x12345678
                },
                tcpIp: {
                    ip: '192.168.1.50',
                    netmask: '255.255.255.0'
                },
                ethernetLink: {
                    speedMbps: 100,
                    macAddress: 'AA:BB:CC:DD:EE:FF'
                }
            });
            await adapter.start();

            scanner = new Scanner('127.0.0.1', { port: testPort });
            await scanner.connect();
        });

        after(async function () {
            if (scanner) await scanner.disconnect();
            if (adapter) await adapter.stop();
        });

        it('Scanner.listServices() queries adapter without establishing a session', async function () {
            const info = await Scanner.listServices('127.0.0.1', { port: testPort });
            assert.strictEqual(info.version, 1);
            assert.strictEqual(info.supportsTcp, true);
            assert.strictEqual(info.supportsUdp, true);
            assert.strictEqual(info.serviceName, 'Communications');
        });

        it('scanner.getAttributesAll() on Identity Object (Class 0x01) returns and decodes all attributes', async function () {
            const res = await scanner.getAttributesAll({ classId: CipClassCodes.Identity, instance: 1 });
            assert(Buffer.isBuffer(res.data));
            assert(res.data.length >= 15);
            assert.strictEqual(res.decoded.vendorId, 799);
            assert.strictEqual(res.decoded.deviceType, 14);
            assert.strictEqual(res.decoded.productCode, 3846);
            assert.strictEqual(res.decoded.productName, 'LoopbackAdapter');
            assert.strictEqual(res.decoded.serialNumber, 0x12345678);
        });

        it('scanner.getAttributesAll() on TCP/IP Interface Object (Class 0xF5) returns all attributes', async function () {
            const res = await scanner.getAttributesAll({ classId: CipClassCodes.TcpIpInterface, instance: 1 });
            assert(Buffer.isBuffer(res.data));
            // Status(4) + Capability(4) + Control(4) + PhysicalLink(6) + IfConfig(20+) + HostName
            assert(res.data.length >= 38);
            assert.strictEqual(res.data.readUInt32LE(0), 1); // Status = 1
        });

        it('scanner.getAttributesAll() on Ethernet Link Object (Class 0xF6) returns all attributes', async function () {
            const res = await scanner.getAttributesAll({ classId: CipClassCodes.EthernetLink, instance: 1 });
            assert(Buffer.isBuffer(res.data));
            // Speed(4) + Flags(4) + MAC(6) = 14 bytes
            assert.strictEqual(res.data.length, 14);
            assert.strictEqual(res.data.readUInt32LE(0), 100); // 100 Mbps
        });

        describe('Connected Explicit Messaging (Class 3, SendUnitData 0x0070) — regression: Scanner could previously only RECEIVE one, never originate one', function () {
            it('opens a Class 3 explicit connection and sends a Connected request over it', async function () {
                const conn = await scanner.openExplicitConnection();
                assert(conn.otNetworkConnectionId > 0);
                assert(conn.toNetworkConnectionId > 0);

                const req = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: CipClassCodes.Identity, instance: 1, attribute: 1 }) });
                const res = await scanner.sendConnected(conn, req);
                assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
                assert.strictEqual(res.data.readUInt16LE(0), 799); // Vendor ID, matches the shared adapter's identity above

                await scanner.closeConnection(conn);
            });

            it('sends multiple Connected requests over the same connection, each with its own Sequence Count', async function () {
                const conn = await scanner.openExplicitConnection();
                const req = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: CipClassCodes.Identity, instance: 1, attribute: 3 }) }); // Product Code

                const res1 = await scanner.sendConnected(conn, req);
                const res2 = await scanner.sendConnected(conn, req);
                assert.strictEqual(res1.data.readUInt16LE(0), 3846);
                assert.strictEqual(res2.data.readUInt16LE(0), 3846);
                assert.notStrictEqual(conn._sendUnitDataSeq, undefined);

                await scanner.closeConnection(conn);
            });

            it('sendConnected() rejects a plain object that is not an opened connection', async function () {
                await assert.rejects(() => scanner.sendConnected({}, Buffer.alloc(0)), /requires a connection object/);
            });
        });
    });
});
