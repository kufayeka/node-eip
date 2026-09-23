'use strict';

/**
 * Class 0/1 (implicit/I-O) cyclic data datagram — CIP Vol 1 Section 3-6.4 & Vol 2 Section 3-4.
 * Once Forward_Open / Large_Forward_Open establishes a connection, the Target starts producing
 * cyclic data unprompted every RPI, as a raw UDP datagram to port 2222 (`EIP_IO_UDP_PORT`).
 * The Originator also sends its own O->T datagrams at the negotiated RPI to the same port.
 *
 * Wire format is a 2-item Common Packet Format payload:
 *   Sequenced Address Item (type 0x8002, 8 bytes):
 *     Connection ID   UDINT (4 bytes) - chosen by receiver
 *     Sequence Number  UDINT (4 bytes) - 32-bit counter incremented per datagram (encapsulation-
 *       layer duplicate/reorder detection -- distinct from the in-band Sequence Count below)
 *   Connected Transport Data Item (type 0x00B1, N bytes), per ODVA CIP and the Family of CIP
 *   Networks (PUB00123R1) §3.3.12.2 Figure 39:
 *     16-bit Sequence Count (2 bytes LE) -- mandatory for Transport Class 1 (the only class this
 *       project negotiates; see connection-manager.js's TransportTrigger presets), absent only for
 *       Class 0 or CIP Safety connections
 *     Optional 32-bit Run/Idle Header (4 bytes LE) when configured -- O->T only, never T->O
 *       (CIP Vol 1 §3-4.5.1.2):
 *       bit 0: Run (1) / Idle (0)
 *       bits 1..31: Reserved (0)
 *     Application I/O Data buffer
 */

const EventEmitter = require('events');
const dgram = require('dgram');
const { EIP_IO_UDP_PORT } = require('../constants');
const { buildIoDatagram, parseIoDatagram } = require('./io-datagram');
const { getSharedIoSocketManager } = require('./io-socket-manager');

const RealTimeFormat = Object.freeze({
    Modeless: 0,
    Header32Bit: 1
});

const RunIdleState = Object.freeze({
    Idle: 0,
    Run: 1
});

const IOConnectionState = Object.freeze({
    IDLE: 'IDLE',
    RUNNING: 'RUNNING',
    TIMED_OUT: 'TIMED_OUT',
    CLOSED: 'CLOSED'
});

/**
 * SequenceTracker implements ODVA §17 Sequence Tracking for Class 1 I/O streams.
 * Detects packet loss, duplicate packets, and out-of-order packets with 32-bit unsigned arithmetic.
 */
class SequenceTracker {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastSequenceNumber = null;
        this.receivedCount = 0;
        this.lostCount = 0;
        this.duplicateCount = 0;
        this.outOfOrderCount = 0;
    }

    /**
     * Ingests a received sequence number.
     * @param {number} sequenceNumber
     * @returns {{ status: 'ok'|'duplicate'|'lost'|'out_of_order', lost: number, sequenceNumber: number }}
     */
    track(sequenceNumber) {
        this.receivedCount++;
        const seq = sequenceNumber >>> 0;

        if (this.lastSequenceNumber === null) {
            this.lastSequenceNumber = seq;
            return { status: 'ok', lost: 0, sequenceNumber: seq };
        }

        const last = this.lastSequenceNumber;

        if (seq === last) {
            this.duplicateCount++;
            return { status: 'duplicate', lost: 0, sequenceNumber: seq };
        }

        // Calculate forward delta modulo 2^32
        const delta = (seq - last) >>> 0;

        // In 32-bit unsigned space, forward advance is within [1, 0x7FFFFFFF]
        if (delta > 0 && delta < 0x80000000) {
            this.lastSequenceNumber = seq;
            if (delta > 1) {
                const lost = delta - 1;
                this.lostCount += lost;
                return { status: 'lost', lost, sequenceNumber: seq };
            }
            return { status: 'ok', lost: 0, sequenceNumber: seq };
        } else {
            this.outOfOrderCount++;
            return { status: 'out_of_order', lost: 0, sequenceNumber: seq };
        }
    }

    getStats() {
        return {
            received: this.receivedCount,
            lost: this.lostCount,
            duplicates: this.duplicateCount,
            outOfOrder: this.outOfOrderCount,
            lastSequenceNumber: this.lastSequenceNumber
        };
    }
}

