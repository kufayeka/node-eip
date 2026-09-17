'use strict';

const assert = require('assert');
const { encodeMessage } = require('../src/encapsulation/header');
const { encodeCpf, CpfItemType } = require('../src/encapsulation/cpf');
const { buildSendRRData, parseSendRRDataResponse } = require('../src/encapsulation/rrdata');
const { EncapsulationCommands, EncapsulationStatus } = require('../src/constants');

describe('SendRRData (unconnected explicit messaging)', function () {
    it('wraps a CIP request in a Null Address + Unconnected Data CPF, with a 6-byte prefix', function () {
        const cipRequest = Buffer.from([0x0e, 0x03, 0x20, 0x01, 0x24, 0x01, 0x30, 0x01]);
        const msg = buildSendRRData(0xabc, cipRequest, { timeoutSec: 5 });

        // header(24) + interfaceHandle(4) + timeout(2) + cpf(itemCount(2) + 2 items)
        const interfaceHandle = msg.readUInt32LE(24);
        const timeout = msg.readUInt16LE(28);
        assert.strictEqual(interfaceHandle, 0);
        assert.strictEqual(timeout, 5);

        const itemCount = msg.readUInt16LE(30);
        assert.strictEqual(itemCount, 2);
    });

    it('round-trips a CIP response through parseSendRRDataResponse', function () {
        const cipResponse = Buffer.from([0x8e, 0x00, 0x00, 0x00, 0x37, 0x03]);
        const cpf = encodeCpf([
            { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
            { typeId: CpfItemType.UnconnectedData, data: cipResponse }
        ]);
        const prefix = Buffer.alloc(6); // interfaceHandle=0, timeout=0
        const response = encodeMessage(
            { command: EncapsulationCommands.SendRRData, sessionHandle: 0xabc, status: EncapsulationStatus.Success },
            Buffer.concat([prefix, cpf])
        );

        const parsed = parseSendRRDataResponse(response);
        assert.deepStrictEqual(parsed.cipResponse, cipResponse);
    });

    it('throws when the encapsulation status is nonzero', function () {
        const response = encodeMessage(
            { command: EncapsulationCommands.SendRRData, status: EncapsulationStatus.InvalidSessionHandle },
            Buffer.alloc(6)
        );
        assert.throws(() => parseSendRRDataResponse(response), /status 0x64/);
    });
});
