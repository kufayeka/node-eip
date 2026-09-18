'use strict';

const assert = require('assert');
const net = require('net');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { EIPSession, SessionState } = require('../src/client');
const { decodeMessage } = require('../src/encapsulation/header');
const { buildSendRRData } = require('../src/encapsulation/rrdata');
const { buildRequest } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const { EncapsulationStatus, CipCommonServices } = require('../src/constants');

describe('Session Robustness & Reconnect Engine (§2.2, §38)', function () {
    let adapter;
    const TEST_PORT = 45819;

    beforeEach(async function () {
        adapter = new EIPAdapter({ port: TEST_PORT, address: '127.0.0.1' });
        await adapter.start();
    });

    afterEach(async function () {
        if (adapter) await adapter.stop().catch(() => {});
    });

    describe('State Machine & NOP Keepalive', function () {
        it('tracks session states correctly from DISCONNECTED to REGISTERED and DESTROYED', async function () {
            const session = new EIPSession('127.0.0.1', { port: TEST_PORT });
            assert.strictEqual(session.state, SessionState.Disconnected);

            const states = [];
            session.on('stateChange', ({ newState }) => states.push(newState));

            await session.connect();
            assert.strictEqual(session.state, SessionState.Registered);

            await session.close();
            assert.strictEqual(session.state, SessionState.Destroyed);

            assert.deepStrictEqual(states, [
                SessionState.Connecting,
                SessionState.Registered,
                SessionState.Destroyed
            ]);
        });

        it('sends Encapsulation NOP (0x0000) and receives echo response', async function () {
            const scanner = new Scanner('127.0.0.1', { port: TEST_PORT });
            await scanner.connect();

            const testPayload = Buffer.from('hello-eip-nop-test');
            const res = await scanner.sendNop({ data: testPayload });

            assert.strictEqual(res.ok, true);
            assert.strictEqual(res.status, 0);
            assert.deepStrictEqual(res.data, testPayload);

            const pingNopOk = await scanner.ping({ useNop: true });
            assert.strictEqual(pingNopOk, true);

            const pingIdentityOk = await scanner.ping();
            assert.strictEqual(pingIdentityOk, true);

            await scanner.disconnect();
        });
    });

    describe('Auto-Reconnect Engine', function () {
        it('automatically reconnects when target drops TCP connection and resumes commands', async function () {
            const scanner = new Scanner('127.0.0.1', {
                port: TEST_PORT,
                autoReconnect: true,
                reconnectDelayMs: 50,
                maxReconnectAttempts: 5
            });

            await scanner.connect();
            assert.strictEqual(scanner.connected, true);
            const firstHandle = scanner.session.sessionHandle;

            let reconnectEventSeen = false;
            scanner.session.on('reconnecting', () => {
                reconnectEventSeen = true;
            });

            // Simulate remote dropping the connection by destroying the socket on the adapter
            const serverSocket = adapter._sessions.get(firstHandle);
            assert.ok(serverSocket, 'Server-side socket found');
            serverSocket.destroy();

            // Wait briefly for auto-reconnect to execute
            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.strictEqual(reconnectEventSeen, true, 'Reconnecting event was emitted');
            assert.strictEqual(scanner.connected, true, 'Scanner re-established connection');
            assert.notStrictEqual(scanner.session.sessionHandle, 0);

            // Execute an explicit command after reconnection
            const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
            assert.ok(vendorId.length >= 2);

            await scanner.disconnect();
        });
    });

    describe('Session handle validation on SendRRData/SendUnitData (ported from OpENer CheckRegisteredSessions)', function () {
        function rawConnect() {
            return new Promise((resolve, reject) => {
                const socket = new net.Socket();
                socket.once('error', reject);
                socket.connect(TEST_PORT, '127.0.0.1', () => resolve(socket));
            });
        }

        function nextMessage(socket) {
            return new Promise((resolve) => {
                let buf = Buffer.alloc(0);
                socket.on('data', (chunk) => {
                    buf = Buffer.concat([buf, chunk]);
                    const msg = decodeMessage(buf);
                    if (msg) resolve(msg);
                });
            });
        }

        it('rejects SendRRData carrying a session handle that was never registered', async function () {
            const socket = await rawConnect();
            const cipRequest = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: 0x01, instance: 1, attribute: 1 }) });
            const bogusSessionHandle = 0xdeadbeef;
            socket.write(buildSendRRData(bogusSessionHandle, cipRequest));

            const { header } = await nextMessage(socket);
            assert.strictEqual(header.status, EncapsulationStatus.InvalidSessionHandle);
            socket.destroy();
        });

        it('accepts SendRRData once the session handle has actually been registered', async function () {
            const scanner = new Scanner('127.0.0.1', { port: TEST_PORT });
            await scanner.connect();
            const data = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
            assert.ok(data.length >= 2); // real response, not an error — session was valid
            await scanner.disconnect();
        });

        it('rejects a session handle that WAS registered but on a different, already-closed connection', async function () {
            const scanner = new Scanner('127.0.0.1', { port: TEST_PORT });
            await scanner.connect();
            const staleHandle = scanner.session.sessionHandle;
            await scanner.disconnect(); // closes the socket -> adapter deletes the session

            const socket = await rawConnect(); // a brand new, never-registered connection
            const cipRequest = buildRequest({ service: CipCommonServices.GetAttributeSingle, path: encodeEPath({ classId: 0x01, instance: 1, attribute: 1 }) });
            socket.write(buildSendRRData(staleHandle, cipRequest));

            const { header } = await nextMessage(socket);
            assert.strictEqual(header.status, EncapsulationStatus.InvalidSessionHandle);
            socket.destroy();
        });
    });
});
