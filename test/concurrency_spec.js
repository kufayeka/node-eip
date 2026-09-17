'use strict';

const assert = require('assert');
const net = require('net');
const { EIPSession } = require('../src/client');
const { decodeMessage } = require('../src/encapsulation/header');
const { buildRegisterSessionResponse } = require('../src/encapsulation/session');
const { buildSendRRData, readSendRRDataResponse } = require('../src/encapsulation/rrdata');
const { buildRequest, buildResponse } = require('../src/cip/message-router');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

describe('EIPSession concurrency and Sender Context correlation (§40, §41)', function () {
    let server;
    let serverPort;
    const openSockets = new Set();

    afterEach(function (done) {
        for (const s of openSockets) {
            try { s.destroy(); } catch {}
        }
        openSockets.clear();
        if (server) {
            server.close(done);
            server = null;
        } else {
            done();
        }
    });

    it('correctly routes responses even when the server replies out-of-order', async function () {
        server = net.createServer((socket) => {
            openSockets.add(socket);
            let buffer = Buffer.alloc(0);
            const requests = [];

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const msg = decodeMessage(buffer);
                    if (!msg) break;
                    buffer = buffer.subarray(msg.bytesConsumed);

                    if (msg.header.command === 0x0065) {
                        socket.write(buildRegisterSessionResponse({
                            sessionHandle: 0x1234,
                            senderContext: msg.header.senderContext
                        }));
                    } else if (msg.header.command === 0x006F) {
                        requests.push(msg);
                        if (requests.length === 2) {
                            const [req1, req2] = requests;

                            const cipResp2 = buildResponse({
                                service: CipCommonServices.GetAttributeSingle,
                                generalStatus: CipGeneralStatus.Success,
                                data: Buffer.from([0x22, 0x22])
                            });
                            const cipResp1 = buildResponse({
                                service: CipCommonServices.GetAttributeSingle,
                                generalStatus: CipGeneralStatus.Success,
                                data: Buffer.from([0x11, 0x11])
                            });

                            socket.write(buildSendRRData(0x1234, cipResp2, { senderContext: req2.header.senderContext }));
                            socket.write(buildSendRRData(0x1234, cipResp1, { senderContext: req1.header.senderContext }));
                        }
                    }
                }
            });
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            resolve();
        }));

        // Allow 2 in-flight requests simultaneously on the wire
        const session = new EIPSession('127.0.0.1', { port: serverPort, timeoutMs: 1000, maxInFlight: 2 });
        await session.connect();

        const req1 = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: Buffer.from([0x20, 0x01, 0x24, 0x01]) });
        const req2 = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: Buffer.from([0x20, 0x01, 0x24, 0x02]) });

        const [res1, res2] = await Promise.all([
            session.sendUnconnected(req1),
            session.sendUnconnected(req2)
        ]);

        assert.deepStrictEqual(res1.data, Buffer.from([0x11, 0x11]));
        assert.deepStrictEqual(res2.data, Buffer.from([0x22, 0x22]));

        await session.close();
    });

    it('shuffles and resolves a burst of 10 concurrent requests without cross-talk', async function () {
        server = net.createServer((socket) => {
            openSockets.add(socket);
            let buffer = Buffer.alloc(0);
            const pendingRequests = [];

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const msg = decodeMessage(buffer);
                    if (!msg) break;
                    buffer = buffer.subarray(msg.bytesConsumed);

                    if (msg.header.command === 0x0065) {
                        socket.write(buildRegisterSessionResponse({
                            sessionHandle: 0x5678,
                            senderContext: msg.header.senderContext
                        }));
                    } else if (msg.header.command === 0x006F) {
                        const { cipResponse } = readSendRRDataResponse(msg);
                        const id = cipResponse[cipResponse.length - 1];
                        pendingRequests.push({ msg, id });

                        if (pendingRequests.length === 10) {
                            pendingRequests.sort(() => Math.random() - 0.5);
                            for (const { msg: reqMsg, id: reqId } of pendingRequests) {
                                const cipResp = buildResponse({
                                    service: CipCommonServices.GetAttributeSingle,
                                    generalStatus: CipGeneralStatus.Success,
                                    data: Buffer.from([reqId, reqId * 2])
                                });
                                socket.write(buildSendRRData(0x5678, cipResp, { senderContext: reqMsg.header.senderContext }));
                            }
                        }
                    }
                }
            });
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            resolve();
        }));

        // Allow 10 in-flight requests simultaneously on the wire
        const session = new EIPSession('127.0.0.1', { port: serverPort, timeoutMs: 2000, maxInFlight: 10 });
        await session.connect();

        const promises = [];
        for (let i = 1; i <= 10; i++) {
            const req = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: Buffer.from([0x20, 0x01, 0x24, 0x01]),
                data: Buffer.from([i])
            });
            promises.push(session.sendUnconnected(req));
        }

        const results = await Promise.all(promises);
        for (let i = 0; i < 10; i++) {
            const expectedId = i + 1;
            assert.deepStrictEqual(results[i].data, Buffer.from([expectedId, expectedId * 2]));
        }

        await session.close();
    });

    it('safely pipelines requests via maxInFlight=1 queue when caller uses Promise.all', async function () {
        let inFlightOnWire = 0;
        let maxObservedInFlight = 0;

        server = net.createServer((socket) => {
            openSockets.add(socket);
            let buffer = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const msg = decodeMessage(buffer);
                    if (!msg) break;
                    buffer = buffer.subarray(msg.bytesConsumed);

                    if (msg.header.command === 0x0065) {
                        socket.write(buildRegisterSessionResponse({
                            sessionHandle: 0x7777,
                            senderContext: msg.header.senderContext
                        }));
                    } else if (msg.header.command === 0x006F) {
                        inFlightOnWire++;
                        if (inFlightOnWire > maxObservedInFlight) {
                            maxObservedInFlight = inFlightOnWire;
                        }

                        const { cipResponse } = readSendRRDataResponse(msg);
                        const val = cipResponse[cipResponse.length - 1];

                        // Respond after a tiny asynchronous delay
                        setTimeout(() => {
                            inFlightOnWire--;
                            const cipResp = buildResponse({
                                service: CipCommonServices.GetAttributeSingle,
                                generalStatus: CipGeneralStatus.Success,
                                data: Buffer.from([val * 10])
                            });
                            socket.write(buildSendRRData(0x7777, cipResp, { senderContext: msg.header.senderContext }));
                        }, 10);
                    }
                }
            });
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            resolve();
        }));

        // maxInFlight = 1 (default)
        const session = new EIPSession('127.0.0.1', { port: serverPort, maxInFlight: 1 });
        await session.connect();

        const promises = [];
        for (let i = 1; i <= 5; i++) {
            const req = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: Buffer.from([0x20, 0x01, 0x24, 0x01]),
                data: Buffer.from([i])
            });
            promises.push(session.sendUnconnected(req));
        }

        const results = await Promise.all(promises);
        for (let i = 0; i < 5; i++) {
            assert.deepStrictEqual(results[i].data, Buffer.from([(i + 1) * 10]));
        }

        // Verify that no more than 1 request was ever in-flight on the socket simultaneously
        assert.strictEqual(maxObservedInFlight, 1);

        await session.close();
    });

    it('timed-out request does not desynchronize subsequent requests when late reply arrives', async function () {
        let delayedReqMsg = null;
        let clientSocket = null;

        server = net.createServer((socket) => {
            openSockets.add(socket);
            clientSocket = socket;
            let buffer = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                for (;;) {
                    const msg = decodeMessage(buffer);
                    if (!msg) break;
                    buffer = buffer.subarray(msg.bytesConsumed);

                    if (msg.header.command === 0x0065) {
                        socket.write(buildRegisterSessionResponse({
                            sessionHandle: 0x9999,
                            senderContext: msg.header.senderContext
                        }));
                    } else if (msg.header.command === 0x006F) {
                        const { cipResponse } = readSendRRDataResponse(msg);
                        const tag = cipResponse[cipResponse.length - 1];
                        if (tag === 0xAA) {
                            delayedReqMsg = msg;
                        } else {
                            const cipResp = buildResponse({
                                service: CipCommonServices.GetAttributeSingle,
                                generalStatus: CipGeneralStatus.Success,
                                data: Buffer.from([0xBB])
                            });
                            socket.write(buildSendRRData(0x9999, cipResp, { senderContext: msg.header.senderContext }));
                        }
                    }
                }
            });
        });

        await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            resolve();
        }));

        const session = new EIPSession('127.0.0.1', { port: serverPort, timeoutMs: 150 });
        await session.connect();

        // Req 1: will time out
        const req1 = buildRequest({
            service: CipCommonServices.GetAttributeSingle,
            path: Buffer.from([0x20, 0x01, 0x24, 0x01]),
            data: Buffer.from([0xAA])
        });

        await assert.rejects(
            () => session.sendUnconnected(req1),
            /transaction timed out/
        );

        // Now server sends the late reply for Req 1
        assert(delayedReqMsg !== null);
        const lateCipResp = buildResponse({
            service: CipCommonServices.GetAttributeSingle,
            generalStatus: CipGeneralStatus.Success,
            data: Buffer.from([0xAA])
        });
        clientSocket.write(buildSendRRData(0x9999, lateCipResp, { senderContext: delayedReqMsg.header.senderContext }));

        await new Promise((r) => setTimeout(r, 50));

        // Req 2: should succeed cleanly with 0xBB and not be corrupted by Req 1's late response
        const req2 = buildRequest({
            service: CipCommonServices.GetAttributeSingle,
            path: Buffer.from([0x20, 0x01, 0x24, 0x01]),
            data: Buffer.from([0xBB])
        });
        const res2 = await session.sendUnconnected(req2);
        assert.deepStrictEqual(res2.data, Buffer.from([0xBB]));

        await session.close();
    });
});
