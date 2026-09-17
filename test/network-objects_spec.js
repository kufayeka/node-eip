'use strict';

const assert = require('assert');
const { TcpIpInterfaceObject, decodeInterfaceConfiguration, decodeCipString, ipToBuffer, bufferToIp } = require('../src/cip/objects/tcp-ip');
const { EthernetLinkObject, formatMacAddress, parseMacAddress, decodeInterfaceFlags } = require('../src/cip/objects/ethernet-link');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { CipGeneralStatus, CipClassCodes } = require('../src/constants');

describe('TCP/IP Interface (0xF5) & Ethernet Link (0xF6) Objects (§10, §11)', function () {

    describe('TcpIpInterfaceObject (0xF5)', function () {
        it('answers Status (Attr 1) as a 4-byte DWORD', function () {
            const obj = new TcpIpInterfaceObject({ status: 1 });
            const res = obj.getAttributeSingle(1, 1);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(res.data.readUInt32LE(0), 1);
        });

        it('answers Configuration Capability (Attr 2) and Control (Attr 3)', function () {
            const obj = new TcpIpInterfaceObject({ configurationCapability: 0x15, configurationControl: 0 });
            assert.strictEqual(obj.getAttributeSingle(1, 2).data.readUInt32LE(0), 0x15);
            assert.strictEqual(obj.getAttributeSingle(1, 3).data.readUInt32LE(0), 0);
        });

        it('answers Physical Link Object (Attr 4) pointing to Ethernet Link Class 0xF6 Inst 1', function () {
            const obj = new TcpIpInterfaceObject();
            const res = obj.getAttributeSingle(1, 4);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            // 2 words path length (4 bytes) + EPATH (0x20, 0xF6, 0x24, 0x01)
            assert.deepStrictEqual(res.data, Buffer.from([0x02, 0x00, 0x20, 0xf6, 0x24, 0x01]));
        });

        it('answers Interface Configuration (Attr 5) and decodes correctly', function () {
            const obj = new TcpIpInterfaceObject({
                ip: '192.168.68.250',
                netmask: '255.255.255.0',
                gateway: '192.168.68.1',
                primaryDns: '8.8.8.8',
                secondaryDns: '8.8.4.4',
                domainName: 'local'
            });
            const res = obj.getAttributeSingle(1, 5);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);

            const decoded = decodeInterfaceConfiguration(res.data);
            assert.strictEqual(decoded.ip, '192.168.68.250');
            assert.strictEqual(decoded.netmask, '255.255.255.0');
            assert.strictEqual(decoded.gateway, '192.168.68.1');
            assert.strictEqual(decoded.primaryDns, '8.8.8.8');
            assert.strictEqual(decoded.secondaryDns, '8.8.4.4');
            assert.strictEqual(decoded.domainName, 'local');
        });

        it('decodes ground truth Attr 5 buffer from real Delta SX3 hardware', function () {
            // Buffer from Delta SX3 Attr 5: fa44a8c0 00ffffff 00000000 00000000 00000000 0000
            const raw = Buffer.from('fa44a8c000ffffff0000000000000000000000000000', 'hex');
            const decoded = decodeInterfaceConfiguration(raw);
            assert.strictEqual(decoded.ip, '192.168.68.250');
            assert.strictEqual(decoded.netmask, '255.255.255.0');
            assert.strictEqual(decoded.gateway, '0.0.0.0');
            assert.strictEqual(decoded.domainName, '');
        });

        it('answers Host Name (Attr 6) as a CIP STRING', function () {
            const obj = new TcpIpInterfaceObject({ hostName: 'DVP-SX3' });
            const res = obj.getAttributeSingle(1, 6);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(decodeCipString(res.data, 0), 'DVP-SX3');
        });

        it('answers Inactivity Timeout (Attr 13)', function () {
            const obj = new TcpIpInterfaceObject({ inactivityTimeoutSec: 120 });
            const res = obj.getAttributeSingle(1, 13);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(res.data.readUInt16LE(0), 120);
        });

        it('rejects invalid instance or unknown attribute', function () {
            const obj = new TcpIpInterfaceObject();
            assert.strictEqual(obj.getAttributeSingle(2, 1).generalStatus, CipGeneralStatus.PathDestinationUnknown);
            assert.strictEqual(obj.getAttributeSingle(1, 99).generalStatus, CipGeneralStatus.AttributeNotSupported);
        });

        it('supports setAttributeSingle for settable attributes (Attr 3, 5, 13)', function () {
            const obj = new TcpIpInterfaceObject();
            const setControl = Buffer.alloc(4);
            setControl.writeUInt32LE(2, 0); // DHCP
            assert.strictEqual(obj.setAttributeSingle(1, 3, setControl).generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(obj.configurationControl, 2);

            const setTimeoutBuf = Buffer.alloc(2);
            setTimeoutBuf.writeUInt16LE(300, 0);
            assert.strictEqual(obj.setAttributeSingle(1, 13, setTimeoutBuf).generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(obj.inactivityTimeoutSec, 300);
        });
    });

    describe('EthernetLinkObject (0xF6)', function () {
        it('answers Interface Speed (Attr 1) and Flags (Attr 2)', function () {
            const obj = new EthernetLinkObject({ speedMbps: 100, flags: 0x13 });
            assert.strictEqual(obj.getAttributeSingle(1, 1).data.readUInt32LE(0), 100);
            assert.strictEqual(obj.getAttributeSingle(1, 2).data.readUInt32LE(0), 0x13);

            const flags = decodeInterfaceFlags(0x13);
            assert.strictEqual(flags.linkActive, true);
            assert.strictEqual(flags.fullDuplex, true);
        });

        it('answers Physical Address MAC (Attr 3)', function () {
            const obj = new EthernetLinkObject({ macAddress: '00:18:23:E4:61:2E' });
            const res = obj.getAttributeSingle(1, 3);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(formatMacAddress(res.data), '00:18:23:E4:61:2E');
        });

        it('decodes ground truth MAC buffer from real Delta SX3 hardware', function () {
            const rawMac = Buffer.from('001823e4612e', 'hex');
            assert.strictEqual(formatMacAddress(rawMac), '00:18:23:E4:61:2E');
        });

        it('answers Interface Label (Attr 10) as a SHORT_STRING', function () {
            const obj = new EthernetLinkObject({ interfaceLabel: 'Port 1' });
            const res = obj.getAttributeSingle(1, 10);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(res.data[0], 6); // length
            assert.strictEqual(res.data.subarray(1, 7).toString('ascii'), 'Port 1');
        });

        it('answers Interface Capability (Attr 11)', function () {
            const obj = new EthernetLinkObject();
            const res = obj.getAttributeSingle(1, 11);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(res.data.readUInt32LE(0), 0x07); // Capability bits
            assert.strictEqual(res.data[4], 4); // 4 speed/duplex entries
        });
    });

    describe('EIPAdapter & Scanner loopback integration', function () {
        let adapter;
        let scanner;
        const testPort = 44830;

        before(async function () {
            adapter = new EIPAdapter({
                port: testPort,
                address: '127.0.0.1',
                identity: { productName: 'TestAdapter' },
                tcpIp: {
                    ip: '192.168.1.100',
                    netmask: '255.255.255.0',
                    gateway: '192.168.1.1',
                    hostName: 'TestAdapter'
                },
                ethernetLink: {
                    speedMbps: 100,
                    macAddress: '00:11:22:33:44:55',
                    interfaceLabel: 'Ethernet'
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

        it('scanner reads decoded TCP/IP config (0xF5) from adapter', async function () {
            const config = await scanner.getTcpIpConfig();
            assert.strictEqual(config.status, 1);
            assert.strictEqual(config.ip, '192.168.1.100');
            assert.strictEqual(config.netmask, '255.255.255.0');
            assert.strictEqual(config.gateway, '192.168.1.1');
            assert.strictEqual(config.hostName, 'TestAdapter');
        });

        it('scanner reads decoded Ethernet Link info (0xF6) from adapter', async function () {
            const link = await scanner.getEthernetLinkInfo();
            assert.strictEqual(link.speedMbps, 100);
            assert.strictEqual(link.macAddress, '00:11:22:33:44:55');
            assert.strictEqual(link.interfaceLabel, 'Ethernet');
            assert.strictEqual(link.flags.linkActive, true);
            assert.strictEqual(link.flags.fullDuplex, true);
        });
    });
});
