'use strict';

/**
 * Server-side Connection Manager behavior: accepts Forward_Open/Forward_Close
 * against an AssemblyObject registry, and drives the resulting cyclic UDP
 * I/O (producing T->O datagrams at RPI, consuming incoming O->T datagrams).
 *
 * Connection path convention (matches encodeAssemblyConnectionPath() and
 * the real-device behavior this driver reverse-engineered from Delta
 * hardware in Phase 2 — README Domain E's AHRTU-ETHN-5A excerpt: Instance
 * 0x64 "Owner Output", 0x65 "Owner Input"): the FIRST Connection Point in
 * the path is O->T ("Output" — what the Originator sends us, so what we
 * consume into), the SECOND is T->O ("Input" — what we report back, so
 * what we produce from).
 */

const { decodeEPath } = require('../cip/path');
const { buildIoDatagram, parseIoDatagram } = require('../cip/io-connection');
const { CipGeneralStatus } = require('../constants');

class ConnectionHandler {
    constructor({ assemblyObject, identity, sendDatagram, connectionManagerObject, quiet = false, strictDuplicateConnections = false }) {
        this.assemblyObject = assemblyObject;
        this.identity = identity; // optional — enables Electronic Key validation below
        this.sendDatagram = sendDatagram; // (buffer, remoteAddress) => void
        this.connectionManagerObject = connectionManagerObject; // optional — tracks CIP connection stats
        this.connections = new Map(); // otNetworkConnectionId -> state
        this._nextConnectionId = 1;
        this.quiet = Boolean(quiet);
        this.onProduceData = null; // optional hook (t2oInstance) => void
        // Default (false) is deliberately more lenient than strict ODVA
        // conformance: a repeat Forward_Open from the same originator
        // silently supersedes its own prior connection instead of being
        // rejected, which is friendlier for interactive development
        // (re-running a client without an explicit Forward_Close first).
        // Set true for strict CIP Vol 1 3-5.5.3 behavior — reject a
        // matching (same Connection Serial Number + Originator Vendor ID +
        // Originator Serial Number) Forward_Open with ConnectionFailure /
        // extended status 0x0100 "Connection in use or duplicate Forward
        // Open", exactly as OpENer's HandleNonNullMatchingForwardOpenRequest does.
        this.strictDuplicateConnections = Boolean(strictDuplicateConnections);
    }

    /** Finds an existing connection with the same triple OpENer uses to detect a "matching" Forward_Open. */
    _findMatchingConnection(request) {
        for (const existing of this.connections.values()) {
            if (
                existing.connectionSerialNumber === request.connectionSerialNumber &&
                existing.originatorVendorId === request.originatorVendorId &&
                existing.originatorSerialNumber === request.originatorSerialNumber
            ) {
                return existing;
            }
        }
        return null;
    }

