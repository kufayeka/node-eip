'use strict';

const net = require('net');
const { decodeMessage } = require('./encapsulation/header');
const { buildRegisterSessionRequest, readRegisterSessionResponse, buildUnRegisterSessionRequest } = require('./encapsulation/session');
const { buildSendRRData, readSendRRDataResponse } = require('./encapsulation/rrdata');
const { buildRequest: buildCipRequest, parseResponse: parseCipResponse } = require('./cip/message-router');
const {
    ConnectionManagerServices,
    connectionManagerPath,
    buildForwardOpenRequest,
    parseForwardOpenResponse,
    buildForwardCloseRequest,
    parseForwardCloseResponse,
    ForwardOpenExtendedStatus
} = require('./cip/connection-manager');
const { EIP_ENCAPSULATION_PORT, CipGeneralStatus } = require('./constants');

/**
 * Low-level EtherNet/IP TCP session client — vendor-neutral: RegisterSession,
 * UnRegisterSession, and unconnected explicit messaging (SendRRData) are the
 * same for any ODVA-conformant device; this class has no Rockwell/Logix
 * awareness whatsoever.
 *
 * One request is in flight at a time (a simple FIFO queue of pending
 * transactions) — sufficient for explicit messaging, which is inherently
 * request/response. Implicit (I/O) connections are a separate mechanism
 * (Phase 2/3, connection-manager.js) layered on top later.
 */
class EIPSession {
    constructor(host, { port = EIP_ENCAPSULATION_PORT, timeoutMs = 5000 } = {}) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.socket = null;
        this.sessionHandle = 0;
        this._buffer = Buffer.alloc(0);
        this._pending = [];
    }

    /** Opens the TCP connection and performs the RegisterSession handshake. */
    connect() {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            this.socket = socket;

            socket.on('error', (err) => this._rejectAllPending(err));
            socket.on('close', () => {
                this.sessionHandle = 0;
                this._rejectAllPending(new Error('EIPSession: socket closed'));
            });
            socket.on('data', (chunk) => this._onData(chunk));

            const connectTimer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`EIPSession.connect: timed out connecting to ${this.host}:${this.port}`));
            }, this.timeoutMs);

            socket.connect(this.port, this.host, () => {
                clearTimeout(connectTimer);
                this._transact(buildRegisterSessionRequest())
                    .then((msg) => {
                        const registered = readRegisterSessionResponse(msg);
                        this.sessionHandle = registered.sessionHandle;
                        resolve(registered);
                    })
                    .catch(reject);
            });
        });
    }

    /**
     * Sends one unconnected CIP request (Message Router service call) via
     * SendRRData and returns the decoded CIP response
     * ({ service, generalStatus, additionalStatus, data }).
     *
     * @param {Buffer} cipRequest - built with cip/message-router.js's buildRequest()
     */
    async sendUnconnected(cipRequest, { timeoutSec = 0 } = {}) {
        if (!this.sessionHandle) {
            throw new Error('EIPSession.sendUnconnected: no active session — call connect() first');
        }
        const msg = await this._transact(buildSendRRData(this.sessionHandle, cipRequest, { timeoutSec }));
        const { cipResponse } = readSendRRDataResponse(msg);
        return parseCipResponse(cipResponse);
    }

    /**
     * Establishes a Class 1/3 connection via Forward_Open (Connection
     * Manager, CIP Vol 1 3-5.5) — always sent unconnected via SendRRData,
     * regardless of what kind of connection is being requested. On success,
     * returns everything needed later to Forward_Close it, plus the
     * negotiated O->T/T->O Actual Packet Intervals.
     *
     * @param {object} forwardOpenParams - see cip/connection-manager.js's buildForwardOpenRequest()
     */
    async openConnection(forwardOpenParams) {
        const built = buildForwardOpenRequest(forwardOpenParams);
        const request = buildCipRequest({ service: ConnectionManagerServices.ForwardOpen, path: connectionManagerPath(), data: built.data });
        const response = await this.sendUnconnected(request);

        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw this._forwardOpenError(response);
        }

        const opened = parseForwardOpenResponse(response.data);
        return {
            ...opened,
            connectionPath: forwardOpenParams.connectionPath,
            connectionSerialNumber: built.connectionSerialNumber,
            originatorVendorId: built.originatorVendorId,
            originatorSerialNumber: built.originatorSerialNumber
        };
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

    _forwardOpenError(response, label = 'Forward_Open') {
        const extStatus = response.additionalStatus[0];
        const desc = extStatus !== undefined ? ForwardOpenExtendedStatus[extStatus] : undefined;
        const extPart = extStatus !== undefined ? `, extended status 0x${extStatus.toString(16)}${desc ? ` (${desc})` : ''}` : '';
        return new Error(`${label} failed: general status 0x${response.generalStatus.toString(16)}${extPart}`);
    }

    /** Sends UnRegisterSession (no reply expected) and closes the socket. */
    async close() {
        if (this.socket && this.sessionHandle) {
            try {
                this.socket.write(buildUnRegisterSessionRequest(this.sessionHandle));
            } catch {
                // socket may already be going away — nothing to do
            }
        }
        this.sessionHandle = 0;
        this._rejectAllPending(new Error('EIPSession: closed'));
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }

    /** Writes `message` and resolves with the next full decoded encapsulation message. */
    _transact(message) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this._pending.indexOf(entry);
                if (idx !== -1) this._pending.splice(idx, 1);
                reject(new Error('EIPSession: transaction timed out waiting for a reply'));
            }, this.timeoutMs);

            const entry = {
                resolve: (msg) => { clearTimeout(timer); resolve(msg); },
                reject: (err) => { clearTimeout(timer); reject(err); }
            };
            this._pending.push(entry);
            this.socket.write(message);
        });
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        for (;;) {
            const msg = decodeMessage(this._buffer);
            if (!msg) {
                return; // keep buffering, TCP may split the response
            }
            this._buffer = this._buffer.subarray(msg.bytesConsumed);
            const entry = this._pending.shift();
            if (entry) {
                entry.resolve(msg);
            }
            // else: unsolicited message (shouldn't happen for explicit-only
            // usage) — drop it and keep processing the rest of the buffer.
        }
    }

    _rejectAllPending(err) {
        const pending = this._pending.splice(0, this._pending.length);
        for (const entry of pending) {
            entry.reject(err);
        }
    }
}

module.exports = { EIPSession };
