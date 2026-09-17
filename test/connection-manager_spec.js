'use strict';

const assert = require('assert');
const {
    encodeNetworkConnectionParams,
    decodeNetworkConnectionParams,
    ConnectionType,
    ConnectionPriority,
    connectionManagerPath,
    buildForwardOpenRequest,
    parseForwardOpenResponse,
    parseForwardOpenRequest,
    buildForwardOpenResponse,
    buildForwardCloseRequest,
    parseForwardCloseResponse,
    parseForwardCloseRequest,
    buildForwardCloseResponse
} = require('../src/cip/connection-manager');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

describe('Network Connection Parameters (classic Forward_Open)', function () {
    it('round-trips size/type/priority through encode+decode', function () {
        const word = encodeNetworkConnectionParams({ size: 200, connectionType: ConnectionType.PointToPoint, priority: ConnectionPriority.Low });
        const decoded = decodeNetworkConnectionParams(word);
        assert.strictEqual(decoded.size, 200);
        assert.strictEqual(decoded.connectionType, ConnectionType.PointToPoint);
        assert.strictEqual(decoded.priority, ConnectionPriority.Low);
        assert.strictEqual(decoded.variableSize, false);
        assert.strictEqual(decoded.redundantOwner, false);
    });

    it('rejects a size outside 0-511', function () {
        assert.throws(() => encodeNetworkConnectionParams({ size: 512 }), RangeError);
    });
});

describe('connectionManagerPath', function () {
    it('encodes Class 0x06 Instance 1', function () {
        assert.deepStrictEqual(connectionManagerPath(), Buffer.from([0x20, 0x06, 0x24, 0x01]));
    });
});

describe('Forward_Open request/response (Connection Manager)', function () {
    // Ground truth from Delta SX-3's own EDS file (eds/031F000E0F0600010001.eds),
    // Connection1: Class 0x04, Instance 0x80(128, Config), ConnPoint 0x64(100, O->T), ConnPoint 0x65(101, T->O).
    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });

    it('builds the connection path exactly matching the Delta SX-3 EDS Connection1 path', function () {
        assert.deepStrictEqual(connectionPath, Buffer.from([0x20, 0x04, 0x24, 0x80, 0x2c, 0x64, 0x2c, 0x65]));
    });

    it('builds a Forward_Open request with the expected field layout', function () {
        const { data, connectionSerialNumber } = buildForwardOpenRequest({
            connectionPath,
            rpiUs: 20000,
            otSize: 200,
            toSize: 200,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344,
            otNetworkConnectionId: 0,
            toNetworkConnectionId: 0
        });

        assert.strictEqual(connectionSerialNumber, 0x1234);
        assert.strictEqual(data.readUInt8(0), 0x0a); // default timeTick
        assert.strictEqual(data.readUInt8(1), 0x0e); // default timeoutTicks
        assert.strictEqual(data.readUInt32LE(2), 0); // O->T connection id (proposed)
        assert.strictEqual(data.readUInt32LE(6), 0); // T->O connection id (proposed)
        assert.strictEqual(data.readUInt16LE(10), 0x1234); // connection serial number
        assert.strictEqual(data.readUInt16LE(12), 0xaaaa); // originator vendor id
        assert.strictEqual(data.readUInt32LE(14), 0x11223344); // originator serial number
        assert.strictEqual(data.readUInt8(18), 3); // connection timeout multiplier default
        assert.strictEqual(data.readUInt32LE(22), 20000); // O->T RPI
        const otParams = decodeNetworkConnectionParams(data.readUInt16LE(26));
        assert.strictEqual(otParams.size, 200);
        assert.strictEqual(data.readUInt32LE(28), 20000); // T->O RPI
        const toParams = decodeNetworkConnectionParams(data.readUInt16LE(32));
        assert.strictEqual(toParams.size, 200);
        assert.strictEqual(data.readUInt8(34), 0x01); // transport type/trigger default
        assert.strictEqual(data.readUInt8(35), connectionPath.length / 2); // path size in words
        assert.deepStrictEqual(data.subarray(36), connectionPath);
    });

    it('parses a successful Forward_Open response', function () {
        const responseData = Buffer.alloc(26);
        responseData.writeUInt32LE(0xcafebabe, 0); // O->T connection id (target-assigned)
        responseData.writeUInt32LE(0xdeadbeef, 4); // T->O connection id (echoed)
        responseData.writeUInt16LE(0x1234, 8); // connection serial number
        responseData.writeUInt16LE(0xaaaa, 10); // originator vendor id
        responseData.writeUInt32LE(0x11223344, 12); // originator serial number
        responseData.writeUInt32LE(20000, 16); // O->T API
        responseData.writeUInt32LE(20000, 20); // T->O API
        responseData.writeUInt8(0, 24); // application reply size = 0 words
        responseData.writeUInt8(0, 25); // reserved

        const parsed = parseForwardOpenResponse(responseData);
        assert.strictEqual(parsed.otNetworkConnectionId, 0xcafebabe);
        assert.strictEqual(parsed.toNetworkConnectionId, 0xdeadbeef);
        assert.strictEqual(parsed.otApiUs, 20000);
        assert.strictEqual(parsed.toApiUs, 20000);
        assert.strictEqual(parsed.applicationReply.length, 0);
    });
});

