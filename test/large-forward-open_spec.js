'use strict';

const assert = require('assert');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');
const {
    encodeLargeNetworkConnectionParams,
    decodeLargeNetworkConnectionParams,
    buildLargeForwardOpenRequest,
    parseLargeForwardOpenRequest,
    ConnectionPriority,
    ConnectionType
} = require('../src/cip/connection-manager');
const { CipGeneralStatus } = require('../src/constants');

describe('Large Forward Open (0x5B) (§12, §13)', function () {
    describe('32-bit Network Connection Parameters', function () {
        it('encodes and decodes 32-bit connection parameters up to 65535 bytes', function () {
            const dword = encodeLargeNetworkConnectionParams({
                size: 1024,
                variableSize: true,
                priority: ConnectionPriority.High,
                connectionType: ConnectionType.PointToPoint,
                redundantOwner: true
            });

            const decoded = decodeLargeNetworkConnectionParams(dword);
            assert.strictEqual(decoded.size, 1024);
            assert.strictEqual(decoded.variableSize, true);
            assert.strictEqual(decoded.priority, ConnectionPriority.High);
            assert.strictEqual(decoded.connectionType, ConnectionType.PointToPoint);
            assert.strictEqual(decoded.redundantOwner, true);
        });

        it('rejects connection size exceeding 65535 bytes', function () {
            assert.throws(() => encodeLargeNetworkConnectionParams({ size: 65536 }), RangeError);
            assert.throws(() => encodeLargeNetworkConnectionParams({ size: -1 }), RangeError);
        });
    });

    describe('Request / Response Codec', function () {
        it('builds and parses Large_Forward_Open request with 32-bit params', function () {
            const path = encodeAssemblyConnectionPath({ inputInstance: 0x65, outputInstance: 0x64 });
            const built = buildLargeForwardOpenRequest({
                connectionPath: path,
                otSize: 1024,
                toSize: 2048,
                otRpiUs: 50000,
                toRpiUs: 50000
            });

            const parsed = parseLargeForwardOpenRequest(built.data);
            assert.strictEqual(parsed.otSize, 1024);
            assert.strictEqual(parsed.toSize, 2048);
            assert.strictEqual(parsed.otRpiUs, 50000);
            assert.strictEqual(parsed.toRpiUs, 50000);
            assert.deepStrictEqual(parsed.connectionPath, path);
        });
    });

    describe('EIPAdapter Loopback Integration', function () {
        let adapter;
        let scanner;
        const TEST_PORT = 45818;
        const TEST_IO_PORT = 43222;

        beforeEach(async function () {
            adapter = new EIPAdapter({
                port: TEST_PORT,
                ioPort: TEST_IO_PORT,
                address: '127.0.0.1'
            });
            // Define large assembly buffers exceeding classic 505-byte limit
            adapter.defineAssembly(0x64, 1000); // Output (O->T)
            adapter.defineAssembly(0x65, 1200); // Input (T->O)
            await adapter.start();

            scanner = new Scanner('127.0.0.1', { port: TEST_PORT });
            await scanner.connect();
        });

        afterEach(async function () {
            if (scanner) await scanner.disconnect().catch(() => {});
            if (adapter) await adapter.stop().catch(() => {});
        });

        it('establishes a Large Forward Open connection (>505 bytes) and closes cleanly', async function () {
            const connectionPath = encodeAssemblyConnectionPath({
                outputInstance: 0x64,
                inputInstance: 0x65
            });

            // openConnection automatically detects size > 505 and uses Large Forward Open (0x5B)
            const conn = await scanner.openConnection({
                connectionPath,
                otSize: 1000,
                toSize: 1200,
                rpiUs: 20000
            });

            assert.strictEqual(conn.isLarge, true);
            assert.ok(conn.otNetworkConnectionId > 0);
            assert.ok(conn.toNetworkConnectionId > 0);
            assert.strictEqual(conn.otApiUs, 20000);
            assert.strictEqual(conn.toApiUs, 20000);

            // Close connection
            const closed = await scanner.closeConnection(conn);
            assert.strictEqual(closed.connectionSerialNumber, conn.connectionSerialNumber);
        });

        it('supports openLargeConnection helper method', async function () {
            const connectionPath = encodeAssemblyConnectionPath({
                outputInstance: 0x64,
                inputInstance: 0x65
            });

            const conn = await scanner.openLargeConnection({
                connectionPath,
                otSize: 1000,
                toSize: 1200,
                rpiUs: 20000
            });

            assert.strictEqual(conn.isLarge, true);
            await scanner.closeConnection(conn);
        });
    });
});
