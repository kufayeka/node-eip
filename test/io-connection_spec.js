'use strict';

const assert = require('assert');
const dgram = require('dgram');
const {
    buildIoDatagram,
    parseIoDatagram,
    SequenceTracker,
    IOConnection,
    IOConnectionState,
    RealTimeFormat,
    RunIdleState
} = require('../src/cip/io-connection');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

describe('Class 1 Real-Time I/O Subsystem (§14, §15, §16, §17)', function () {
    describe('32-bit Run/Idle Header (§14)', function () {
        it('encodes and parses modeless datagram (no header)', function () {
            const raw = buildIoDatagram({
                connectionId: 0x12345678,
                sequenceNumber: 42,
                data: Buffer.from([0xaa, 0xbb, 0xcc]),
                useRunIdleHeader: false
            });

            const parsed = parseIoDatagram(raw, { expectRunIdleHeader: false });
            assert.strictEqual(parsed.connectionId, 0x12345678);
            assert.strictEqual(parsed.sequenceNumber, 42);
            assert.strictEqual(parsed.runIdle, null);
            assert.deepStrictEqual(parsed.data, Buffer.from([0xaa, 0xbb, 0xcc]));
        });

        it('encodes and parses with 32-bit Run/Idle Header in Run state (0x00000001)', function () {
            const raw = buildIoDatagram({
                connectionId: 0x87654321,
                sequenceNumber: 100,
                data: Buffer.from([1, 2, 3, 4]),
                useRunIdleHeader: true,
                runIdle: true
            });

            const parsed = parseIoDatagram(raw, { expectRunIdleHeader: true });
            assert.strictEqual(parsed.connectionId, 0x87654321);
            assert.strictEqual(parsed.sequenceNumber, 100);
            assert.strictEqual(parsed.runIdle, true);
            assert.deepStrictEqual(parsed.data, Buffer.from([1, 2, 3, 4]));
        });

        it('encodes and parses with 32-bit Run/Idle Header in Idle state (0x00000000)', function () {
            const raw = buildIoDatagram({
                connectionId: 0x55aa55aa,
                sequenceNumber: 200,
                data: Buffer.from([0xfe, 0xdc]),
                useRunIdleHeader: true,
                runIdle: false
            });

            const parsed = parseIoDatagram(raw, { expectRunIdleHeader: true });
            assert.strictEqual(parsed.connectionId, 0x55aa55aa);
            assert.strictEqual(parsed.sequenceNumber, 200);
            assert.strictEqual(parsed.runIdle, false);
            assert.deepStrictEqual(parsed.data, Buffer.from([0xfe, 0xdc]));
        });

        it('throws when expectRunIdleHeader is true but payload is under 4 bytes', function () {
            const raw = buildIoDatagram({
                connectionId: 1,
                sequenceNumber: 1,
                data: Buffer.from([1, 2]),
                useRunIdleHeader: false
            });

            assert.throws(() => {
                parseIoDatagram(raw, { expectRunIdleHeader: true });
            }, /expected 32-bit Run\/Idle header/);
        });
    });

    describe('Sequence Tracking Engine (§17)', function () {
        it('tracks sequential in-order packet progression', function () {
            const tracker = new SequenceTracker();
            assert.deepStrictEqual(tracker.track(1), { status: 'ok', lost: 0, sequenceNumber: 1 });
            assert.deepStrictEqual(tracker.track(2), { status: 'ok', lost: 0, sequenceNumber: 2 });
            assert.deepStrictEqual(tracker.track(3), { status: 'ok', lost: 0, sequenceNumber: 3 });

            const stats = tracker.getStats();
            assert.strictEqual(stats.received, 3);
            assert.strictEqual(stats.lost, 0);
            assert.strictEqual(stats.duplicates, 0);
            assert.strictEqual(stats.outOfOrder, 0);
        });

        it('detects duplicate packets', function () {
            const tracker = new SequenceTracker();
            tracker.track(10);
            const dup = tracker.track(10);
            assert.strictEqual(dup.status, 'duplicate');
            assert.strictEqual(tracker.getStats().duplicates, 1);
        });

        it('detects lost packets when sequence jumps forward', function () {
            const tracker = new SequenceTracker();
            tracker.track(10);
            const jump = tracker.track(14); // missed 11, 12, 13 -> 3 lost
            assert.strictEqual(jump.status, 'lost');
            assert.strictEqual(jump.lost, 3);
            assert.strictEqual(tracker.getStats().lost, 3);
        });

        it('detects out-of-order packets', function () {
            const tracker = new SequenceTracker();
            tracker.track(20);
            tracker.track(22); // jumped
            const old = tracker.track(21); // arrived late
            assert.strictEqual(old.status, 'out_of_order');
            assert.strictEqual(tracker.getStats().outOfOrder, 1);
        });

        it('handles 32-bit sequence rollover seamlessly', function () {
            const tracker = new SequenceTracker();
            tracker.track(0xfffffffe);
            assert.strictEqual(tracker.track(0xffffffff).status, 'ok');
            assert.strictEqual(tracker.track(0x00000000).status, 'ok');
            assert.strictEqual(tracker.track(0x00000001).status, 'ok');
            assert.strictEqual(tracker.getStats().lost, 0);
            assert.strictEqual(tracker.getStats().outOfOrder, 0);
        });
    });

    describe('IOConnection Engine (§14, §15, §16)', function () {
        let serverSocket;
        let serverPort;

        beforeEach(function (done) {
            serverSocket = dgram.createSocket('udp4');
            serverSocket.bind(0, '127.0.0.1', () => {
                serverPort = serverSocket.address().port;
                done();
            });
        });

        afterEach(function (done) {
            serverSocket.close(done);
        });

        it('sends cyclic O->T datagrams at RPI and receives T->O responses', async function () {
            const otConnId = 0x1111;
            const toConnId = 0x2222;

            let receivedAtServer = 0;
            serverSocket.on('message', (msg, rinfo) => {
                const parsed = parseIoDatagram(msg, { expectRunIdleHeader: true });
                if (parsed.connectionId === otConnId) {
                    receivedAtServer++;
                    // Reply with a T->O datagram -- per CIP Vol 1 3-4.5.1.2, T->O NEVER carries a
                    // Run/Idle header regardless of what the O->T side of this same connection
                    // uses (that's an O->T-only concept); this project's own T->O production
                    // convention is a 2-byte transport Sequence Count instead (see
                    // connection-handler.js's sendAtCurrentSeq, includeSequenceCount: true
                    // unconditionally). A previous version of this test had the fake server send a
                    // Run/Idle header on T->O too, which the client-side bug this test exists to
                    // catch (IOConnection wrongly reusing its own useRunIdleHeader flag to decide
                    // how to parse INCOMING T->O data) then "correctly" un-stripped -- two bugs
                    // cancelling out into a passing test that verified the wrong behavior.
                    const reply = buildIoDatagram({
                        connectionId: toConnId,
                        sequenceNumber: receivedAtServer,
                        data: Buffer.from([0x10, 0x20, 0x30]),
                        includeSequenceCount: true
                    });
                    serverSocket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
                }
            });

            const client = new IOConnection({
                host: '127.0.0.1',
                port: serverPort,
                localPort: 0, // ephemeral port for test
                otConnectionId: otConnId,
                toConnectionId: toConnId,
                rpiMs: 15,
                useRunIdleHeader: true,
                runIdle: true,
                initialOutputData: Buffer.from([0x01, 0x02])
            });

            const receivedAtClient = [];
            client.on('data', (data, meta) => {
                receivedAtClient.push({ data, meta });
            });

            await client.start();

            // Allow 3-4 cyclic ticks (15ms * 4 = 60ms)
            await new Promise((resolve) => setTimeout(resolve, 80));

            await client.stop();

            assert(receivedAtServer >= 2, `Expected at least 2 packets at server, got ${receivedAtServer}`);
            assert(receivedAtClient.length >= 2, `Expected at least 2 packets at client, got ${receivedAtClient.length}`);
            assert.deepStrictEqual(receivedAtClient[0].data, Buffer.from([0x10, 0x20, 0x30]));
            // T->O never carries Run/Idle -- meta.runIdle is always null for received data,
            // regardless of this same connection's own O->T useRunIdleHeader setting.
            assert.strictEqual(receivedAtClient[0].meta.runIdle, null);

            const stats = client.getStats();
            assert.strictEqual(stats.state, IOConnectionState.CLOSED);
            assert(stats.sent >= 2);
            assert(stats.received >= 2);
        });

        it('triggers watchdog timeout when target stops producing', async function () {
            const otConnId = 0x3333;
            const toConnId = 0x4444;

            const client = new IOConnection({
                host: '127.0.0.1',
                port: serverPort,
                localPort: 0,
                otConnectionId: otConnId,
                toConnectionId: toConnId,
                rpiMs: 10,
                timeoutMultiplier: 3 // timeout after 30ms without RX
            });

            let timedOut = false;
            client.on('timeout', () => {
                timedOut = true;
            });

            await client.start();

            // Wait 50ms without server sending anything
            await new Promise((resolve) => setTimeout(resolve, 60));

            assert.strictEqual(timedOut, true);
            assert.strictEqual(client.state, IOConnectionState.TIMED_OUT);

            await client.stop();
        });
    });

    describe('EIPAdapter Class 1 Loopback Integration', function () {
        it('exchanges cyclic Class 1 I/O through Forward_Open and IOConnection', async function () {
            const tcpPort = 44818 + Math.floor(Math.random() * 500);
            const ioPort = 22220 + Math.floor(Math.random() * 500);

            const adapter = new EIPAdapter({
                port: tcpPort,
                ioPort,
                address: '127.0.0.1',
                identity: { productName: 'Loopback-IO-PLC' }
            });

            // Set up input and output assembly instances
            // Instance 0x64 (Output / O->T) 4 bytes, Instance 0x65 (Input / T->O) 4 bytes
            adapter.assembly.set(0x64, Buffer.from([0x00, 0x00, 0x00, 0x00]));
            adapter.assembly.set(0x65, Buffer.from([0x42, 0x43, 0x44, 0x45]));

            await adapter.start();

            const scanner = new Scanner('127.0.0.1', { port: tcpPort });
            await scanner.connect();

            const connectionPath = encodeAssemblyConnectionPath({
                configInstance: 0x80,
                o2tInstance: 0x64,
                t2oInstance: 0x65
            });

            const conn = await scanner.openConnection({
                connectionPath,
                rpiUs: 15000,
                otSize: 4,
                toSize: 4
            });

            assert(conn.otNetworkConnectionId > 0);
            assert(conn.toNetworkConnectionId > 0);

            // Create Class 1 I/O connection using the returned connection handle
            const io = scanner.createIoConnection(conn, {
                port: ioPort, // adapter's test I/O UDP port
                localPort: 0,
                initialOutputData: Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])
            });

            const receivedT2O = [];
            io.on('data', (data) => {
                receivedT2O.push(Buffer.from(data));
            });

            await io.start();

            // Wait for 2-3 cyclic exchanges
            await new Promise((resolve) => setTimeout(resolve, 60));

            // Verify client received adapter's input assembly data
            assert(receivedT2O.length > 0, 'Originator should have received T->O datagrams from adapter');
            assert.deepStrictEqual(receivedT2O[0], Buffer.from([0x42, 0x43, 0x44, 0x45]));

            // Verify adapter received client's output assembly data
            const adapterOutput = adapter.assembly.getData(0x64);
            assert.deepStrictEqual(adapterOutput, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));

            // Update output on the fly
            io.setOutput(Buffer.from([0x11, 0x22, 0x33, 0x44]));
            await new Promise((resolve) => setTimeout(resolve, 40));
            assert.deepStrictEqual(adapter.assembly.getData(0x64), Buffer.from([0x11, 0x22, 0x33, 0x44]));

            await io.stop();
            await scanner.closeConnection(conn);
            await scanner.disconnect();
            await adapter.stop();
        });
    });
});
