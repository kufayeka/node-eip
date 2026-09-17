'use strict';

const assert = require('assert');
const {
    encodeMultipleServiceData,
    buildMultipleServiceRequest,
    parseMultipleServiceResponse,
    encodeMultipleServiceResponseData,
    MESSAGE_ROUTER_PATH
} = require('../src/cip/multiple-service');
const { buildRequest, parseRequest, buildResponse, parseResponse } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { CipCommonServices, CipGeneralStatus, CipClassCodes } = require('../src/constants');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');

describe('Multiple Service Packet (0x0A) (§25)', () => {
    describe('Encoding & Decoding', () => {
        it('builds a valid Multiple Service Packet targeting Message Router (0x02/1)', () => {
            const req1 = { service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: 1, instance: 1, attribute: 1 }) };
            const req2 = { service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: 1, instance: 1, attribute: 7 }) };

            const multiReq = buildMultipleServiceRequest([req1, req2]);
            const parsed = parseRequest(multiReq);

            assert.strictEqual(parsed.service, CipCommonServices.MultipleServicePacket);
            assert.deepStrictEqual(parsed.path, MESSAGE_ROUTER_PATH);

            // Data starts with count (2)
            assert.strictEqual(parsed.data.readUInt16LE(0), 2);
            // Offset 0 and Offset 1
            const off0 = parsed.data.readUInt16LE(2);
            const off1 = parsed.data.readUInt16LE(4);
            assert.strictEqual(off0, 6); // 2 + 2*2 = 6
            assert.ok(off1 > off0);
        });

        it('encodes and parses Multiple Service Response with multiple sub-replies', () => {
            const subResp1 = {
                service: CipCommonServices.GetAttributeSingle,
                generalStatus: CipGeneralStatus.Success,
                data: Buffer.from([0x1F, 0x03]) // Vendor ID 799
            };
            const subResp2 = {
                service: CipCommonServices.GetAttributeSingle,
                generalStatus: CipGeneralStatus.AttributeNotSupported,
                data: Buffer.alloc(0)
            };

            const responsePayload = encodeMultipleServiceResponseData([subResp1, subResp2]);
            const parsed = parseMultipleServiceResponse(responsePayload);

            assert.strictEqual(parsed.length, 2);
            assert.strictEqual(parsed[0].service, CipCommonServices.GetAttributeSingle);
            assert.strictEqual(parsed[0].generalStatus, CipGeneralStatus.Success);
            assert.deepStrictEqual(parsed[0].data, Buffer.from([0x1F, 0x03]));

            assert.strictEqual(parsed[1].service, CipCommonServices.GetAttributeSingle);
            assert.strictEqual(parsed[1].generalStatus, CipGeneralStatus.AttributeNotSupported);
            assert.strictEqual(parsed[1].data.length, 0);
        });

        it('throws RangeError on truncated response payload', () => {
            const truncated = Buffer.from([0x02, 0x00, 0x06, 0x00]); // declares count 2, but missing second offset
            assert.throws(() => parseMultipleServiceResponse(truncated), RangeError);
        });
    });

    describe('EIPAdapter & Scanner Loopback (§25 Integration)', () => {
        let adapter;
        let scanner;
        const TEST_PORT = 44825;
        const HOST = '127.0.0.1';

        before(async () => {
            adapter = new EIPAdapter({
                port: TEST_PORT,
                address: HOST,
                identity: {
                    vendorId: 799,
                    productName: 'BatchTestAdapter'
                }
            });
            adapter.defineAssembly(100, 4); // 4 bytes data
            await adapter.start();

            scanner = new Scanner(HOST, { port: TEST_PORT });
            await scanner.connect();
        });

        after(async () => {
            if (scanner) await scanner.disconnect();
            if (adapter) await adapter.stop();
        });

        it('scanner executes multiple read & write operations in a single packet', async () => {
            const requests = [
                // 1. Read Vendor ID (Identity 0x01 Inst 1 Attr 1)
                { classId: 1, instance: 1, attribute: 1, service: CipCommonServices.GetAttributeSingle },
                // 2. Read Product Name (Identity 0x01 Inst 1 Attr 7)
                { classId: 1, instance: 1, attribute: 7, service: CipCommonServices.GetAttributeSingle },
                // 3. Write Assembly 100 Data (Assembly 0x04 Inst 100 Attr 3)
                { classId: 4, instance: 100, attribute: 3, service: CipCommonServices.SetAttributeSingle, data: Buffer.from([1, 2, 3, 4]) }
            ];

            const responses = await scanner.sendMultipleRequests(requests);
            assert.strictEqual(responses.length, 3);

            // Sub-reply 1: Vendor ID 799
            assert.strictEqual(responses[0].generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(responses[0].data.readUInt16LE(0), 799);

            // Sub-reply 2: Product Name "BatchTestAdapter"
            assert.strictEqual(responses[1].generalStatus, CipGeneralStatus.Success);
            const nameLen = responses[1].data[0];
            assert.strictEqual(responses[1].data.subarray(1, 1 + nameLen).toString('ascii'), 'BatchTestAdapter');

            // Sub-reply 3: Set Attribute Single success
            assert.strictEqual(responses[2].generalStatus, CipGeneralStatus.Success);
            assert.deepStrictEqual(adapter.assembly.getData(100), Buffer.from([1, 2, 3, 4]));
        });

        it('scanner.getAttributesMultiple batch-reads attributes easily', async () => {
            const results = await scanner.getAttributesMultiple([
                { classId: 1, instance: 1, attribute: 1 },
                { classId: 1, instance: 1, attribute: 7 },
                { classId: 4, instance: 100, attribute: 4 } // Assembly Size
            ]);

            assert.strictEqual(results.length, 3);
            assert.strictEqual(results[0].generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(results[0].data.readUInt16LE(0), 799);

            assert.strictEqual(results[2].generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(results[2].data.readUInt16LE(0), 4); // Size = 4
        });
    });
});