    /**
     * Validates an Electronic Key Segment (if the connection path carried
     * one — real Scanners/PLCs always include one) against this Adapter's
     * own Identity — CIP Vol 1, C-1.4.5.2. Algorithm ported field-for-field
     * from OpENer's CheckElectronicKeyData() (the ODVA-conformance-tested
     * reference implementation, cipconnectionmanager.c), not re-derived —
     * a few of its rules are easy to get subtly wrong by "reasoning from
     * the spec text" alone (see the two comments below).
     */
    _checkElectronicKey(key) {
        if (!key || !this.identity) return null; // nothing to check
        const id = this.identity;

        // VendorID and ProductCode are checked together, before DeviceType
        // (OpENer's own priority order — matters when more than one thing
        // is wrong at once, since only the first mismatch found is reported).
        if ((key.vendorId !== 0 && key.vendorId !== id.vendorId) ||
            (key.productCode !== 0 && key.productCode !== id.productCode)) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0114 }; // Vendor ID or Product Code mismatch
        }
        if (key.deviceType !== 0 && key.deviceType !== id.deviceType) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0115 }; // Device Type mismatch
        }

        const ourRev = id.revision || { major: 0, minor: 0 };
        if (!key.compatibility) {
            // Major Revision 0 is a wildcard in strict keying too — not just
            // an "exact match required" fallback. Minor Revision 0 is ALSO a
            // wildcard once Major has matched (easy to miss: it's tempting
            // to require an exact Major.Minor match here, but the reference
            // implementation doesn't).
            if (key.majorRevision === 0) return null;
            if (key.majorRevision !== ourRev.major) {
                return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0116 };
            }
            if (key.minorRevision !== 0 && key.minorRevision !== ourRev.minor) {
                return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0116 };
            }
        } else {
            // Compatible keying is NARROWER than it sounds: Major must match
            // EXACTLY (a higher Major on our side does NOT satisfy it, even
            // though intuitively "we're newer" might seem compatible), and
            // Minor must be > 0 (0 is not a valid "any minor" wildcard here,
            // unlike strict mode) and <= our own Minor Revision.
            const ok = key.majorRevision === ourRev.major && key.minorRevision > 0 && key.minorRevision <= ourRev.minor;
            if (!ok) {
                return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0116 };
            }
        }
        return null;
    }

    /**
     * @param {object} request - cip/connection-manager.js's parseForwardOpenRequest() output
     * @param {object} context - { remoteAddress }
     * @returns {{ ok: true, response: object } | { ok: false, generalStatus: number, extendedStatus: number }}
     */
    openConnection(request, { remoteAddress }) {
        let path;
        try {
            path = decodeEPath(request.connectionPath);
        } catch {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }

        const keyError = this._checkElectronicKey(path.electronicKey);
        if (keyError) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, ...keyError };
        }

        const isExplicit = path.classId === 0x02 || (!path.connectionPoints || path.connectionPoints.length === 0);

        const cleanAddress = (typeof remoteAddress === 'string' && remoteAddress.startsWith('::ffff:'))
            ? remoteAddress.slice(7)
            : remoteAddress;

        if (isExplicit) {
            if (this.strictDuplicateConnections && this._findMatchingConnection(request)) {
                this.connectionManagerObject?.recordOpenRequest(false, 'duplicate');
                return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0100 };
            }
            // Clean up any existing explicit connection from the same originator or endpoint
            // (skipped in strict mode: the exact-triple check above already ran,
            // and strict mode should let a genuinely different connection from
            // the same originator/endpoint coexist rather than silently killing it).
            if (!this.strictDuplicateConnections) {
                for (const [id, existing] of this.connections.entries()) {
                    if (
                        existing.isExplicit &&
                        ((existing.originatorSerialNumber === request.originatorSerialNumber && existing.originatorVendorId === request.originatorVendorId) ||
                         existing.remoteAddress === cleanAddress)
                    ) {
                        if (existing.timer) clearInterval(existing.timer);
                        this.connections.delete(id);
                    }
                }
            }

            const otNetworkConnectionId = (Math.floor(Math.random() * 0x3FFFFFFF) + 0x10000000) >>> 0;
            const state = {
                otNetworkConnectionId,
                toNetworkConnectionId: request.toNetworkConnectionId,
                connectionSerialNumber: request.connectionSerialNumber,
                originatorVendorId: request.originatorVendorId,
                originatorSerialNumber: request.originatorSerialNumber,
                isExplicit: true,
                remoteAddress: cleanAddress,
                remotePort: null,
                timer: null
            };

            this.connections.set(otNetworkConnectionId, state);
            this.connectionManagerObject?.recordOpenRequest(true);

            if (!this.quiet) {
                console.log(`\x1b[32m[PLC CLASS 3 EXPLICIT CONNECTED]\x1b[0m \x1b[1m${cleanAddress}\x1b[0m | ConnID: 0x${otNetworkConnectionId.toString(16)} (Message Router)`);
            }

            return {
                ok: true,
                response: {
                    otNetworkConnectionId,
                    toNetworkConnectionId: request.toNetworkConnectionId,
                    connectionSerialNumber: request.connectionSerialNumber,
                    originatorVendorId: request.originatorVendorId,
                    originatorSerialNumber: request.originatorSerialNumber,
                    otApiUs: request.otRpiUs,
                    toApiUs: request.toRpiUs
                }
            };
        }

        const [o2tInstance, t2oInstance] = path.connectionPoints || [];
        if (o2tInstance === undefined || t2oInstance === undefined) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }
        if (!this.assemblyObject.has(o2tInstance) || !this.assemblyObject.has(t2oInstance)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'resource');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 }; // connection not found at target
        }

        let outputBuf = this.assemblyObject.getData(o2tInstance);
        let inputBuf = this.assemblyObject.getData(t2oInstance);

        const maxSize = request.isLarge ? 65535 : 511;

        // Auto-adapt / resize assembly buffers if valid (within standard CIP 1..511 or Large 1..65535 bytes limit)
        if (outputBuf && outputBuf.length !== request.otSize && request.otSize > 0 && request.otSize <= maxSize) {
            this.assemblyObject.define(o2tInstance, request.otSize);
            outputBuf = this.assemblyObject.getData(o2tInstance);
        }
        if (inputBuf && inputBuf.length !== request.toSize && request.toSize > 0 && request.toSize <= maxSize) {
            this.assemblyObject.define(t2oInstance, request.toSize);
            inputBuf = this.assemblyObject.getData(t2oInstance);
        }

        if (request.otSize > maxSize || request.toSize > maxSize) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0113 };
        }

        if (this.strictDuplicateConnections && this._findMatchingConnection(request)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'duplicate');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0100 };
        }

        // Clean up any existing connection from the same originator or endpoint
        // (skipped in strict mode — see the matching comment in the explicit-connection branch above).
        if (!this.strictDuplicateConnections) {
            for (const [id, existing] of this.connections.entries()) {
                if (
                    (existing.originatorSerialNumber === request.originatorSerialNumber && existing.originatorVendorId === request.originatorVendorId) ||
                    (existing.remoteAddress === cleanAddress && existing.o2tInstance === o2tInstance && existing.t2oInstance === t2oInstance)
                ) {
                    if (existing.timer) clearInterval(existing.timer);
                    this.connections.delete(id);
                }
            }
        }

        const otNetworkConnectionId = (Math.floor(Math.random() * 0x3FFFFFFF) + 0x10000000) >>> 0;
        const state = {
            otNetworkConnectionId,
            toNetworkConnectionId: request.toNetworkConnectionId,
            connectionSerialNumber: request.connectionSerialNumber,
            originatorVendorId: request.originatorVendorId,
            originatorSerialNumber: request.originatorSerialNumber,
            o2tInstance,
            t2oInstance,
            otSize: request.otSize,
            toSize: request.toSize,
            remoteAddress: cleanAddress,
            remotePort: null,
            sequenceNumber: 1,
            useRunIdleHeader: Boolean(request.useRunIdleHeader),
            runIdle: true,
            timer: null
        };

        const targetDataSize = request.toSize;
        const getProducedData = () => {
            if (typeof this.onProduceData === 'function') {
                try { this.onProduceData(t2oInstance); } catch {}
            }
            const raw = this.assemblyObject.getData(t2oInstance);
            if (raw.length === targetDataSize) return raw;
            if (raw.length > targetDataSize) return raw.subarray(0, targetDataSize);
            const padded = Buffer.alloc(targetDataSize);
            raw.copy(padded);
            return padded;
        };

        const rpiMs = Math.max(1, Math.round(request.toRpiUs / 1000));

        // Immediate first packet dispatch to prevent PLC connection watchdog timeout.
        // In ODVA CIP Transport Class 1 specification, Connected Data (item 0x00B1)
        // carries a 16-bit Sequence Count (transport header) so controllers (Delta, Rockwell, Omron)
        // do not consume the first 2 bytes of data as sequence numbers.
        const initialDatagram = buildIoDatagram({
            connectionId: state.toNetworkConnectionId,
            sequenceNumber: state.sequenceNumber,
            data: getProducedData(),
            useRunIdleHeader: false,
            runIdle: true,
            includeSequenceCount: true
        });
        this.sendDatagram(initialDatagram, state.remoteAddress, state.remotePort);

        state.timer = setInterval(() => {
            state.sequenceNumber = (state.sequenceNumber + 1) >>> 0 || 1;
            const datagram = buildIoDatagram({
                connectionId: state.toNetworkConnectionId,
                sequenceNumber: state.sequenceNumber,
                data: getProducedData(),
                useRunIdleHeader: false,
                runIdle: true,
                includeSequenceCount: true
            });
            this.sendDatagram(datagram, state.remoteAddress, state.remotePort);
        }, rpiMs);

        this.connections.set(otNetworkConnectionId, state);
        this.connectionManagerObject?.recordOpenRequest(true);

        if (!this.quiet) {
            console.log(`\x1b[32m[PLC CLASS 1 I/O CONNECTED]\x1b[0m \x1b[1m${cleanAddress}\x1b[0m | O->T: Assem ${o2tInstance} (${request.otSize}B), T->O: Assem ${t2oInstance} (${request.toSize}B), RPI: ${rpiMs}ms | ConnID: 0x${otNetworkConnectionId.toString(16)}`);
        }

        return {
            ok: true,
            response: {
                otNetworkConnectionId,
                toNetworkConnectionId: request.toNetworkConnectionId,
                connectionSerialNumber: request.connectionSerialNumber,
                originatorVendorId: request.originatorVendorId,
                originatorSerialNumber: request.originatorSerialNumber,
                otApiUs: request.otRpiUs,
                toApiUs: request.toRpiUs
            }
        };
    }

    /** @param {object} request - cip/connection-manager.js's parseForwardCloseRequest() output */
    closeConnection(request) {
        for (const [id, state] of this.connections) {
            if (
                state.connectionSerialNumber === request.connectionSerialNumber &&
                state.originatorVendorId === request.originatorVendorId &&
                state.originatorSerialNumber === request.originatorSerialNumber
            ) {
                clearInterval(state.timer);
                this.connections.delete(id);
                this.connectionManagerObject?.recordCloseRequest(true);
                return {
                    ok: true,
                    response: {
                        connectionSerialNumber: request.connectionSerialNumber,
                        originatorVendorId: request.originatorVendorId,
                        originatorSerialNumber: request.originatorSerialNumber
                    }
                };
            }
        }
        this.connectionManagerObject?.recordCloseRequest(false);
        return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 };
    }

    /** Feed every datagram received on the I/O UDP socket (port 2222) here. */
    handleIncomingDatagram(buf, rinfo) {
        let parsed;
        try {
            parsed = parseIoDatagram(buf);
        } catch {
            return; // not a valid I/O datagram — ignore
        }
        for (const state of this.connections.values()) {
            if (state.otNetworkConnectionId !== parsed.connectionId) continue;
            if (rinfo && rinfo.port) {
                state.remotePort = rinfo.port;
                state.remoteAddress = (rinfo.address && rinfo.address.startsWith('::ffff:')) ? rinfo.address.slice(7) : rinfo.address;
            }
            const outputBuf = this.assemblyObject.getData(state.o2tInstance);
            let payload = parsed.data;

            // Strip CIP I/O transport headers:
            // Case 1: 2-byte Sequence Count + 4-byte Run/Idle header (6 bytes prefix)
            if (payload.length >= 6) {
                const headerAt2 = payload.readUInt32LE(2);
                if (headerAt2 === 0 || headerAt2 === 1) {
                    state.runIdle = Boolean(headerAt2 & 0x01);
                    payload = payload.subarray(6);
                } else {
                    // Case 2: 4-byte Run/Idle header at offset 0
                    const headerAt0 = payload.readUInt32LE(0);
                    if (headerAt0 === 0 || headerAt0 === 1) {
                        state.runIdle = Boolean(headerAt0 & 0x01);
                        payload = payload.subarray(4);
                    } else if (state.otSize > 0 && payload.length === state.otSize + 2) {
                        // Case 3: 2-byte sequence count only
                        payload = payload.subarray(2);
                    }
                }
            } else if (payload.length >= 4) {
                const headerAt0 = payload.readUInt32LE(0);
                if (headerAt0 === 0 || headerAt0 === 1) {
                    state.runIdle = Boolean(headerAt0 & 0x01);
                    payload = payload.subarray(4);
                } else if (state.otSize > 0 && payload.length === state.otSize + 2) {
                    payload = payload.subarray(2);
                }
            }
            if (outputBuf.length !== payload.length && payload.length > 0) {
                this.assemblyObject.define(state.o2tInstance, payload.length);
            }
            this.assemblyObject.setData(state.o2tInstance, payload);
            return;
        }
    }

    closeAll() {
        for (const state of this.connections.values()) clearInterval(state.timer);
        this.connections.clear();
    }
}

module.exports = { ConnectionHandler };
