'use strict';

const assert = require('assert');
const {
    FragmentReader,
    FragmentWriter,
    readLargeData,
    writeLargeData,
    DEFAULT_MAX_CHUNK_SIZE
} = require('../src/cip/fragmentation');
const { parseRequest } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { AssemblyObject } = require('../src/cip/objects/assembly');
const { CipGeneralStatus, CipCommonServices } = require('../src/constants');
const { Scanner } = require('../src/scanner');

describe('CIP Fragmentation & Large Transfer Engine (§33, §34)', function () {
    const testPath = encodeEPath({ classId: 0x04, instance: 100, attribute: 3 });

    describe('FragmentReader', function () {
        it('handles single-fragment read when device immediately returns 0x00 Success', async function () {
            const expectedPayload = Buffer.from('SingleChunkTransferData');
            const mockSession = {
                async sendUnconnected(requestBuf) {
                    const parsed = parseRequest(requestBuf);
                    assert.strictEqual(parsed.service, CipCommonServices.GetAttributeSingle);
                    assert.strictEqual(parsed.data.length, 0); // initial offset is omitted or 0
                    return {
                        service: parsed.service | 0x80,
                        generalStatus: CipGeneralStatus.Success,
                        additionalStatus: [],
                        data: expectedPayload
                    };
                }
            };

            const reader = new FragmentReader(mockSession, { path: testPath });
            const result = await reader.read();

            assert.strictEqual(result.fragmentsCount, 1);
            assert.strictEqual(result.totalBytes, expectedPayload.length);
            assert.deepStrictEqual(result.data, expectedPayload);
        });

        it('reassembles multi-part read responses with 0x06 Partial Transfer', async function () {
            const part1 = Buffer.alloc(200, 0x11);
            const part2 = Buffer.alloc(200, 0x22);
            const part3 = Buffer.alloc(50, 0x33);
            const expected = Buffer.concat([part1, part2, part3]);

            const requestsReceived = [];

            const mockSession = {
                async sendUnconnected(requestBuf) {
                    const req = parseRequest(requestBuf);
                    requestsReceived.push(req);

                    if (requestsReceived.length === 1) {
                        return {
                            generalStatus: CipGeneralStatus.PartialTransfer,
                            additionalStatus: [],
                            data: part1
                        };
                    } else if (requestsReceived.length === 2) {
                        // verify offset passed in request
                        assert.strictEqual(req.data.readUInt32LE(0), 200);
                        return {
                            generalStatus: CipGeneralStatus.PartialTransfer,
                            additionalStatus: [],
                            data: part2
                        };
                    } else if (requestsReceived.length === 3) {
                        assert.strictEqual(req.data.readUInt32LE(0), 400);
                        return {
                            generalStatus: CipGeneralStatus.Success,
                            additionalStatus: [],
                            data: part3
                        };
                    }
                    throw new Error('Unexpected extra request');
                }
            };

            const chunkEvents = [];
            const progressEvents = [];

            const reader = new FragmentReader(mockSession, { path: testPath });
            reader.on('chunk', (evt) => chunkEvents.push(evt));
            reader.on('progress', (evt) => progressEvents.push(evt));

            const result = await reader.read();

            assert.strictEqual(result.fragmentsCount, 3);
            assert.strictEqual(result.totalBytes, 450);
            assert.deepStrictEqual(result.data, expected);

            assert.strictEqual(chunkEvents.length, 3);
            assert.strictEqual(chunkEvents[0].isPartial, true);
            assert.strictEqual(chunkEvents[1].isPartial, true);
            assert.strictEqual(chunkEvents[2].isPartial, false);

            assert.strictEqual(progressEvents.length, 3);
            assert.strictEqual(progressEvents[2].bytesRead, 450);
        });

        it('enforces maxTotalBytes limit to prevent infinite loops', async function () {
            const mockSession = {
                async sendUnconnected() {
                    return {
                        generalStatus: CipGeneralStatus.PartialTransfer,
                        additionalStatus: [],
                        data: Buffer.alloc(100)
                    };
                }
            };

            const reader = new FragmentReader(mockSession, {
                path: testPath,
                maxTotalBytes: 250
            });

            await assert.rejects(
                () => reader.read(),
                /exceeded maxTotalBytes limit/
            );
        });

        it('throws error when remote device returns CIP error status', async function () {
            const mockSession = {
                async sendUnconnected() {
                    return {
                        generalStatus: CipGeneralStatus.PathDestinationUnknown,
                        additionalStatus: [0x0100],
                        data: Buffer.alloc(0)
                    };
                }
            };

            const reader = new FragmentReader(mockSession, { path: testPath });
            await assert.rejects(
                () => reader.read(),
                /Fragmented read failed at offset 0: status 0x5/
            );
        });
    });

    describe('FragmentWriter', function () {
        it('sends small payload as single request without offset header', async function () {
            const data = Buffer.from('SmallDataWrite');
            let receivedRequest = null;

            const mockSession = {
                async sendUnconnected(requestBuf) {
                    receivedRequest = parseRequest(requestBuf);
                    return {
                        generalStatus: CipGeneralStatus.Success,
                        additionalStatus: [],
                        data: Buffer.alloc(0)
                    };
                }
            };

            const writer = new FragmentWriter(mockSession, {
                path: testPath,
                data,
                chunkSize: 480
            });

            const result = await writer.write();
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.fragmentsCount, 1);
            assert.strictEqual(result.bytesWritten, data.length);
            assert.deepStrictEqual(receivedRequest.data, data);
        });

        it('slices large payload into chunks with 32-bit offset headers', async function () {
            const totalSize = 1000;
            const chunkSize = 400;
            const largeBuffer = Buffer.alloc(totalSize);
            for (let i = 0; i < totalSize; i++) largeBuffer[i] = i & 0xff;

            const chunksReceived = [];

            const mockSession = {
                async sendUnconnected(requestBuf) {
                    const req = parseRequest(requestBuf);
                    const offset = req.data.readUInt32LE(0);
                    const chunk = req.data.subarray(4);
                    chunksReceived.push({ offset, chunk });
                    return {
                        generalStatus: CipGeneralStatus.Success,
                        additionalStatus: [],
                        data: Buffer.alloc(0)
                    };
                }
            };

            const progressLogs = [];
            const writer = new FragmentWriter(mockSession, {
                path: testPath,
                data: largeBuffer,
                chunkSize
            });
            writer.on('progress', (p) => progressLogs.push(p));

            const result = await writer.write();
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.fragmentsCount, 3);
            assert.strictEqual(result.bytesWritten, totalSize);

            // Chunk 1: offset 0, len 400
            assert.strictEqual(chunksReceived[0].offset, 0);
            assert.strictEqual(chunksReceived[0].chunk.length, 400);

            // Chunk 2: offset 400, len 400
            assert.strictEqual(chunksReceived[1].offset, 400);
            assert.strictEqual(chunksReceived[1].chunk.length, 400);

            // Chunk 3: offset 800, len 200
            assert.strictEqual(chunksReceived[2].offset, 800);
            assert.strictEqual(chunksReceived[2].chunk.length, 200);

            // Verify reassembled data matches original exactly
            const reassembled = Buffer.concat(chunksReceived.map((c) => c.chunk));
            assert.deepStrictEqual(reassembled, largeBuffer);

            assert.strictEqual(progressLogs.length, 3);
            assert.strictEqual(progressLogs[2].percent, 100);
        });
    });

    describe('Server-side Assembly Object with Fragmentation Support', function () {
        it('serves chunked read with 0x06 PartialTransfer and accepts chunked write', async function () {
            const assembly = new AssemblyObject({ maxFragmentSize: 250 });
            const totalSize = 600;
            assembly.define(100, totalSize);

            const initialData = Buffer.alloc(totalSize);
            for (let i = 0; i < totalSize; i++) initialData[i] = (i * 3) & 0xff;
            assembly.setData(100, initialData);

            // Create a fake session routed to the assembly
            const serverSession = {
                async sendUnconnected(requestBuf) {
                    const req = parseRequest(requestBuf);
                    if (req.service === CipCommonServices.GetAttributeSingle) {
                        return assembly.getAttributeSingle(100, 3, req.data);
                    }
                    if (req.service === CipCommonServices.SetAttributeSingle) {
                        return assembly.setAttributeSingle(100, 3, req.data);
                    }
                    throw new Error('Unsupported');
                }
            };

            // Test readLargeData against AssemblyObject
            const readResult = await readLargeData(serverSession, {
                path: testPath,
                chunkSize: 250
            });

            assert.strictEqual(readResult.totalBytes, totalSize);
            assert.strictEqual(readResult.fragmentsCount, 3); // 250 + 250 + 100
            assert.deepStrictEqual(readResult.data, initialData);

            // Test writeLargeData against AssemblyObject
            const newData = Buffer.alloc(totalSize);
            for (let i = 0; i < totalSize; i++) newData[i] = (i * 7 + 1) & 0xff;

            const writeResult = await writeLargeData(serverSession, {
                path: testPath,
                data: newData,
                chunkSize: 250
            });

            assert.strictEqual(writeResult.ok, true);
            assert.strictEqual(writeResult.fragmentsCount, 3);

            // Verify the assembly memory now has newData
            assert.deepStrictEqual(assembly.getData(100), newData);
        });
    });

    describe('Scanner readLargeAttribute & writeLargeAttribute', function () {
        it('exposes readLargeAttribute and writeLargeAttribute on Scanner instance', async function () {
            const scanner = new Scanner('127.0.0.1');

            assert.strictEqual(typeof scanner.readLargeAttribute, 'function');
            assert.strictEqual(typeof scanner.writeLargeAttribute, 'function');

            // Mock session in scanner
            const testBuf = Buffer.alloc(500, 0xaa);
            scanner.session = {
                async sendUnconnected() {
                    return {
                        generalStatus: CipGeneralStatus.Success,
                        additionalStatus: [],
                        data: testBuf
                    };
                }
            };

            const readRes = await scanner.readLargeAttribute({
                classId: 0x04,
                instance: 100,
                attribute: 3
            });
            assert.strictEqual(readRes.totalBytes, 500);
            assert.deepStrictEqual(readRes.data, testBuf);
        });
    });
});