/**
 * High-level Class 1 Real-Time I/O Connection engine (§14, §15, §16, §17).
 * Handles cyclic transmission (O->T), reception (T->O), sequence validation,
 * Run/Idle state, and watchdog timeouts over UDP port 2222.
 */
class IOConnection extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host - Remote target IP address
     * @param {number} [options.port=2222] - Remote UDP port
     * @param {number} [options.localPort=2222] - Local UDP port to bind
     * @param {number} options.otConnectionId - O->T network connection ID (received from Forward_Open)
     * @param {number} options.toConnectionId - T->O network connection ID (sent in Forward_Open)
     * @param {number} [options.rpiMs=20] - Requested Packet Interval in milliseconds
     * @param {boolean} [options.useRunIdleHeader=false] - 32-bit Run/Idle header mode (O->T only)
     * @param {boolean} [options.runIdle=true] - Initial Run (true) or Idle (false) status
     * @param {boolean} [options.includeSequenceCount=true] - Prepend a 2-byte transport Sequence
     *   Count to every O->T datagram this connection sends. On by default: per ODVA CIP and the
     *   Family of CIP Networks (PUB00123R1) §3.3.12.2 / Figure 39, and the EtherNet/IP Developer's
     *   Guide (PUB00213R0) p.26, Transport Class 1 Connected Data is ALWAYS prepended with a 16-bit
     *   Sequence Count (data without it is a Class 0 or CIP Safety connection) -- and this project
     *   only ever negotiates Class 1 (see connection-manager.js's TransportTrigger presets, all
     *   Class1*). This was previously mislabeled here as a Delta-specific convention and left off
     *   by default, inconsistent with this same project's own Adapter-side T->O production
     *   (connection-handler.js's sendAtCurrentSeq), which already includes it unconditionally for
     *   the same reason. Set false only to interoperate with a genuine Class 0 connection, which
     *   this project does not otherwise construct.
     * @param {Buffer} [options.initialOutputData] - Initial output buffer
     * @param {number} [options.timeoutMultiplier=4] - Multiplier of RPI before watchdog fires
     * @param {import('dgram').Socket} [options.socket] - Optional shared UDP socket
     */
    constructor({
        host,
        port = EIP_IO_UDP_PORT,
        localPort = EIP_IO_UDP_PORT,
        otConnectionId,
        toConnectionId,
        rpiMs = 20,
        useRunIdleHeader = false,
        runIdle = true,
        includeSequenceCount = true,
        initialOutputData = null,
        timeoutMultiplier = 4,
        socket = null,
        multicast = false,
        multicastAddress = null,
        multicastInterface = null,
        useSharedSocket
    }) {
        super();
        if (!host) throw new Error('IOConnection: host is required');
        if (otConnectionId === undefined || toConnectionId === undefined) {
            throw new Error('IOConnection: otConnectionId and toConnectionId are required');
        }

        this.host = host;
        this.port = port;
        this.localPort = localPort;
        this.otConnectionId = otConnectionId >>> 0;
        this.toConnectionId = toConnectionId >>> 0;
        this.rpiMs = Math.max(1, Math.round(rpiMs));
        this.useRunIdleHeader = Boolean(useRunIdleHeader);
        this.runIdle = Boolean(runIdle);
        this.includeSequenceCount = Boolean(includeSequenceCount);
        this.outputData = initialOutputData ? Buffer.from(initialOutputData) : Buffer.alloc(0);
        this.timeoutMultiplier = timeoutMultiplier || 4;
        this.timeoutMs = this.rpiMs * this.timeoutMultiplier;

        this.multicast = Boolean(multicast);
        this.multicastAddress = multicastAddress ? String(multicastAddress).trim() : null;
        this.multicastInterface = multicastInterface || null;

        // By default use shared UDP manager if localPort is standard 2222 and no custom socket was supplied
        this.useSharedSocket = useSharedSocket !== undefined
            ? Boolean(useSharedSocket && !socket)
            : Boolean(!socket && localPort === EIP_IO_UDP_PORT);
        this._socketManager = null;

        this.state = IOConnectionState.IDLE;
        this.sequenceTracker = new SequenceTracker();
        this.sentCount = 0;
        this._sendSeq = 1;
        this._sendTimer = null;
        this._watchdogTimer = null;
        this._socket = socket;
        this._ownsSocket = !socket && !this.useSharedSocket;
        this._lastRxTime = 0;
        this._boundPort = null;

        this._onSocketMessage = this._handleSocketMessage.bind(this);
    }

    /**
     * Starts the cyclic I/O engine.
     * @returns {Promise<IOConnection>}
     */
    async start() {
        if (this.state === IOConnectionState.RUNNING) return this;

        if (this.useSharedSocket) {
            this._socketManager = getSharedIoSocketManager({ port: this.localPort });
            this._socketManager.on('error', (err) => this.emit('error', err));
            await this._socketManager.registerConnection(this);
            this._boundPort = this._socketManager.port;
        } else {
            if (!this._socket) {
                this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
                this._socket.on('error', (err) => {
                    this.emit('error', err);
                });

                await new Promise((resolve, reject) => {
                    const tryBind = (portToTry, fallbackToEphemeral) => {
                        this._socket.once('error', (err) => {
                            if (fallbackToEphemeral && err.code === 'EADDRINUSE') {
                                // Port 2222 in use, fallback to ephemeral port
                                tryBind(0, false);
                            } else {
                                reject(err);
                            }
                        });

                        this._socket.bind(portToTry, () => {
                            this._boundPort = this._socket.address().port;
                            if (this.multicast && this.multicastAddress) {
                                try {
                                    this._socket.addMembership(this.multicastAddress, this.multicastInterface || undefined);
                                } catch (mcastErr) {
                                    this.emit('warn', `IOConnection: addMembership failed: ${mcastErr.message}`);
                                }
                            }
                            resolve();
                        });
                    };

                    tryBind(this.localPort, true);
                });
            } else if (this.multicast && this.multicastAddress) {
                try {
                    this._socket.addMembership(this.multicastAddress, this.multicastInterface || undefined);
                } catch {}
            }

            this._socket.on('message', this._onSocketMessage);
        }

        this.state = IOConnectionState.RUNNING;
        this._lastRxTime = Date.now();

        // Start cyclic transmission of O->T datagrams
        this._sendTimer = setInterval(() => {
            this._sendCyclicPacket();
        }, this.rpiMs);

        // Immediate first packet
        this._sendCyclicPacket();

        // Start watchdog timer
        this._watchdogTimer = setInterval(() => {
            this._checkWatchdog();
        }, Math.max(10, Math.round(this.timeoutMs / 2)));

        this.emit('stateChange', this.state);
        return this;
    }

    /**
     * Updates the output payload buffer (O->T).
     * @param {Buffer} data
     */
    setOutput(data) {
        if (!Buffer.isBuffer(data)) {
            throw new TypeError('IOConnection.setOutput: data must be a Buffer');
        }
        this.outputData = Buffer.from(data);
    }

    /**
     * Sets the Run/Idle status flag.
     * @param {boolean} isRunning
     */
    setRun(isRunning) {
        this.runIdle = Boolean(isRunning);
    }

    /**
     * Sends an individual O->T cyclic packet.
     * @private
     */
    _sendCyclicPacket() {
        if (this.state === IOConnectionState.CLOSED) return;

        const seq = this._sendSeq >>> 0;
        this._sendSeq = (this._sendSeq + 1) >>> 0 || 1;

        const datagram = buildIoDatagram({
            connectionId: this.otConnectionId,
            sequenceNumber: seq,
            data: this.outputData,
            useRunIdleHeader: this.useRunIdleHeader,
            runIdle: this.runIdle,
            includeSequenceCount: this.includeSequenceCount
        });

        if (this.useSharedSocket && this._socketManager) {
            this._socketManager.sendDatagram(datagram, this.port, this.host, (err) => {
                if (err) {
                    this.emit('error', err);
                } else {
                    this.sentCount++;
                }
            });
        } else if (this._socket) {
            try {
                this._socket.send(datagram, 0, datagram.length, this.port, this.host, (err) => {
                    if (err) {
                        this.emit('error', err);
                    } else {
                        this.sentCount++;
                    }
                });
            } catch (err) {
                this.emit('error', err);
            }
        }
    }

    /**
     * Handles incoming parsed datagram (called either directly or via IoSocketManager demux).
     * @param {object} parsed
     * @param {object} [rinfo]
     */
    handleIncomingParsedDatagram(parsed, rinfo) {
        if (this.state === IOConnectionState.CLOSED) return;

        // Must match our T->O network connection ID
        if (parsed.connectionId !== this.toConnectionId) {
            return;
        }

        this._lastRxTime = Date.now();

        // Sequence tracking
        const trackResult = this.sequenceTracker.track(parsed.sequenceNumber);
        if (trackResult.status === 'lost') {
            this.emit('packetLost', { lost: trackResult.lost, sequenceNumber: parsed.sequenceNumber });
        } else if (trackResult.status === 'duplicate') {
            this.emit('duplicate', { sequenceNumber: parsed.sequenceNumber });
        } else if (trackResult.status === 'out_of_order') {
            this.emit('outOfOrder', { sequenceNumber: parsed.sequenceNumber });
        }

        // Recover from TIMED_OUT state if target resumes
        if (this.state === IOConnectionState.TIMED_OUT) {
            this.state = IOConnectionState.RUNNING;
            this.emit('stateChange', this.state);
            this.emit('recovered');
        }

        // Strip the leading 2-byte transport Sequence Count
        let appData = parsed.data;
        if (appData.length >= 2) {
            appData = appData.subarray(2);
        }

        this.emit('data', appData, {
            sequenceNumber: parsed.sequenceNumber,
            runIdle: parsed.runIdle,
            status: trackResult.status,
            rinfo
        });
    }

    /**
     * Handles incoming raw UDP datagrams when using dedicated socket.
     * @private
     */
    _handleSocketMessage(msg, rinfo) {
        if (this.state === IOConnectionState.CLOSED) return;

        let parsed;
        try {
            parsed = parseIoDatagram(msg);
        } catch {
            return; // Ignore non-I/O or malformed datagrams
        }

        this.handleIncomingParsedDatagram(parsed, rinfo);
    }

    /**
     * Periodic watchdog check.
     * @private
     */
    _checkWatchdog() {
        if (this.state !== IOConnectionState.RUNNING) return;

        const elapsed = Date.now() - this._lastRxTime;
        if (elapsed >= this.timeoutMs) {
            this.state = IOConnectionState.TIMED_OUT;
            this.emit('stateChange', this.state);
            this.emit('timeout', { elapsed, timeoutMs: this.timeoutMs });
        }
    }

    /**
     * Stops the I/O connection and releases resources.
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.state === IOConnectionState.CLOSED) return;

        clearInterval(this._sendTimer);
        clearInterval(this._watchdogTimer);
        this._sendTimer = null;
        this._watchdogTimer = null;

        if (this.useSharedSocket && this._socketManager) {
            await this._socketManager.unregisterConnection(this);
            this._socketManager = null;
        } else if (this._socket) {
            this._socket.removeListener('message', this._onSocketMessage);
            if (this.multicast && this.multicastAddress) {
                try {
                    this._socket.dropMembership(this.multicastAddress, this.multicastInterface || undefined);
                } catch {}
            }
            if (this._ownsSocket) {
                await new Promise((resolve) => {
                    try {
                        this._socket.close(() => resolve());
                    } catch {
                        resolve();
                    }
                });
            }
        }

        this.state = IOConnectionState.CLOSED;
        this.emit('stateChange', this.state);
        this.emit('close');
    }

    async close() {
        return this.stop();
    }

    /**
     * Returns connection telemetry and statistics.
     */
    getStats() {
        return {
            state: this.state,
            sent: this.sentCount,
            rpiMs: this.rpiMs,
            timeoutMs: this.timeoutMs,
            boundPort: this._boundPort,
            runIdle: this.runIdle,
            ...this.sequenceTracker.getStats()
        };
    }
}

module.exports = {
    RealTimeFormat,
    RunIdleState,
    IOConnectionState,
    SequenceTracker,
    IOConnection,
    buildIoDatagram,
    parseIoDatagram
};
