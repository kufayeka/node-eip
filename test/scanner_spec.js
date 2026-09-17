'use strict';

const assert = require('assert');
const { Scanner } = require('../src/scanner');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

/** Replaces the Scanner's internal EIPSession with a stub that intercepts sendUnconnected(). */
function stubSession(scanner, handler) {
    scanner.session = { sendUnconnected: handler };
}

describe('Scanner (public API wrapper)', function () {
    it('getAttribute() builds the right CIP request and returns the response data on success', async function () {
        const scanner = new Scanner('127.0.0.1');
        let capturedRequest;
        stubSession(scanner, async (cipRequest) => {
            capturedRequest = cipRequest;
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0x37, 0x03]) };
        });

        const data = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });

        assert.strictEqual(capturedRequest.readUInt8(0), CipCommonServices.GetAttributeSingle);
        assert.deepStrictEqual(data, Buffer.from([0x37, 0x03]));
    });

    it('getAttribute() throws a descriptive error on a nonzero general status', async function () {
        const scanner = new Scanner('127.0.0.1');
        stubSession(scanner, async () => ({ generalStatus: CipGeneralStatus.AttributeNotSupported, additionalStatus: [], data: Buffer.alloc(0) }));

        await assert.rejects(
            () => scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 99 }),
            /general status 0x14/
        );
    });

    it('setAttribute() builds a Set_Attribute_Single request carrying the payload', async function () {
        const scanner = new Scanner('127.0.0.1');
        let capturedRequest;
        stubSession(scanner, async (cipRequest) => {
            capturedRequest = cipRequest;
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) };
        });

        await scanner.setAttribute({ classId: 0x352, instance: 2, attribute: 100, data: Buffer.from([0xd2, 0x04]) });

        assert.strictEqual(capturedRequest.readUInt8(0), CipCommonServices.SetAttributeSingle);
        assert.deepStrictEqual(capturedRequest.subarray(-2), Buffer.from([0xd2, 0x04]));
    });

    it('exposes Delta register convenience methods bound to its own session', async function () {
        const scanner = new Scanner('127.0.0.1');
        let capturedRequest;
        stubSession(scanner, async (cipRequest) => {
            capturedRequest = cipRequest;
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0xd2, 0x04]) };
        });

        const value = await scanner.readD(100);

        assert.strictEqual(value, 1234);
        // Class 0x352 (16-bit segment), Instance 2 (word), Attribute 100
        assert.deepStrictEqual(capturedRequest.subarray(2, 10), Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x02, 0x30, 0x64]));
    });
});
