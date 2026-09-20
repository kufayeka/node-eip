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

        it('relays "reconnecting" events at the Scanner level (regression: used to be dead code)', async function () {
            // Scanner used to be a plain `class Scanner {}`, not an EventEmitter at all -- its
            // constructor's own event-relay code (`this.emit ? this.emit(...) : null`) was
            // permanently dead (this.emit was always undefined), so scanner.on('error', ...) /
            // scanner.on('reconnecting', ...) silently did nothing: a caller had no way to
            // observe connection errors or reconnect progress at the Scanner/Device level, only
            // by reaching into scanner.session directly (as the sibling test above does). Fixed
            // by making Scanner extend EventEmitter for real -- see the next test for the 'error'
            // side of this (crash prevention), verified separately since a real socket teardown
            // doesn't reliably produce a client-side 'error' event (vs. just 'close') to assert on.
            const scanner = new Scanner('127.0.0.1', {
                port: TEST_PORT,
                autoReconnect: true,
                reconnectDelayMs: 50,
                maxReconnectAttempts: 5
            });
            await scanner.connect();
            const firstHandle = scanner.session.sessionHandle;

            let sawReconnecting = false;
            scanner.on('reconnecting', () => { sawReconnecting = true; });

            const serverSocket = adapter._sessions.get(firstHandle);
            assert.ok(serverSocket, 'Server-side socket found');
            serverSocket.destroy();

            await new Promise((resolve) => setTimeout(resolve, 200));

            assert.strictEqual(sawReconnecting, true, 'scanner.on("reconnecting", ...) must now actually fire');
            assert.strictEqual(scanner.connected, true, 'Scanner re-established connection');

            await scanner.disconnect();
        });

        it('relays "error" events at the Scanner level, from the underlying session (regression)', function () {
            const scanner = new Scanner('127.0.0.1', { port: TEST_PORT, autoReconnect: false });
            let sawError = null;
            scanner.on('error', (e) => { sawError = e; });
            scanner.session.emit('error', new Error('simulated'));
            assert.ok(sawError, 'scanner.on("error", ...) must now actually receive the error');
            assert.strictEqual(sawError.message, 'simulated');
        });

        it('keeps the process alive during a reconnect attempt (regression: the reconnect timer used to be unref()\'d)', async function () {
            // unref() tells Node "don't count this timer as a reason for the process to stay
            // alive" -- correct for the heartbeat timer (a background ping nobody's specifically
            // waiting on), but wrong for a reconnect attempt: a caller that enabled autoReconnect
            // is, definitionally, relying on the process staying alive long enough for it to
            // succeed. Found via a real long-running PLC I/O loop that exited silently (no error,
            // no exception) mid-reconnect: once every in-flight request had already timed out via
            // its OWN ref'd timer and nothing else happened to be ref'd at that instant, Node saw
            // nothing left to wait for -- the unref'd reconnect timer didn't count -- and exited
            // before that timer ever got to fire, well under maxReconnectAttempts.
            const scanner = new Scanner('127.0.0.1', {
                port: TEST_PORT,
                autoReconnect: true,
                reconnectDelayMs: 5000, // long enough that the timer is still pending when checked
                maxReconnectAttempts: 5
            });
            await scanner.connect();
            const firstHandle = scanner.session.sessionHandle;

            const serverSocket = adapter._sessions.get(firstHandle);
            assert.ok(serverSocket, 'Server-side socket found');
            serverSocket.destroy();

            await new Promise((resolve) => setTimeout(resolve, 100));

            assert.ok(scanner.session._reconnectTimer, 'a reconnect timer must be scheduled');
            assert.strictEqual(
                scanner.session._reconnectTimer.hasRef(),
                true,
                'the reconnect timer must be ref\'d (NOT unref()\'d) so it alone can keep the process alive during a pending reconnect'
            );

            await scanner.disconnect();
        });

        it('does not throw when a connection error occurs and NOTHING listens for "error" at all (the actual regression)', async function () {
            const scanner = new Scanner('127.0.0.1', { port: TEST_PORT, autoReconnect: false });
            await scanner.connect();
            // No scanner.on('error', ...) attached at all -- this must not crash the process.
            assert.doesNotThrow(() => {
                scanner.session.emit('error', new Error('simulated, nobody is listening at the Scanner level'));
            });
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

    describe('Encapsulation Session Inactivity Timeout (CIP Vol 2 §2-4.6, TCP/IP Interface Object Attribute 13) — regression: was never enforced at all', function () {
        it('closes a registered session that goes silent for longer than inactivityTimeoutSec', async function () {
            const timeoutAdapter = new EIPAdapter({ port: TEST_PORT + 1, address: '127.0.0.1', tcpIp: { inactivityTimeoutSec: 0.05 } }); // 50ms
            await timeoutAdapter.start();
            try {
                const session = new EIPSession('127.0.0.1', { port: TEST_PORT + 1 });
                await session.connect();
                assert.strictEqual(session.state, SessionState.Registered);

                const closed = new Promise((resolve) => session.socket.once('close', resolve));
                // Send nothing at all -- not even a NOP -- and wait comfortably past the 50ms limit.
                await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('socket was not closed by the server within 500ms')), 500))]);
            } finally {
                await timeoutAdapter.stop();
            }
        });

        it('does NOT close a session kept alive by periodic traffic (NOP) within the timeout window', async function () {
            const timeoutAdapter = new EIPAdapter({ port: TEST_PORT + 2, address: '127.0.0.1', tcpIp: { inactivityTimeoutSec: 0.1 } }); // 100ms
            await timeoutAdapter.start();
            try {
                const session = new EIPSession('127.0.0.1', { port: TEST_PORT + 2 });
                await session.connect();

                const pinger = setInterval(() => { session.sendNop().catch(() => {}); }, 30); // well under 100ms
                await new Promise((resolve) => setTimeout(resolve, 300));
                clearInterval(pinger);

                assert.strictEqual(session.state, SessionState.Registered, 'a session with ongoing traffic must not be inactivity-closed');
                await session.close();
            } finally {
                await timeoutAdapter.stop();
            }
        });

        it('inactivityTimeoutSec = 0 disables the timeout entirely', async function () {
            const timeoutAdapter = new EIPAdapter({ port: TEST_PORT + 3, address: '127.0.0.1', tcpIp: { inactivityTimeoutSec: 0 } });
            await timeoutAdapter.start();
            try {
                const session = new EIPSession('127.0.0.1', { port: TEST_PORT + 3 });
                await session.connect();
                await new Promise((resolve) => setTimeout(resolve, 200)); // no traffic at all
                assert.strictEqual(session.state, SessionState.Registered, 'inactivityTimeoutSec=0 must mean "never time out"');
                await session.close();
            } finally {
                await timeoutAdapter.stop();
            }
        });
    });
});
