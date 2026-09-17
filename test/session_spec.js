'use strict';

const assert = require('assert');
const { encodeMessage } = require('../src/encapsulation/header');
const {
    buildRegisterSessionRequest,
    parseRegisterSessionResponse,
    buildUnRegisterSessionRequest,
    readRegisterSessionRequest,
    buildRegisterSessionResponse
} = require('../src/encapsulation/session');
const { decodeMessage } = require('../src/encapsulation/header');
const { EncapsulationCommands, EncapsulationStatus } = require('../src/constants');

describe('RegisterSession / UnRegisterSession', function () {
    it('builds a RegisterSession request with protocol version 1 and options 0', function () {
        const req = buildRegisterSessionRequest();
        assert.strictEqual(req.readUInt16LE(0), EncapsulationCommands.RegisterSession);
        assert.strictEqual(req.readUInt16LE(2), 4); // command-specific data length
        assert.strictEqual(req.readUInt16LE(24), 1); // protocol version
        assert.strictEqual(req.readUInt16LE(26), 0); // options flags
    });

    it('parses a successful response and extracts the allocated session handle', function () {
        const data = Buffer.alloc(4);
        data.writeUInt16LE(1, 0);
        data.writeUInt16LE(0, 2);
        const response = encodeMessage({
            command: EncapsulationCommands.RegisterSession,
            sessionHandle: 0xcafef00d,
            status: EncapsulationStatus.Success
        }, data);

        const parsed = parseRegisterSessionResponse(response);
        assert.strictEqual(parsed.sessionHandle, 0xcafef00d);
        assert.strictEqual(parsed.protocolVersion, 1);
    });

    it('throws when the target rejects the session (nonzero status)', function () {
        const data = Buffer.alloc(4);
        const response = encodeMessage({
            command: EncapsulationCommands.RegisterSession,
            status: EncapsulationStatus.UnsupportedProtocolRevision
        }, data);

        assert.throws(() => parseRegisterSessionResponse(response), /status 0x69/);
    });

    it('builds an UnRegisterSession request carrying the session handle and no payload', function () {
        const req = buildUnRegisterSessionRequest(0xdeadbeef);
        assert.strictEqual(req.length, 24);
        assert.strictEqual(req.readUInt16LE(0), EncapsulationCommands.UnRegisterSession);
        assert.strictEqual(req.readUInt32LE(4), 0xdeadbeef);
    });

    it('readRegisterSessionRequest() is the exact inverse of buildRegisterSessionRequest() (Adapter side, Phase 3)', function () {
        const req = buildRegisterSessionRequest();
        const msg = decodeMessage(req);
        const parsed = readRegisterSessionRequest(msg);
        assert.strictEqual(parsed.protocolVersion, 1);
        assert.strictEqual(parsed.optionsFlags, 0);
    });

    it('buildRegisterSessionResponse() -> client parseRegisterSessionResponse() round-trips', function () {
        const resp = buildRegisterSessionResponse({ sessionHandle: 0xcafef00d });
        const parsed = parseRegisterSessionResponse(resp);
        assert.strictEqual(parsed.sessionHandle, 0xcafef00d);
        assert.strictEqual(parsed.protocolVersion, 1);
    });
});
