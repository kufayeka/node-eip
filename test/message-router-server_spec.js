'use strict';

const assert = require('assert');
const { buildRequest, parseRequest, parseResponse, buildResponse } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

describe('CIP Message Router — server-side parseRequest/buildResponse', function () {
    it('parseRequest() is the exact inverse of buildRequest()', function () {
        const path = encodeEPath({ classId: 0x01, instance: 1, attribute: 1 });
        const req = buildRequest({ service: CipCommonServices.GetAttributeSingle, path, data: Buffer.from([0xaa]) });

        const parsed = parseRequest(req);
        assert.strictEqual(parsed.service, CipCommonServices.GetAttributeSingle);
        assert.deepStrictEqual(parsed.path, path);
        assert.deepStrictEqual(parsed.data, Buffer.from([0xaa]));
    });

    it('buildResponse() is the exact inverse of parseResponse()', function () {
        const resp = buildResponse({
            service: CipCommonServices.GetAttributeSingle,
            generalStatus: CipGeneralStatus.Success,
            data: Buffer.from([0x37, 0x03])
        });

        const parsed = parseResponse(resp);
        assert.strictEqual(parsed.service, CipCommonServices.GetAttributeSingle);
        assert.strictEqual(parsed.generalStatus, CipGeneralStatus.Success);
        assert.deepStrictEqual(parsed.data, Buffer.from([0x37, 0x03]));
    });

    it('buildResponse() encodes additional status words when present', function () {
        const resp = buildResponse({
            service: CipCommonServices.SetAttributeSingle,
            generalStatus: CipGeneralStatus.TooMuchData,
            additionalStatus: [0x1234]
        });
        const parsed = parseResponse(resp);
        assert.deepStrictEqual(parsed.additionalStatus, [0x1234]);
    });
});
