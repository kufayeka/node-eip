'use strict';

const assert = require('assert');
const dgram = require('dgram');
const { IoSocketManager, resetSharedIoSocketManager } = require('../src/cip/io-socket-manager');
const { IOConnection, IOConnectionState } = require('../src/cip/io-connection');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-datagram');
const { calculateMulticastIp } = require('../src/cip/objects/tcp-ip');
const { ConnectionType } = require('../src/cip/connection-manager');
const { encodeListenOnlyConnectionPath, encodeAssemblyConnectionPath } = require('../src/cip/path');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { Subscription } = require('../src/subscription');

describe('ODVA EtherNet/IP Scanner Multicast & Listen-Only Class 1 I/O (CIP Vol 2 §3-5.3)', function () {
    afterEach(async function () {
        await resetSharedIoSocketManager();
    });

    describe('IoSocketManager & Connection ID Demultiplexer', function () {
        it('routes incoming UDP datagrams in O(1) by 32-bit Connection ID', async function () {
            const testPort = 32222;
            const manager = new IoSocketManager({ port: testPort });
            await manager.ensureBound();

            const receivedA = [];
            const receivedB = [];

            const mockConnA = {
                toConnectionId: 0xAAAA1111,
                handleIncomingParsedDatagram: (parsed, rinfo) => receivedA.push(parsed)
            };
            const mockConnB = {
                toConnectionId: 0xBBBB2222,
                handleIncomingParsedDatagram: (parsed, rinfo) => receivedB.push(parsed)
            };

            await manager.registerConnection(mockConnA);
            await manager.registerConnection(mockConnB);

            const clientSocket = dgram.createSocket('udp4');

            // Send packet for Connection A
            const packetA = buildIoDatagram({
                connectionId: 0xAAAA1111,
                sequenceNumber: 1,
                data: Buffer.from([0x01, 0x02])
            });
            await new Promise((resolve) => clientSocket.send(packetA, testPort, '127.0.0.1', resolve));

            // Send packet for Connection B
            const packetB = buildIoDatagram({
                connectionId: 0xBBBB2222,
                sequenceNumber: 2,
                data: Buffer.from([0x03, 0x04])
            });
            await new Promise((resolve) => clientSocket.send(packetB, testPort, '127.0.0.1', resolve));

            // Allow short time for dispatch
            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(receivedA.length, 1);
            assert.strictEqual(receivedA[0].connectionId, 0xAAAA1111);
            assert.strictEqual(receivedB.length, 1);
            assert.strictEqual(receivedB[0].connectionId, 0xBBBB2222);

            clientSocket.close();
            await manager.close();
        });

        it('dispatches to multiple multicast followers sharing the same Connection ID', async function () {
            const testPort = 32223;
            const manager = new IoSocketManager({ port: testPort });
            await manager.ensureBound();

            const sharedConnId = 0xCCCC3333;
            const receivedFollower1 = [];
            const receivedFollower2 = [];

            const follower1 = {
                toConnectionId: sharedConnId,
                handleIncomingParsedDatagram: (parsed) => receivedFollower1.push(parsed)
            };
            const follower2 = {
                toConnectionId: sharedConnId,
                handleIncomingParsedDatagram: (parsed) => receivedFollower2.push(parsed)
            };

            await manager.registerConnection(follower1);
            await manager.registerConnection(follower2);

            const clientSocket = dgram.createSocket('udp4');
            const packet = buildIoDatagram({
                connectionId: sharedConnId,
                sequenceNumber: 10,
                data: Buffer.from([0x55, 0x66])
            });
            await new Promise((resolve) => clientSocket.send(packet, testPort, '127.0.0.1', resolve));

            await new Promise((resolve) => setTimeout(resolve, 50));

            assert.strictEqual(receivedFollower1.length, 1);
            assert.strictEqual(receivedFollower2.length, 1);
            assert.deepStrictEqual(receivedFollower1[0].data, Buffer.from([0x55, 0x66]));
            assert.deepStrictEqual(receivedFollower2[0].data, Buffer.from([0x55, 0x66]));

            await manager.unregisterConnection(follower1);
            assert.strictEqual(manager.connections.get(sharedConnId).size, 1);

            await manager.unregisterConnection(follower2);
            assert.strictEqual(manager.connections.has(sharedConnId), false);

            clientSocket.close();
            await manager.close();
        });

        it('tracks IGMP memberships with ref-counting', async function () {
            const testPort = 32224;
            const manager = new IoSocketManager({ port: testPort });
            await manager.ensureBound();

            const mcastIp = '239.192.1.50';
            const conn1 = { toConnectionId: 1, multicast: true, multicastAddress: mcastIp };
            const conn2 = { toConnectionId: 2, multicast: true, multicastAddress: mcastIp };

            await manager.registerConnection(conn1);
            assert.strictEqual(manager.memberships.get(mcastIp), 1);

            await manager.registerConnection(conn2);
            assert.strictEqual(manager.memberships.get(mcastIp), 2);

            await manager.unregisterConnection(conn1);
            assert.strictEqual(manager.memberships.get(mcastIp), 1);

            await manager.unregisterConnection(conn2);
            assert.strictEqual(manager.memberships.has(mcastIp), false);

            await manager.close();
        });
    });

    describe('Listen-Only Path & Multicast Resolution Helpers', function () {
        it('encodes Delta SX3 Listen-Only path with Heartbeat Assembly 0xC7 (199)', function () {
            const path = encodeListenOnlyConnectionPath({
                configInstance: 0x80,
                heartbeatInstance: 0xC7,
                t2oInstance: 0x65
            });

            // 0x20 0x04 (Class 4) 0x24 0x80 (Instance 128) 0x2C 0xC7 (ConnPoint 199) 0x2C 0x65 (ConnPoint 101)
            const expected = Buffer.from([0x20, 0x04, 0x24, 0x80, 0x2C, 0xC7, 0x2C, 0x65]);
            assert.deepStrictEqual(path, expected);
        });

        it('resolves multicast IP per CIP Vol 2 §3-5.3 formula', function () {
            // Test vectors
            const ip1 = '192.168.1.10';
            const netmask1 = '255.255.255.0';
            assert.strictEqual(calculateMulticastIp(ip1, netmask1), '239.192.2.32');

            const ip2 = '192.168.68.111';
            const netmask2 = '255.255.255.0';
            // 111 & 0xFF = 111; (111 - 1) & 0x3FF = 110; 110 << 5 = 3520 (0x0DC0);
            // base = 239.192.1.0 + 3520 = 239.192.14.192
            assert.strictEqual(calculateMulticastIp(ip2, netmask2), '239.192.14.192');
        });
    });

    describe('IOConnection Multicast & Shared Socket Operation', function () {
        it('IOConnection works seamlessly over shared socket manager', async function () {
            const testPort = 32225;
            const serverSocket = dgram.createSocket('udp4');
            await new Promise((resolve) => serverSocket.bind(testPort, '127.0.0.1', resolve));

            const otConnId = 0x7777;
            const toConnId = 0x8888;
            let serverReceived = 0;

            serverSocket.on('message', (msg, rinfo) => {
                const parsed = parseIoDatagram(msg);
                if (parsed.connectionId === otConnId) {
                    serverReceived++;
                    const reply = buildIoDatagram({
                        connectionId: toConnId,
                        sequenceNumber: serverReceived,
                        data: Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]),
                        includeSequenceCount: true
                    });
                    serverSocket.send(reply, rinfo.port, rinfo.address);
                }
            });

            // Use custom socket passed in to ensure isolated port during unit test
            const sharedUdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            await new Promise((resolve) => sharedUdp.bind(0, resolve));

            const conn = new IOConnection({
                host: '127.0.0.1',
                port: testPort,
                socket: sharedUdp,
                otConnectionId: otConnId,
                toConnectionId: toConnId,
                rpiMs: 15,
                useSharedSocket: false
            });

            const clientReceived = [];
            conn.on('data', (data, meta) => clientReceived.push({ data, meta }));

            await conn.start();
            await new Promise((resolve) => setTimeout(resolve, 60));
            await conn.stop();

            assert(serverReceived >= 1);
            assert(clientReceived.length >= 1);
            assert.deepStrictEqual(clientReceived[0].data, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]));

            sharedUdp.close();
            serverSocket.close();
        });
    });

    describe('Subscription Multicast & Listen-Only Integration', function () {
        it('initializes Subscription in multicast listen-only mode without output ownership', function () {
            const dummyScanner = { host: '192.168.1.10', scanner: null };
            const sub = new Subscription(dummyScanner, {
                mode: 'udp',
                multicast: true,
                listenOnly: true,
                tags: ['D0', 'D1']
            });

            assert.strictEqual(sub.multicast, true);
            assert.strictEqual(sub.listenOnly, true);
            assert.strictEqual(sub.o2tInstance, 0xC7); // Delta Heartbeat Assembly
            assert.strictEqual(sub.otSize, 0); // Size 0, no output ownership
        });
    });

    describe('End-to-End Loopback Multicast & Listen-Only Scanner Integration', function () {
        it('allows Multicast Owner and Listen-Only Follower to consume the same produced stream', async function () {
            const tcpPort = 44818 + Math.floor(Math.random() * 500);
            const ioPort = 22220 + Math.floor(Math.random() * 500);

            const adapter = new EIPAdapter({
                port: tcpPort,
                ioPort,
                address: '127.0.0.1',
                identity: { productName: 'Delta-SX3-Loopback' }
            });

            // Register connection points for Exclusive Owner and Listen-Only
            adapter.connectionHandler.registerConnectionPoint('exclusiveOwner', { outputAssembly: 0x64, inputAssembly: 0x65 });
            adapter.connectionHandler.registerConnectionPoint('listenOnly', { outputAssembly: 0xC7, inputAssembly: 0x65 });

            adapter.assembly.set(0x64, Buffer.alloc(4));
            adapter.assembly.set(0x65, Buffer.from([0x12, 0x34, 0x56, 0x78]));

            await adapter.start();

            const scannerOwner = new Scanner('127.0.0.1', { port: tcpPort });
            const scannerFollower = new Scanner('127.0.0.1', { port: tcpPort });

            await scannerOwner.connect();
            await scannerFollower.connect();

            // 1. Scanner 1 opens Multicast Owner connection
            const ownerConn = await scannerOwner.openMulticastConnection({
                configInstance: 0x80,
                o2tInstance: 0x64,
                t2oInstance: 0x65,
                otSize: 4,
                toSize: 4,
                rpiMs: 15,
                multicastAddress: '127.0.0.1' // loopback for testing
            });

            assert.strictEqual(ownerConn.multicast, true);

            // 2. Scanner 2 opens Listen-Only Multicast connection
            const followerConn = await scannerFollower.openMulticastConnection({
                listenOnly: true,
                configInstance: 0x80,
                heartbeatInstance: 0xC7,
                t2oInstance: 0x65,
                toSize: 4,
                rpiMs: 15,
                multicastAddress: '127.0.0.1',
                connectionSerialNumber: 0x9876
            });

            assert.strictEqual(followerConn.multicast, true);
            // In CIP multicast, follower gets the owner's toNetworkConnectionId
            assert.strictEqual(followerConn.toNetworkConnectionId, ownerConn.toNetworkConnectionId);

            // 3. Both create IOConnection over isolated sockets pointing to adapter's test UDP port
            const socketOwner = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            const socketFollower = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            // 3. Register both IOConnections with IoSocketManager
            const testManagerPort = 32227;
            const manager = new IoSocketManager({ port: testManagerPort });
            await manager.ensureBound();

            const ioOwner = scannerOwner.createIoConnection(ownerConn, {
                useSharedSocket: false,
                initialOutputData: Buffer.alloc(4)
            });

            const ioFollower = scannerFollower.createIoConnection(followerConn, {
                useSharedSocket: false
            });

            const ownerRx = [];
            const followerRx = [];

            ioOwner.on('data', (data) => ownerRx.push(data));
            ioFollower.on('data', (data) => followerRx.push(data));

            await manager.registerConnection(ioOwner);
            await manager.registerConnection(ioFollower);

            // Simulate produced multicast datagram arriving at the shared socket
            const sender = dgram.createSocket('udp4');
            const producedDatagram = buildIoDatagram({
                connectionId: ownerConn.toNetworkConnectionId,
                sequenceNumber: 1,
                data: Buffer.from([0x12, 0x34, 0x56, 0x78]),
                includeSequenceCount: true
            });

            await new Promise((res) => sender.send(producedDatagram, testManagerPort, '127.0.0.1', res));
            await new Promise((res) => setTimeout(res, 50));

            assert.strictEqual(ownerRx.length, 1);
            assert.strictEqual(followerRx.length, 1);
            assert.deepStrictEqual(ownerRx[0], Buffer.from([0x12, 0x34, 0x56, 0x78]));
            assert.deepStrictEqual(followerRx[0], Buffer.from([0x12, 0x34, 0x56, 0x78]));

            await manager.unregisterConnection(ioOwner);
            await manager.unregisterConnection(ioFollower);
            await manager.close();
            sender.close();

            await scannerFollower.closeConnection(followerConn);
            await scannerOwner.closeConnection(ownerConn);

            await scannerOwner.disconnect();
            await scannerFollower.disconnect();
            await adapter.stop();

            assert.strictEqual(followerConn.toNetworkConnectionId, ownerConn.toNetworkConnectionId);
        });
    });
});