describe('Forward_Close request/response', function () {
    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });

    it('builds a Forward_Close request carrying the original connection identifiers', function () {
        const data = buildForwardCloseRequest({
            connectionPath,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344
        });

        assert.strictEqual(data.readUInt16LE(2), 0x1234);
        assert.strictEqual(data.readUInt16LE(4), 0xaaaa);
        assert.strictEqual(data.readUInt32LE(6), 0x11223344);
        assert.strictEqual(data.readUInt8(10), connectionPath.length / 2);
        assert.deepStrictEqual(data.subarray(12), connectionPath);
    });

    it('parses a successful Forward_Close response', function () {
        const responseData = Buffer.alloc(10);
        responseData.writeUInt16LE(0x1234, 0);
        responseData.writeUInt16LE(0xaaaa, 2);
        responseData.writeUInt32LE(0x11223344, 4);
        responseData.writeUInt8(0, 8);

        const parsed = parseForwardCloseResponse(responseData);
        assert.strictEqual(parsed.connectionSerialNumber, 0x1234);
        assert.strictEqual(parsed.originatorVendorId, 0xaaaa);
        assert.strictEqual(parsed.originatorSerialNumber, 0x11223344);
    });
});

describe('Forward_Open / Forward_Close — server-side (Phase 3, Adapter)', function () {
    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });

    it('parseForwardOpenRequest() is the exact inverse of buildForwardOpenRequest()', function () {
        const { data } = buildForwardOpenRequest({
            connectionPath,
            rpiUs: 20000,
            otSize: 200,
            toSize: 150,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344,
            otNetworkConnectionId: 0,
            toNetworkConnectionId: 0xdeadbeef
        });

        const parsed = parseForwardOpenRequest(data);
        assert.strictEqual(parsed.toNetworkConnectionId, 0xdeadbeef);
        assert.strictEqual(parsed.connectionSerialNumber, 0x1234);
        assert.strictEqual(parsed.originatorVendorId, 0xaaaa);
        assert.strictEqual(parsed.originatorSerialNumber, 0x11223344);
        assert.strictEqual(parsed.otRpiUs, 20000);
        assert.strictEqual(parsed.toRpiUs, 20000);
        assert.strictEqual(parsed.otSize, 200);
        assert.strictEqual(parsed.toSize, 150);
        assert.strictEqual(parsed.transportTypeTrigger, 0x01);
        assert.deepStrictEqual(parsed.connectionPath, connectionPath);
    });

    it('buildForwardOpenResponse() -> client parseForwardOpenResponse() round-trips', function () {
        const responseData = buildForwardOpenResponse({
            otNetworkConnectionId: 0x1,
            toNetworkConnectionId: 0xdeadbeef,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344,
            otApiUs: 20000,
            toApiUs: 20000
        });

        const parsed = parseForwardOpenResponse(responseData);
        assert.strictEqual(parsed.otNetworkConnectionId, 0x1);
        assert.strictEqual(parsed.toNetworkConnectionId, 0xdeadbeef);
        assert.strictEqual(parsed.otApiUs, 20000);
        assert.strictEqual(parsed.toApiUs, 20000);
    });

    it('parseForwardCloseRequest() is the exact inverse of buildForwardCloseRequest()', function () {
        const data = buildForwardCloseRequest({
            connectionPath,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344
        });

        const parsed = parseForwardCloseRequest(data);
        assert.strictEqual(parsed.connectionSerialNumber, 0x1234);
        assert.strictEqual(parsed.originatorVendorId, 0xaaaa);
        assert.strictEqual(parsed.originatorSerialNumber, 0x11223344);
        assert.deepStrictEqual(parsed.connectionPath, connectionPath);
    });

    it('buildForwardCloseResponse() -> client parseForwardCloseResponse() round-trips', function () {
        const responseData = buildForwardCloseResponse({
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344
        });

        const parsed = parseForwardCloseResponse(responseData);
        assert.strictEqual(parsed.connectionSerialNumber, 0x1234);
        assert.strictEqual(parsed.originatorVendorId, 0xaaaa);
        assert.strictEqual(parsed.originatorSerialNumber, 0x11223344);
    });
});
