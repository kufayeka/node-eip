'use strict';

const net = require('net');
const EventEmitter = require('events');
const { decodeMessage } = require('./encapsulation/header');
const { buildRegisterSessionRequest, readRegisterSessionResponse, buildUnRegisterSessionRequest } = require('./encapsulation/session');
const { buildSendRRData, readSendRRDataResponse } = require('./encapsulation/rrdata');
const { buildSendUnitData, readSendUnitDataResponse } = require('./encapsulation/unitdata');
const { buildNopRequest } = require('./encapsulation/services');
const { buildRequest: buildCipRequest, parseResponse: parseCipResponse } = require('./cip/message-router');
const {
    ConnectionManagerServices,
    connectionManagerPath,
    buildForwardOpenRequest,
    parseForwardOpenResponse,
    buildLargeForwardOpenRequest,
    parseLargeForwardOpenResponse,
    buildForwardCloseRequest,
    parseForwardCloseResponse,
    ForwardOpenExtendedStatus
} = require('./cip/connection-manager');
const { EIP_ENCAPSULATION_PORT, CipGeneralStatus } = require('./constants');
const { IOConnection } = require('./cip/io-connection');

/**
 * Formal EtherNet/IP session lifecycle states per ODVA specifications.
 */
const SessionState = Object.freeze({
    Disconnected: 'DISCONNECTED',
    Connecting: 'CONNECTING',
    Registered: 'REGISTERED',
    Active: 'ACTIVE',
    Destroyed: 'DESTROYED'
});

/**
 * Low-level EtherNet/IP TCP session client — vendor-neutral: RegisterSession,
 * UnRegisterSession, unconnected explicit messaging (SendRRData), and NOP keepalive
 * are the same for any ODVA-conformant device.
 *
 * Implements session state machine, FIFO queue backpressure, NOP heartbeat,
 * and automatic reconnect engine.
 */
class EIPSession extends EventEmitter {
    constructor(host, {
        port = EIP_ENCAPSULATION_PORT,
        timeoutMs = 5000,
        maxInFlight = 1,
        autoReconnect = false,
        reconnectDelayMs = 1000,
        maxReconnectAttempts = 10,
        heartbeatIntervalMs = 0,
        heartbeatMethod = 'identity'
    } = {}) {
        super();
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.maxInFlight = maxInFlight;
        this.autoReconnect = autoReconnect;
        this.reconnectDelayMs = reconnectDelayMs;
        this.maxReconnectAttempts = maxReconnectAttempts;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.heartbeatMethod = heartbeatMethod;

        this.state = SessionState.Disconnected;
        this.socket = null;
        this.sessionHandle = 0;
        this._buffer = Buffer.alloc(0);
        this._contextSeq = 1n;
        this._pending = new Map();
        this._queue = [];
        this._heartbeatTimer = null;
        this._reconnectTimer = null;
        this._reconnectAttempts = 0;
        this._reconnecting = false;
    }

    _setState(newState) {
        if (this.state === newState) return;
        const oldState = this.state;
        this.state = newState;
        this.emit('stateChange', { oldState, newState });
        this.emit(newState.toLowerCase());
    }

    _nextSenderContext() {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64LE(this._contextSeq++, 0);
        return buf;
    }

