'use strict';

const assert = require('assert');
const { buildRequest, parseResponse } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

describe('CIP Message Router request/response framing', function () {
    it('builds a Get_Attribute_Single request with path size in 16-bit words', function () {
        const path = encodeEPath({ classId: 0x01, instance: 1, attribute: 1 }); // 6 bytes = 3 words
        const req = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });

        assert.strictEqual(req.readUInt8(0), CipCommonServices.GetAttributeSingle);
        assert.strictEqual(req.readUInt8(1), 3); // path size in words
        assert.deepStrictEqual(req.subarray(2), path);
    });

    it('rejects an odd-length path', function () {
        assert.throws(() => buildRequest({ service: 0x0e, path: Buffer.from([0x20]) }), RangeError);
    });

    it('parses a successful response and strips the reply-service high bit', function () {
        const buf = Buffer.concat([
            Buffer.from([CipCommonServices.GetAttributeSingle | 0x80, 0x00, CipGeneralStatus.Success, 0x00]),
            Buffer.from([0x37, 0x03]) // e.g. Vendor ID = 0x0337 as response data
        ]);

        const parsed = parseResponse(buf);
        assert.strictEqual(parsed.service, CipCommonServices.GetAttributeSingle);
        assert.strictEqual(parsed.generalStatus, CipGeneralStatus.Success);
        assert.deepStrictEqual(parsed.additionalStatus, []);
        assert.deepStrictEqual(parsed.data, Buffer.from([0x37, 0x03]));
    });

    it('parses additional status words on an error response', function () {
        const buf = Buffer.from([
            CipCommonServices.GetAttributeSingle | 0x80, 0x00,
            CipGeneralStatus.AttributeNotSupported, 0x01,
            0xad, 0xde // one additional status word, 0xdead
        ]);

        const parsed = parseResponse(buf);
        assert.strictEqual(parsed.generalStatus, CipGeneralStatus.AttributeNotSupported);
        assert.deepStrictEqual(parsed.additionalStatus, [0xdead]);
        assert.strictEqual(parsed.data.length, 0);
    });
});
