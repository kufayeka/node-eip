'use strict';

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { encodeMessage, decodeMessage } = require('./header');
const { decodeCpf, CpfItemType } = require('./cpf');
const { decodeIdentityItem } = require('./identity');
const { EncapsulationCommands, EIP_ENCAPSULATION_PORT } = require('../constants');

/**
 * The global limited broadcast address (255.255.255.255) is unreliable to
 * send from a Node UDP socket on machines with more than one active network
 * interface (VPN adapters, Hyper-V/VMware virtual switches, WSL, ...) —
 * Windows in particular often can't resolve which interface to emit it from
 * and silently drops it, even though the socket call itself succeeds. A
 * subnet-directed broadcast (e.g. 192.168.68.255 for a /24) is bound to a
 * specific interface via the routing table and is what real EIP scanner
 * tools actually send. This computes that address for every active,
 * non-internal IPv4 interface on the host.
 */
function ipv4DirectedBroadcasts() {
    const interfaces = os.networkInterfaces();
    const broadcasts = [];

    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (entry.internal || entry.family !== 'IPv4') {
                continue;
            }
            const addr = entry.address.split('.').map(Number);
            const mask = entry.netmask.split('.').map(Number);
            if (addr.length !== 4 || mask.length !== 4) {
                continue;
            }
            const broadcast = addr.map((octet, i) => (octet | (~mask[i] & 0xff))).join('.');
            broadcasts.push(broadcast);
        }
    }

    return [...new Set(broadcasts)];
}

function buildListIdentityRequest(senderContext = Buffer.alloc(8)) {
    return encodeMessage({ command: EncapsulationCommands.ListIdentity, senderContext }, Buffer.alloc(0));
}

/**
 * Parses a full ListIdentity response (header + CPF-wrapped Identity item).
 * Returns null if the buffer is a response to a different command, or
 * throws if the CPF is malformed / the identity item is missing.
 */
function parseListIdentityResponse(buf) {
    const msg = decodeMessage(buf);
    if (!msg) {
        return null;
    }
    if (msg.header.command !== EncapsulationCommands.ListIdentity) {
        return null;
    }

    const { items } = decodeCpf(msg.data);
    const identityItem = items.find((item) => item.typeId === CpfItemType.ListIdentityResponse);
    if (!identityItem) {
        throw new Error('parseListIdentityResponse: no Identity item (0x000C) found in CPF');
    }

    return {
        header: msg.header,
        identity: decodeIdentityItem(identityItem.data)
    };
}

/**
 * Broadcasts a ListIdentity request over UDP and collects every reply that
 * arrives within `timeoutMs`. This is the "scan the network for EIP
 * devices" entry point (CIP Vol 2, 2-4.3) — vendor-neutral: any
 * ODVA-conformant device answers this the same way.
 *
 * @param {object} [opts]
 * @param {string|string[]} [opts.broadcastAddress] - explicit target(s), e.g. '192.168.68.255'.
 *   When omitted, sends to the directed broadcast address of every active,
 *   non-internal IPv4 interface on this host (see ipv4DirectedBroadcasts) —
 *   the global 255.255.255.255 address is deliberately NOT used by default,
 *   since it is unreliable to send on multi-interface hosts (see comment above).
 * @param {number} [opts.port] - defaults to 44818.
 * @param {number} [opts.timeoutMs] - how long to wait for replies, default 3000.
 * @returns {Promise<Array<{ remoteAddress: string, remotePort: number, identity: object }>>}
 */
function scanUdp({ broadcastAddress, port = EIP_ENCAPSULATION_PORT, timeoutMs = 3000 } = {}) {
    const targets = broadcastAddress
        ? (Array.isArray(broadcastAddress) ? broadcastAddress : [broadcastAddress])
        : ipv4DirectedBroadcasts();

    return new Promise((resolve, reject) => {
        if (targets.length === 0) {
            resolve([]);
            return;
        }

        const socket = dgram.createSocket('udp4');
        const found = new Map();

        socket.on('error', (err) => {
            socket.close();
            reject(err);
        });

        socket.on('message', (msg, rinfo) => {
            try {
                const parsed = parseListIdentityResponse(msg);
                if (parsed) {
                    found.set(rinfo.address, { remoteAddress: rinfo.address, remotePort: rinfo.port, identity: parsed.identity });
                }
            } catch {
                // Malformed/unrelated reply on the same socket — ignore, keep scanning.
            }
        });

        socket.bind(() => {
            socket.setBroadcast(true);
            const request = buildListIdentityRequest();
            for (const target of targets) {
                socket.send(request, port, target);
            }
        });

        setTimeout(() => {
            socket.close();
            resolve([...found.values()]);
        }, timeoutMs);
    });
}

/**
 * Sends ListIdentity directly (UDP unicast) to a single known host — useful
 * when broadcast is blocked/filtered but the device's address is known.
 */
function scanUdpUnicast(host, { port = EIP_ENCAPSULATION_PORT, timeoutMs = 2000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        let settled = false;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.close();
            fn(value);
        };

        socket.on('error', (err) => finish(reject, err));

        socket.on('message', (msg) => {
            try {
                const parsed = parseListIdentityResponse(msg);
                if (parsed) {
                    finish(resolve, parsed.identity);
                }
            } catch (err) {
                finish(reject, err);
            }
        });

        const timer = setTimeout(() => finish(reject, new Error(`scanUdpUnicast: no reply from ${host} within ${timeoutMs}ms`)), timeoutMs);

        socket.bind(() => {
            socket.send(buildListIdentityRequest(), port, host);
        });
    });
}

/**
 * Sends ListIdentity over a plain TCP connection (no session required —
 * ListIdentity/ListServices/ListInterfaces are valid without RegisterSession
 * per CIP Vol 2, 2-4.2). Useful to confirm a specific host is reachable and
 * to fetch its Identity without opening a session.
 */
function probeTcp(host, { port = EIP_ENCAPSULATION_PORT, timeoutMs = 3000 } = {}) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        let buffer = Buffer.alloc(0);
        let settled = false;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn(value);
        };

        const timer = setTimeout(() => finish(reject, new Error(`probeTcp: timed out connecting/waiting for ${host}:${port}`)), timeoutMs);

        socket.on('error', (err) => finish(reject, err));

        socket.connect(port, host, () => {
            socket.write(buildListIdentityRequest());
        });

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                const parsed = parseListIdentityResponse(buffer);
                if (parsed) {
                    finish(resolve, parsed.identity);
                }
            } catch (err) {
                finish(reject, err);
            }
        });
    });
}

module.exports = {
    buildListIdentityRequest,
    parseListIdentityResponse,
    ipv4DirectedBroadcasts,
    scanUdp,
    scanUdpUnicast,
    probeTcp
};
