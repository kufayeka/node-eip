'use strict';

/**
 * Shared UDP 2222 Class 1 I/O Socket Manager (ODVA CIP Vol 2 §3-5.3 & §3-4).
 *
 * Provides a centralized UDP port 2222 socket shared across multiple IOConnection
 * instances within the same Node.js process:
 * 1. Single UDP socket bound to port 2222 with reuseAddr: true.
 * 2. Connection ID Demultiplexing: Routes incoming datagrams to registered
 *    IOConnection instances in O(1) by their 32-bit `toNetworkConnectionId`.
 * 3. IGMP Multicast Group Management: Coordinates `addMembership()` / `dropMembership()`
 *    with reference counting so multiple subscribers to the same multicast group (e.g.
 *    from a Delta SX3 or Allen-Bradley PLC) share a single IGMP join.
 * 4. Cyclic Datagram Production: Provides thread-safe O->T transmission over the shared socket.
 */

const EventEmitter = require('events');
const dgram = require('dgram');
const { EIP_IO_UDP_PORT } = require('../constants');
const { parseIoDatagram } = require('./io-datagram');

class IoSocketManager extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {number} [options.port=2222] - UDP port to bind (default 2222)
     * @param {string} [options.address='0.0.0.0'] - Interface address to bind
     * @param {boolean} [options.autoClose=false] - Automatically close socket when all connections unregister
     */
    constructor({ port = EIP_IO_UDP_PORT, address = '0.0.0.0', autoClose = false } = {}) {
        super();
        this.port = port;
        this.address = address;
        this.autoClose = autoClose;

        this.socket = null;
        this._bindPromise = null;
        this._bound = false;

        // Map<toNetworkConnectionId (number), Set<IOConnection>>
        this.connections = new Map();

        // Map<multicastAddress (string), number (refCount)>
        this.memberships = new Map();

        this._onMessage = this._handleSocketMessage.bind(this);
        this._onError = (err) => this.emit('error', err);
    }

    /**
     * Ensures the shared UDP socket is created and bound to port 2222.
     * @returns {Promise<dgram.Socket>}
     */
    async ensureBound() {
        if (this._bound && this.socket) {
            return this.socket;
        }
        if (this._bindPromise) {
            return this._bindPromise;
        }

        this._bindPromise = new Promise((resolve, reject) => {
            const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this.socket = socket;

            const onEarlyError = (err) => {
                this._bindPromise = null;
                reject(err);
            };
            socket.once('error', onEarlyError);

            socket.bind({ port: this.port, address: this.address, exclusive: false }, () => {
                socket.removeListener('error', onEarlyError);
                socket.on('error', this._onError);
                socket.on('message', this._onMessage);
                this._bound = true;
                this._bindPromise = null;
                resolve(socket);
            });
        });

        return this._bindPromise;
    }

    _resolveMulticastInterfaces(multicastInterface) {
        if (multicastInterface) {
            return [multicastInterface];
        }
        const os = require('os');
        const results = [];
        try {
            const ifaces = os.networkInterfaces();
            for (const list of Object.values(ifaces)) {
                for (const iface of list) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        results.push(iface.address);
                    }
                }
            }
        } catch {}
        return results.length > 0 ? results : [undefined];
    }

    _getMulticastBlockAddresses(baseAddr) {
        if (!baseAddr) return [];
        const parts = baseAddr.split('.').map(Number);
        if (parts.length !== 4) return [baseAddr];
        const addrs = [];
        const baseOctet = parts[3];
        // Per CIP Vol 2 §3-5.3: each device is allocated a 32-address block
        for (let i = 0; i < 32; i++) {
            addrs.push(`${parts[0]}.${parts[1]}.${parts[2]}.${baseOctet + i}`);
        }
        return addrs;
    }

    /**
     * Registers an IOConnection instance with this shared socket manager.
     * Joins multicast group if connection is configured for multicast.
     *
     * @param {object} ioConnection
     */
    async registerConnection(ioConnection) {
        const socket = await this.ensureBound();

        // Handle IGMP Multicast group membership (CIP 32-address allocation block)
        if (ioConnection.multicast && ioConnection.multicastAddress) {
            const addrs = this._getMulticastBlockAddresses(ioConnection.multicastAddress);
            const ifaces = this._resolveMulticastInterfaces(ioConnection.multicastInterface);
            for (const addr of addrs) {
                const currentCount = this.memberships.get(addr) || 0;
                if (currentCount === 0) {
                    for (const iface of ifaces) {
                        try {
                            socket.addMembership(addr, iface);
                        } catch (err) {
                            // Interface specific binding warning
                        }
                    }
                }
                this.memberships.set(addr, currentCount + 1);
            }
        }

        // Register in connection demux table
        const connId = ioConnection.toConnectionId >>> 0;
        let set = this.connections.get(connId);
        if (!set) {
            set = new Set();
            this.connections.set(connId, set);
        }
        set.add(ioConnection);
    }

    /**
     * Unregisters an IOConnection and drops multicast membership when ref count reaches 0.
     *
     * @param {object} ioConnection
     */
    async unregisterConnection(ioConnection) {
        const connId = ioConnection.toConnectionId >>> 0;
        const set = this.connections.get(connId);
        if (set) {
            set.delete(ioConnection);
            if (set.size === 0) {
                this.connections.delete(connId);
            }
        }

        // Handle IGMP group leave
        if (ioConnection.multicast && ioConnection.multicastAddress && this.socket && this._bound) {
            const addrs = this._getMulticastBlockAddresses(ioConnection.multicastAddress);
            const ifaces = this._resolveMulticastInterfaces(ioConnection.multicastInterface);
            for (const addr of addrs) {
                const count = this.memberships.get(addr);
                if (count !== undefined) {
                    if (count <= 1) {
                        this.memberships.delete(addr);
                        for (const iface of ifaces) {
                            try {
                                this.socket.dropMembership(addr, iface);
                            } catch {}
                        }
                    } else {
                        this.memberships.set(addr, count - 1);
                    }
                }
            }
        }

        // Optional auto-close when no connections remain
        if (this.autoClose && this.connections.size === 0 && this.socket) {
            await this.close();
        }
    }

    /**
     * Sends an O->T datagram over the shared socket.
     *
     * @param {Buffer} datagram
     * @param {number} port
     * @param {string} host
     * @param {function} [callback]
     */
    sendDatagram(datagram, port, host, callback) {
        if (!this.socket || !this._bound) {
            const err = new Error('IoSocketManager.sendDatagram: socket is not bound');
            if (callback) callback(err);
            return;
        }
        try {
            this.socket.send(datagram, 0, datagram.length, port, host, callback);
        } catch (err) {
            if (callback) callback(err);
        }
    }

    /**
     * Incoming datagram demultiplexer.
     * @private
     */
    _handleSocketMessage(msg, rinfo) {
        let parsed;
        try {
            parsed = parseIoDatagram(msg);
        } catch {
            return; // Not a valid CPF Class 1 I/O datagram
        }

        const connId = parsed.connectionId >>> 0;
        const set = this.connections.get(connId);
        if (!set || set.size === 0) {
            return;
        }

        for (const conn of set) {
            try {
                conn.handleIncomingParsedDatagram(parsed, rinfo);
            } catch (err) {
                this.emit('error', err);
            }
        }
    }

    /**
     * Closes the shared socket and resets all registrations.
     */
    async close() {
        if (!this.socket) {
            this._bound = false;
            return;
        }

        const socket = this.socket;
        this.socket = null;
        this._bound = false;
        this._bindPromise = null;

        // Clear memberships
        this.memberships.clear();
        this.connections.clear();

        await new Promise((resolve) => {
            try {
                socket.removeListener('message', this._onMessage);
                socket.close(() => resolve());
            } catch {
                resolve();
            }
        });
    }
}

// Global shared singleton
let sharedManagerInstance = null;

function getSharedIoSocketManager(options) {
    if (!sharedManagerInstance) {
        sharedManagerInstance = new IoSocketManager(options);
    }
    return sharedManagerInstance;
}

function resetSharedIoSocketManager() {
    if (sharedManagerInstance) {
        const inst = sharedManagerInstance;
        sharedManagerInstance = null;
        return inst.close();
    }
    return Promise.resolve();
}

module.exports = {
    IoSocketManager,
    getSharedIoSocketManager,
    resetSharedIoSocketManager
};
