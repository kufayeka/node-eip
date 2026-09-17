'use strict';

const assert = require('assert');
const { encodeHeader, decodeHeader, encodeMessage, decodeMessage } = require('../src/encapsulation/header');
const { EncapsulationCommands } = require('../src/constants');

describe('encapsulation header', function () {
    it('round-trips command/session/status/context through encode+decode', function () {
        const senderContext = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
        const buf = encodeHeader({
            command: EncapsulationCommands.RegisterSession,
            sessionHandle: 0x12345678,
            status: 0,
            senderContext
        });

        assert.strictEqual(buf.length, 24);

        const decoded = decodeHeader(buf);
        assert.strictEqual(decoded.command, EncapsulationCommands.RegisterSession);
        assert.strictEqual(decoded.sessionHandle, 0x12345678);
        assert.strictEqual(decoded.status, 0);
        assert.deepStrictEqual(decoded.senderContext, senderContext);
        assert.strictEqual(decoded.options, 0);
    });

    it('rejects a senderContext that is not exactly 8 bytes', function () {
        assert.throws(() => encodeHeader({ command: 1, senderContext: Buffer.alloc(4) }), RangeError);
    });

    it('encodeMessage fills in the length field from the data payload', function () {
        const data = Buffer.from('hello');
        const msg = encodeMessage({ command: EncapsulationCommands.SendRRData }, data);
        const decoded = decodeHeader(msg);
        assert.strictEqual(decoded.length, data.length);
        assert.deepStrictEqual(msg.subarray(24), data);
    });

    it('decodeMessage returns null on a partial buffer (TCP still buffering)', function () {
        const data = Buffer.from('hello world');
        const full = encodeMessage({ command: EncapsulationCommands.SendUnitData }, data);
        assert.strictEqual(decodeMessage(full.subarray(0, 10)), null);

        const result = decodeMessage(full);
        assert.strictEqual(result.bytesConsumed, full.length);
        assert.deepStrictEqual(result.data, data);
    });
});