    /** Opens the TCP connection and performs the RegisterSession handshake. */
    connect() {
        if (this.state === SessionState.Destroyed) {
            return Promise.reject(new Error('EIPSession.connect: session has been destroyed — create a new instance'));
        }
        if (this.sessionHandle && (this.state === SessionState.Registered || this.state === SessionState.Active)) {
            return Promise.resolve({ sessionHandle: this.sessionHandle });
        }

        this._setState(SessionState.Connecting);

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            this.socket = socket;

            let connectTimer = setTimeout(() => {
                socket.destroy();
                this._setState(SessionState.Disconnected);
                reject(new Error(`EIPSession.connect: timed out connecting to ${this.host}:${this.port}`));
            }, this.timeoutMs);

            socket.on('error', (err) => {
                clearTimeout(connectTimer);
                this.emit('error', err);
                if (!this._reconnecting) {
                    this._rejectAllPending(err);
                }
            });

            socket.on('close', () => {
                clearTimeout(connectTimer);
                const wasConnected = Boolean(this.sessionHandle);
                this.sessionHandle = 0;
                this._stopHeartbeat();

                if (this.state === SessionState.Destroyed) {
                    this._rejectAllPending(new Error('EIPSession: socket closed'));
                    return;
                }

                if (this.autoReconnect && wasConnected) {
                    this._scheduleReconnect();
                } else {
                    this._setState(SessionState.Disconnected);
                    this._rejectAllPending(new Error('EIPSession: socket closed'));
                }
            });

            socket.on('data', (chunk) => this._onData(chunk));

            socket.connect(this.port, this.host, () => {
                clearTimeout(connectTimer);
                this._transact((senderContext) => buildRegisterSessionRequest({ senderContext }))
                    .then((msg) => {
                        const registered = readRegisterSessionResponse(msg);
                        this.sessionHandle = registered.sessionHandle;
                        this._reconnectAttempts = 0;
                        this._setState(SessionState.Registered);
                        this._startHeartbeat();
                        resolve(registered);
                    })
                    .catch((err) => {
                        socket.destroy();
                        this._setState(SessionState.Disconnected);
                        reject(err);
                    });
            });
        });
    }

    _scheduleReconnect() {
        if (this._reconnecting || this.state === SessionState.Destroyed) return;
        this._reconnecting = true;
        this._setState(SessionState.Connecting);

        const attempt = ++this._reconnectAttempts;
        if (attempt > this.maxReconnectAttempts) {
            this._reconnecting = false;
            this._setState(SessionState.Disconnected);
            this._rejectAllPending(new Error(`EIPSession: auto-reconnect failed after ${this.maxReconnectAttempts} attempts`));
            return;
        }

        const delay = Math.min(this.reconnectDelayMs * Math.pow(1.3, attempt - 1), 30000);
        this.emit('reconnecting', { attempt, maxAttempts: this.maxReconnectAttempts, delay });

        this._reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
                this._reconnecting = false;
                this._pumpQueue();
            } catch {
                this._reconnecting = false;
                this._scheduleReconnect();
            }
        }, delay);
        // Deliberately NOT unref()'d, unlike the heartbeat timer below. unref() tells Node "don't
        // let this be a reason for the process to stay alive" -- correct for a background
        // heartbeat ping nobody's waiting on, but wrong for a reconnect attempt that autoReconnect
        // callers are, definitionally, relying on to eventually restore the session. Found via a
        // real long-running client (a PLC I/O loop) that silently exited mid-reconnect with no
        // error at all: once every currently in-flight _transact() had already timed out/rejected
        // (each had its OWN ref'd timer, which is why those specific failures WERE visible) and
        // nothing else happened to be ref'd at that exact instant, Node's event loop saw nothing
        // left to wait for -- the unref'd reconnect timer didn't count -- and exited the whole
        // process before that timer ever got to fire, abandoning a reconnect that was still
        // actively in progress (mid-attempt, well under maxReconnectAttempts).
    }

    /**
     * Sends an Encapsulation NOP (0x0000) message per CIP Vol 2 Section 2-3.1.
     * Can be used as a heartbeat or connectivity test.
     */
    async sendNop({ data = Buffer.alloc(0) } = {}) {
        if (!this.socket || (!this.sessionHandle && this.state !== SessionState.Registered && this.state !== SessionState.Active)) {
            throw new Error('EIPSession.sendNop: no active session — call connect() first');
        }
        const msg = await this._transact((senderContext) =>
            buildNopRequest({ sessionHandle: this.sessionHandle, senderContext, data })
        );
        return {
            ok: msg.header.status === 0,
            status: msg.header.status,
            data: msg.data
        };
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        if (this.heartbeatIntervalMs <= 0) return;

        this._heartbeatTimer = setInterval(async () => {
            if (this.state !== SessionState.Registered && this.state !== SessionState.Active) return;
            try {
                if (this.heartbeatMethod === 'nop') {
                    await this.sendNop();
                } else {
                    const path = Buffer.from([0x20, 0x01, 0x24, 0x01, 0x30, 0x01]);
                    const req = buildCipRequest({ service: 0x0E, path });
                    await this.sendUnconnected(req);
                }
            } catch (err) {
                if (this.socket && !this.socket.destroyed) {
                    this.socket.destroy(err);
                }
            }
        }, this.heartbeatIntervalMs);
        if (this._heartbeatTimer.unref) this._heartbeatTimer.unref();
    }

    _stopHeartbeat() {
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }

    /**
     * Sends one unconnected CIP request (Message Router service call) via
     * SendRRData and returns the decoded CIP response
     * ({ service, generalStatus, additionalStatus, data }).
     *
     * @param {Buffer} cipRequest - built with cip/message-router.js's buildRequest()
     */
    async sendUnconnected(cipRequest, { timeoutSec = 0 } = {}) {
        if (!this.sessionHandle && !this._reconnecting) {
            throw new Error('EIPSession.sendUnconnected: no active session — call connect() first');
        }
        const msg = await this._transact((senderContext) =>
            buildSendRRData(this.sessionHandle, cipRequest, { timeoutSec, senderContext })
        );
        const { cipResponse } = readSendRRDataResponse(msg);
        return parseCipResponse(cipResponse);
    }

    /**
     * Sends a Connected Explicit Message (Class 3, SendUnitData 0x0070) over a connection already
     * established by openConnection() — CIP Vol 2 §2-4.9. This is what the README's own compliance
     * table long claimed as a plain "✅ SendUnitData (Connected Explicit Messaging)" without
     * qualification, but this driver could previously only RECEIVE and answer one (adapter.js's
     * own SendUnitData case) — a Scanner had no way to ORIGINATE one at all, only the unconnected
     * SendRRData path via sendUnconnected() above. Found via an ODVA compliance audit.
     *
     * @param {object} connection - Return value of openConnection() to a Class 3 explicit
     *   connection (see openExplicitConnection() below — a connectionPath with no connection
     *   points and no I/O data, matching connection-handler.js's own `isExplicit` classification).
     * @param {Buffer} cipRequest - Raw CIP request bytes (message-router.js's buildRequest()).
     */
    async sendConnected(connection, cipRequest) {
        if (!connection || connection.otNetworkConnectionId === undefined) {
            throw new TypeError('EIPSession.sendConnected: requires a connection object returned by openConnection() to a Class 3 explicit connection');
        }
        if (!this.sessionHandle && !this._reconnecting) {
            throw new Error('EIPSession.sendConnected: no active session — call connect() first');
        }
        connection._sendUnitDataSeq = ((connection._sendUnitDataSeq || 0) + 1) & 0xffff || 1;
        const seq = connection._sendUnitDataSeq;
        const msg = await this._transact((senderContext) =>
            buildSendUnitData(this.sessionHandle, connection.otNetworkConnectionId, seq, cipRequest, { senderContext })
        );
        const { cipResponse } = readSendUnitDataResponse(msg);
        return parseCipResponse(cipResponse);
    }

    /**
     * Establishes a Class 1/3 connection via Forward_Open (0x54) or Large_Forward_Open (0x5B).
     * Automatically handles 32-bit connection parameters for buffers > 505 bytes and provides
     * transparent fallback if the target device rejects 0x5B.
     *
     * @param {object} forwardOpenParams - parameters per buildForwardOpenRequest / buildLargeForwardOpenRequest
     * @param {object} [opts]
     * @param {boolean} [opts.allowFallback=true] - fallback from 0x5B to 0x54 if 0x5B unsupported
     * @param {boolean} [opts.useLarge=false] - force Large Forward Open (0x5B)
     */
    async openConnection(forwardOpenParams, { allowFallback = true, useLarge = false } = {}) {
        const isLarge = useLarge ||
            (forwardOpenParams.otSize !== undefined && forwardOpenParams.otSize > 505) ||
            (forwardOpenParams.toSize !== undefined && forwardOpenParams.toSize > 505);

        if (isLarge) {
            const built = buildLargeForwardOpenRequest(forwardOpenParams);
            const request = buildCipRequest({
                service: ConnectionManagerServices.LargeForwardOpen,
                path: connectionManagerPath(),
                data: built.data
            });
            const response = await this.sendUnconnected(request);

            const isUnsupported = response.generalStatus === CipGeneralStatus.ServiceNotSupported ||
                (response.generalStatus === CipGeneralStatus.ConnectionFailure &&
                 response.additionalStatus[0] === 0x011a);

            if (isUnsupported && allowFallback &&
                (forwardOpenParams.otSize <= 505 && forwardOpenParams.toSize <= 505)) {
                return this.openConnection(forwardOpenParams, { allowFallback: false, useLarge: false });
            }

            if (response.generalStatus !== CipGeneralStatus.Success) {
                throw this._forwardOpenError(response, 'Large_Forward_Open');
            }

            const opened = parseLargeForwardOpenResponse(response.data);
            return {
                ...opened,
                connectionPath: forwardOpenParams.connectionPath,
                connectionSerialNumber: built.connectionSerialNumber,
                originatorVendorId: built.originatorVendorId,
                originatorSerialNumber: built.originatorSerialNumber,
                isLarge: true
            };
        }

        const built = buildForwardOpenRequest(forwardOpenParams);
        const request = buildCipRequest({
            service: ConnectionManagerServices.ForwardOpen,
            path: connectionManagerPath(),
            data: built.data
        });
        const response = await this.sendUnconnected(request);

        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw this._forwardOpenError(response, 'Forward_Open');
        }

        const opened = parseForwardOpenResponse(response.data);
        return {
            ...opened,
            connectionPath: forwardOpenParams.connectionPath,
            connectionSerialNumber: built.connectionSerialNumber,
            originatorVendorId: built.originatorVendorId,
            originatorSerialNumber: built.originatorSerialNumber,
            isLarge: false
        };
    }

    /** Explicitly establishes a connection using Large_Forward_Open (0x5B). */
    async openLargeConnection(forwardOpenParams) {
        return this.openConnection(forwardOpenParams, { useLarge: true, allowFallback: false });
    }

    /** Tears down a connection previously returned by openConnection(). */
    async closeConnection(connection) {
        const data = buildForwardCloseRequest({
            connectionPath: connection.connectionPath,
            connectionSerialNumber: connection.connectionSerialNumber,
            originatorVendorId: connection.originatorVendorId,
            originatorSerialNumber: connection.originatorSerialNumber
        });
        const request = buildCipRequest({ service: ConnectionManagerServices.ForwardClose, path: connectionManagerPath(), data });
        const response = await this.sendUnconnected(request);

        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw this._forwardOpenError(response, 'Forward_Close');
        }
        return parseForwardCloseResponse(response.data);
    }

    /**
     * Creates and configures a Class 1 Real-Time IOConnection (§14, §15, §16, §17)
     * bound to a connection handle previously returned by openConnection() or openLargeConnection().
     *
     * @param {object} connection - Return value of openConnection() / openLargeConnection()
     * @param {object} [options] - Additional IOConnection options (useRunIdleHeader, initialOutputData, etc.)
     * @returns {IOConnection}
     */
    createIoConnection(connection, options = {}) {
        if (!connection || connection.otNetworkConnectionId === undefined || connection.toNetworkConnectionId === undefined) {
            throw new Error('createIoConnection: requires a valid connection object returned by openConnection()');
        }
        const rpiMs = options.rpiMs || (connection.toApiUs ? Math.max(1, Math.round(connection.toApiUs / 1000)) : 20);
        return new IOConnection({
            host: this.host,
            otConnectionId: connection.otNetworkConnectionId,
            toConnectionId: connection.toNetworkConnectionId,
            rpiMs,
            ...options
        });
    }

    _forwardOpenError(response, label = 'Forward_Open') {
        const extStatus = response.additionalStatus[0];
        const desc = extStatus !== undefined ? ForwardOpenExtendedStatus[extStatus] : undefined;
        const extPart = extStatus !== undefined ? `, extended status 0x${extStatus.toString(16)}${desc ? ` (${desc})` : ''}` : '';
        return new Error(`${label} failed: general status 0x${response.generalStatus.toString(16)}${extPart}`);
    }

    /** Sends UnRegisterSession (no reply expected) and terminates the session. */
    async close() {
        this._setState(SessionState.Destroyed);
        this._stopHeartbeat();
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }

        if (this.socket && this.sessionHandle) {
            try {
                this.socket.write(buildUnRegisterSessionRequest(this.sessionHandle));
            } catch {
                // socket may already be going away
            }
        }
        this.sessionHandle = 0;
        this._rejectAllPending(new Error('EIPSession: closed'));
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    /** Writes `message` and resolves with the next full decoded encapsulation message matching its Sender Context. */
    _transact(builderOrMessage) {
        return new Promise((resolve, reject) => {
            this._queue.push({ builderOrMessage, resolve, reject });
            this._pumpQueue();
        });
    }

    _pumpQueue() {
        if (!this.socket || this.socket.destroyed) return;
        while (this._pending.size < this.maxInFlight && this._queue.length > 0) {
            const item = this._queue.shift();
            this._sendPending(item);
        }
    }

    _sendPending(item) {
        const senderContext = this._nextSenderContext();
        const key = senderContext.toString('hex');

        let message;
        if (typeof item.builderOrMessage === 'function') {
            try {
                message = item.builderOrMessage(senderContext);
            } catch (err) {
                this._pumpQueue();
                return item.reject(err);
            }
        } else if (Buffer.isBuffer(item.builderOrMessage)) {
            message = Buffer.from(item.builderOrMessage);
            if (message.length >= 20) {
                senderContext.copy(message, 12);
            }
        } else {
            this._pumpQueue();
            return item.reject(new TypeError('EIPSession._transact: expected message builder function or Buffer'));
        }

        const timer = setTimeout(() => {
            this._pending.delete(key);
            this._pumpQueue();
            item.reject(new Error('EIPSession: transaction timed out waiting for a reply'));
        }, this.timeoutMs);

        this._pending.set(key, {
            timer,
            resolve: (msg) => {
                this._pumpQueue();
                item.resolve(msg);
            },
            reject: (err) => {
                this._pumpQueue();
                item.reject(err);
            }
        });

        try {
            this.socket.write(message);
        } catch (err) {
            clearTimeout(timer);
            this._pending.delete(key);
            this._pumpQueue();
            item.reject(err);
        }
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        for (;;) {
            const msg = decodeMessage(this._buffer);
            if (!msg) {
                return; // keep buffering, TCP may split the response
            }
            this._buffer = this._buffer.subarray(msg.bytesConsumed);
            const key = msg.header.senderContext.toString('hex');
            const entry = this._pending.get(key);
            if (entry) {
                this._pending.delete(key);
                clearTimeout(entry.timer);
                entry.resolve(msg);
            }
        }
    }

    _rejectAllPending(err) {
        const queued = this._queue.splice(0, this._queue.length);
        for (const item of queued) {
            item.reject(err);
        }
        const pending = Array.from(this._pending.values());
        this._pending.clear();
        for (const entry of pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
    }
}

module.exports = { EIPSession, SessionState };
