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
    constructor({ assemblyObject, identity, sendDatagram }) {
        this.assemblyObject = assemblyObject;
        this.identity = identity; // optional — enables Electronic Key validation below
        this.sendDatagram = sendDatagram; // (buffer, remoteAddress) => void
        this.connections = new Map(); // otNetworkConnectionId -> state
        this._nextConnectionId = 1;
    }

    /**
     * Validates an Electronic Key Segment (if the connection path carried
     * one — real Scanners/PLCs always include one) against this Adapter's
     * own Identity — CIP Vol 1, C-1.4.5.2. VendorID 0 is treated as a
     * wildcard ("don't care"), matching common ODVA conformance-test
     * tooling behavior, not just real devices.
     */
    _checkElectronicKey(key) {
        if (!key || !this.identity) return null; // nothing to check
        if (key.vendorId !== 0 && key.vendorId !== this.identity.vendorId) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0114 }; // Vendor ID or Product Code mismatch
        }
        if (key.deviceType !== 0 && key.deviceType !== this.identity.deviceType) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0115 }; // Device Type mismatch
        }
        if (key.productCode !== 0 && key.productCode !== this.identity.productCode) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0114 };
        }
        const ourRev = this.identity.revision || { major: 0, minor: 0 };
        if (key.compatibility) {
            // Compatible keying: accept any of our revision >= the requested one.
            if (ourRev.major < key.majorRevision || (ourRev.major === key.majorRevision && ourRev.minor < key.minorRevision)) {
                return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0116 }; // Revision mismatch
            }
        } else if (key.majorRevision !== 0 && (ourRev.major !== key.majorRevision || ourRev.minor !== key.minorRevision)) {
            return { generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0116 };
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
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }

        const keyError = this._checkElectronicKey(path.electronicKey);
        if (keyError) {
            return { ok: false, ...keyError };
        }

        const [o2tInstance, t2oInstance] = path.connectionPoints || [];
        if (o2tInstance === undefined || t2oInstance === undefined) {
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }
        if (!this.assemblyObject.has(o2tInstance) || !this.assemblyObject.has(t2oInstance)) {
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 }; // connection not found at target
        }

        const outputBuf = this.assemblyObject.getData(o2tInstance);
        const inputBuf = this.assemblyObject.getData(t2oInstance);
        if (outputBuf.length !== request.otSize || inputBuf.length !== request.toSize) {
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0113 }; // connection size mismatch
        }

        const otNetworkConnectionId = this._nextConnectionId++;
        const state = {
            otNetworkConnectionId,
            toNetworkConnectionId: request.toNetworkConnectionId,
            connectionSerialNumber: request.connectionSerialNumber,
            originatorVendorId: request.originatorVendorId,
            originatorSerialNumber: request.originatorSerialNumber,
            o2tInstance,
            t2oInstance,
            remoteAddress,
            remotePort: null,
            sequenceNumber: 0,
            useRunIdleHeader: Boolean(request.useRunIdleHeader),
            runIdle: true,
            timer: null
        };

        const rpiMs = Math.max(1, Math.round(request.toRpiUs / 1000));
        state.timer = setInterval(() => {
            state.sequenceNumber++;
            const datagram = buildIoDatagram({
                connectionId: state.toNetworkConnectionId,
                sequenceNumber: state.sequenceNumber,
                data: this.assemblyObject.getData(t2oInstance),
                useRunIdleHeader: state.useRunIdleHeader,
                runIdle: true
            });
            this.sendDatagram(datagram, state.remoteAddress, state.remotePort);
        }, rpiMs);

        this.connections.set(otNetworkConnectionId, state);

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
                state.remoteAddress = rinfo.address;
            }
            const outputBuf = this.assemblyObject.getData(state.o2tInstance);
            let payload = parsed.data;
            if (payload.length === outputBuf.length + 4) {
                // 32-bit Run/Idle header present
                state.runIdle = Boolean(payload.readUInt32LE(0) & 0x01);
                payload = payload.slice(4);
            }
            if (payload.length === outputBuf.length) {
                this.assemblyObject.setData(state.o2tInstance, payload);
            }
            return;
        }
    }

    closeAll() {
        for (const state of this.connections.values()) clearInterval(state.timer);
        this.connections.clear();
    }
}

module.exports = { ConnectionHandler };
