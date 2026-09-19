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
const { ConnectionType } = require('../cip/connection-manager');
const { CipGeneralStatus } = require('../constants');

/** IPv4 dotted-quad -> unsigned 32-bit integer (no BigInt/regex fuss needed for this use). */
function ipToUint32(ip) {
    const p = String(ip || '0.0.0.0').trim().split('.').map(Number);
    return (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
}

/** True if two IPv4 addresses fall in the same subnet under the given netmask. */
function isSameSubnet(ipA, ipB, netmask) {
    const maskInt = ipToUint32(netmask);
    return (ipToUint32(ipA) & maskInt) === (ipToUint32(ipB) & maskInt);
}

/**
 * Production Trigger — CIP Vol 1, Table 3-4.5 "Transport Type/Trigger" byte
 * (bits 6-4). Carried in every Forward_Open request (connection-manager.js's
 * parseForwardOpenRequest() `transportTypeTrigger`) — the Scanner picks one
 * of these when it opens the connection; the EDS's Connection entry only
 * advertises which ones this device is willing to accept (see
 * eds-exporter.js's 0x04030002 capability mask), it doesn't select one itself.
 */
const ProductionTrigger = Object.freeze({ CYCLIC: 0, CHANGE_OF_STATE: 1, APPLICATION_OBJECT: 2 });

function decodeProductionTrigger(transportTypeTrigger) {
    if (typeof transportTypeTrigger !== 'number') return ProductionTrigger.CYCLIC;
    return (transportTypeTrigger >> 4) & 0x07;
}

function productionTriggerLabel(trigger) {
    if (trigger === ProductionTrigger.CYCLIC) return 'Cyclic';
    if (trigger === ProductionTrigger.APPLICATION_OBJECT) return 'Application Object';
    return 'Change-of-State';
}

class ConnectionHandler {
    constructor({ assemblyObject, identity, sendDatagram, connectionManagerObject, quiet = false, strictDuplicateConnections = false, tagStore = null, onTagWrite = null, tcpIpObject = null }) {
        this.assemblyObject = assemblyObject;
        this.identity = identity; // optional — enables Electronic Key validation below
        this.sendDatagram = sendDatagram; // (buffer, remoteAddress, remotePort, opts?) => void — opts.multicast routes to tcpIpObject.multicastAddress instead
        // Optional — the device's own TcpIpInterfaceObject (ip/netmask/multicastAddress),
        // needed for Multicast Class 1 I/O: the off-subnet rejection check (CIP Vol 2 §3-5.3 /
        // OpENer's own "for multicast, check if IP is within configured net because we send
        // TTL 1" check) and the actual multicast group address to produce to. Without it,
        // multicast Forward_Opens are rejected — see the numeric connection path below.
        this.tcpIpObject = tcpIpObject;
        // Tracks which connection currently OWNS multicast production for a given T->O
        // instance, keyed by t2oInstance — ported from OpENer's OpenProducingMulticastConnection()/
        // GetExistingProducerIoConnection(): only the FIRST multicast Forward_Open for a given
        // T->O instance actually starts a producer (timer + multicast send); every subsequent
        // multicast Forward_Open to the SAME instance is a "follower" that shares the owner's
        // already-running stream and toNetworkConnectionId, rather than starting its own
        // redundant unicast-per-listener stream — the entire point of multicast.
        this.multicastProducers = new Map(); // t2oInstance -> { toNetworkConnectionId, ownerConnId }
        this.connectionManagerObject = connectionManagerObject; // optional — tracks CIP connection stats
        this.connections = new Map(); // otNetworkConnectionId -> state
        this._nextConnectionId = 1;
        this.quiet = Boolean(quiet);
        this.onProduceData = null; // optional hook (t2oInstance) => void
        // Symbolic ("Produced/Consumed Tag") Class 1 I/O connections — see
        // openConnection()'s path.tagPath branch below. tagStore is the
        // adapter's own `name -> { type, buffer, value }` Map (EIPAdapter.tags),
        // shared by reference so writes here are visible to explicit-message
        // reads immediately. onTagWrite(name, buffer), if given, lets the
        // adapter own value-decoding and tagWrite/tagChange event emission for
        // incoming O->T tag data — the same role AssemblyObject's own 'change'/
        // 'write' events play for numeric I/O.
        this.tagStore = tagStore instanceof Map ? tagStore : new Map();
        this.onTagWrite = typeof onTagWrite === 'function' ? onTagWrite : null;
        // Connection TYPE (Exclusive-Owner / Input-Only / Listen-Only) classification —
        // ported from OpENer's appcontype.c (GetIoConnectionForConnectionData() and its
        // Get{ExclusiveOwner,InputOnly,ListenOnly}Connection() helpers), the ODVA-conformance-
        // tested reference implementation. Real devices do NOT infer connection type from
        // O->T size being zero — they pre-declare, per connection profile, three DISTINCT
        // (O->T instance, T->O instance) slot pairs, and classify a Forward_Open purely by
        // which slot's O->T instance number the request's path matches (Exclusive-Owner tried
        // first, then Input-Only, then Listen-Only) — see registerConnectionPoint() below,
        // called once per DeviceBuilder.defineConnection() with its own derived placeholder
        // O->T instances for the Input-Only/Listen-Only slots (see eds-exporter.js).
        // A Forward_Open whose (O->T, T->O) pair matches NONE of these registered slots falls
        // back to the pre-existing generic/legacy behavior (treated as if Exclusive-Owner,
        // consuming O->T normally) — this keeps every caller that never registers slots
        // (including all of this project's own pre-existing tests) working unchanged.
        this.exclusiveOwnerSlots = []; // [{ outputAssembly, inputAssembly }]
        this.inputOnlySlots = [];
        this.listenOnlySlots = [];
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

    /**
     * Declares one connection-type slot for a (O->T, T->O) instance pair — mirrors OpENer's
     * ConfigureExclusiveOwnerConnectionPoint()/ConfigureInputOnlyConnectionPoint()/
     * ConfigureListenOnlyConnectionPoint(). Call once per type per connection profile
     * (DeviceBuilder does this automatically from defineConnection()).
     *
     * @param {'exclusiveOwner'|'inputOnly'|'listenOnly'} type
     * @param {{ outputAssembly: number, inputAssembly: number }} slot
     */
    registerConnectionPoint(type, { outputAssembly, inputAssembly }) {
        const slot = { outputAssembly, inputAssembly };
        if (type === 'exclusiveOwner') this.exclusiveOwnerSlots.push(slot);
        else if (type === 'inputOnly') this.inputOnlySlots.push(slot);
        else if (type === 'listenOnly') this.listenOnlySlots.push(slot);
        else throw new TypeError(`registerConnectionPoint: unknown type "${type}"`);
        return this;
    }

    /**
     * Classifies a Forward_Open's (O->T, T->O) pair against the registered slots, in the
     * same priority order as OpENer's GetIoConnectionForConnectionData(): Exclusive-Owner,
     * then Input-Only, then Listen-Only. Returns null if no slot was ever registered for
     * this pair (legacy/generic behavior — see the constructor comment).
     */
    _classifyConnectionType(o2tInstance, t2oInstance) {
        if (this.exclusiveOwnerSlots.some((s) => s.outputAssembly === o2tInstance && s.inputAssembly === t2oInstance)) {
            return 'exclusiveOwner';
        }
        if (this.inputOnlySlots.some((s) => s.outputAssembly === o2tInstance && s.inputAssembly === t2oInstance)) {
            return 'inputOnly';
        }
        if (this.listenOnlySlots.some((s) => s.outputAssembly === o2tInstance && s.inputAssembly === t2oInstance)) {
            return 'listenOnly';
        }
        return null;
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

        // A symbolic tag path (path.tagPath) is a Produced/Consumed Tag Class 1
        // I/O connection, not an explicit-message connection, even though it
        // has no numeric connectionPoints either — handled in its own branch below.
        const isExplicit = !path.tagPath && (path.classId === 0x02 || (!path.connectionPoints || path.connectionPoints.length === 0));

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

        if (path.tagPath) {
            return this._openTagConnection(request, path.tagPath, { remoteAddress: cleanAddress });
        }

        const [o2tInstance, t2oInstance] = path.connectionPoints || [];
        if (o2tInstance === undefined || t2oInstance === undefined) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }

        // Classify BEFORE checking O->T existence: Input-Only/Listen-Only slots deliberately
        // use a placeholder O->T instance (e.g. 0xC0/0xC1) that isn't a real Assembly with
        // actual data — see registerConnectionPoint()'s doc comment — so requiring it to
        // exist would reject every legitimate Listen-Only/Input-Only Forward_Open outright.
        const connType = this._classifyConnectionType(o2tInstance, t2oInstance); // null = legacy/generic, unaffected by any of this
        const consumesO2T = connType !== 'inputOnly' && connType !== 'listenOnly';

        if (consumesO2T && !this.assemblyObject.has(o2tInstance)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'resource');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 }; // connection not found at target
        }
        if (!this.assemblyObject.has(t2oInstance)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'resource');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 };
        }

        // A Listen-Only connection cannot be established unless a "master" (Exclusive-Owner or
        // Input-Only) connection is already producing this T->O instance — ported from OpENer's
        // GetListenOnlyConnection() (CIP's own extended status 0x0119).
        if (connType === 'listenOnly') {
            const hasMaster = [...this.connections.values()].some((c) =>
                c.t2oInstance === t2oInstance && (c.connType === 'exclusiveOwner' || c.connType === 'inputOnly'));
            if (!hasMaster) {
                this.connectionManagerObject?.recordOpenRequest(false, 'resource');
                return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0119 };
            }
        }

        // Exclusive-Owner is, by definition, exclusive: a second one for the same T->O instance
        // from a DIFFERENT originator is an Ownership Conflict — ported from OpENer's
        // GetExclusiveOwnerConnection(). The SAME originator reconnecting still falls through to
        // the lenient supersede cleanup below, matching every other connection type's existing
        // reconnect-without-closing-first behavior.
        if (connType === 'exclusiveOwner') {
            const conflicting = [...this.connections.values()].find((c) =>
                c.connType === 'exclusiveOwner' &&
                c.t2oInstance === t2oInstance &&
                !(c.originatorVendorId === request.originatorVendorId && c.originatorSerialNumber === request.originatorSerialNumber));
            if (conflicting) {
                this.connectionManagerObject?.recordOpenRequest(false, 'resource');
                return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0106 };
            }
        }

        // Multicast T->O — CIP Vol 2 §3-5.3. Ported from OpENer's own check (cipconnectionmanager.c):
        // "for multicast, check if IP is within configured net because we send TTL 1" — a Scanner
        // outside this device's own subnet could never receive a TTL-1 multicast datagram anyway,
        // so reject it up front with the exact extended status OpENer uses for this.
        const wantsMulticast = request.toConnectionType === ConnectionType.Multicast;
        let multicastOwner = null;
        if (wantsMulticast) {
            if (!this.tcpIpObject || !isSameSubnet(cleanAddress, this.tcpIpObject.ip, this.tcpIpObject.netmask)) {
                this.connectionManagerObject?.recordOpenRequest(false, 'format');
                return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0813 };
            }
            multicastOwner = this.multicastProducers.get(t2oInstance) || null;
        }

        let outputBuf = consumesO2T ? this.assemblyObject.getData(o2tInstance) : null;
        let inputBuf = this.assemblyObject.getData(t2oInstance);

        const maxSize = request.isLarge ? 65535 : 511;
        // T->O is what WE produce (_startProducer's sendAtCurrentSeq) as a real UDP datagram, and
        // that datagram has TWO layers of overhead on top of the raw Assembly data that the CIP
        // Large Forward Open 65535B ceiling alone doesn't account for:
        //   1. This driver's own mandatory 2-byte transport Sequence Count, prepended
        //      unconditionally (includeSequenceCount: true — see that function's own comment).
        //   2. CPF framing (encapsulation/cpf.js's encodeCpf): 2-byte item count + a 12-byte
        //      Sequenced Address item (4-byte header + 8-byte data) + a 4-byte Connected Data item
        //      header = 18 bytes, before the Sequence Count and Assembly data even start.
        // Two failure modes follow from ignoring this: right at the Large Forward Open ceiling,
        // the Connected Data item's own length (UInt16LE in encodeCpf) overflows past 65535 and
        // crashes Buffer.writeUInt16LE outright; short of that, the full UDP datagram (all of the
        // above, ~20 bytes, plus the Assembly data) can still exceed IPv4's actual max UDP payload
        // (65507 bytes, i.e. 65535 - 20-byte UDP+IP header — no jumbograms here), which fails the
        // socket .send() call itself with EMSGSIZE. Both found via bench/tag-scale.js sweeping up
        // to a Large connection's real ceiling. O->T has no equivalent risk here: it's only ever
        // CONSUMED (parsed), never built by us, so whatever a Scanner actually sends is its own
        // problem to keep under the wire limit, not something our own code can overflow.
        const CPF_TO_FRAMING_OVERHEAD = 2 /* item count */ + 12 /* Sequenced Address item */ + 4 /* Connected Data item header */ + 2 /* our own Sequence Count */;
        const MAX_UDP_PAYLOAD_BYTES = 65507; // IPv4 max UDP payload (65535 - 8-byte UDP header - 20-byte IP header)
        const maxToSize = request.isLarge ? Math.min(maxSize - 2, MAX_UDP_PAYLOAD_BYTES - CPF_TO_FRAMING_OVERHEAD) : maxSize;

        // The requested O->T/T->O size does NOT have to equal this Assembly's own declared byte
        // size, and — this is the part earlier attempts at this check got backwards — this
        // Assembly must NOT be resized to match it either. Real Scanners (confirmed live against
        // Delta hardware, see EIP_DEBUG_RAW) commonly negotiate a Connection Size that already
        // includes this driver's own on-the-wire transport overhead: a mandatory 2-byte Sequence
        // Count on every Class 1 datagram (both directions), plus — for Exclusive-Owner/Input-Only
        // O->T, whose EDS entry advertises "4-byte Run/Idle header" (eds-exporter.js) — an extra
        // 4-byte Run/Idle header. So a device with a real 10-byte Assembly legitimately sees
        // otSize=16 (10+2+4) and toSize=12 (10+2) from such a Scanner.
        //
        // Resizing the Assembly to match that (what this project's code did for a long time,
        // including as recently as this same investigation) makes the Assembly's OWN length equal
        // the wire size — which then makes it IMPOSSIBLE for handleIncomingDatagram to ever detect
        // that a header is present, because "how many extra bytes are on the wire" is computed
        // by comparing the incoming payload length against the Assembly's OWN length, and after a
        // resize those are equal by construction. The transport header then lands unstripped at
        // the FRONT of the Assembly buffer, silently shifting every application byte after it —
        // this is exactly what DeviceBuilder's Parameter <-> Assembly member offsets assume can't
        // happen (offset 0 = the first configured Param, always), so it manifests as a "parameter"
        // that increments every packet (it's actually the raw wire Sequence Count) followed by one
        // reading a constant 1 (the raw Run/Idle header) — see eip_device.js's own history for the
        // exact live symptom this caused, and its own doc comment for why its previous fix (padding
        // the Assembly itself out to the full negotiated size) was the wrong end of this to patch.
        //
        // So: leave the Assembly at whatever size the application actually declared, tolerate a
        // request whose size is explained by that declared size plus the known transport overhead
        // (bounded per direction — O->T can carry both the Sequence Count and Run/Idle header,
        // T->O only ever carries the Sequence Count), and let handleIncomingDatagram's own
        // per-packet length comparison do the actual stripping deterministically. Still reject
        // anything outside that allowance (Extended Status 0x0109, CIP Vol 1 §3-5.5.2) — a size
        // that can't be explained this way is a genuine stale/wrong connection config, not overhead.
        // The absolute CIP protocol ceiling is checked first — a size that's nonsensically huge
        // (e.g. a garbled request) should fail as "exceeds the connection size limit", not get a
        // confusing "mismatched Assembly size" answer just because it also happens to be more
        // than OT_MAX_OVERHEAD/TO_MAX_OVERHEAD bytes past the Assembly's own size.
        if (request.otSize > maxSize || request.toSize > maxToSize) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0113 };
        }

        const OT_MAX_OVERHEAD = 6; // 2-byte Sequence Count + 4-byte Run/Idle header
        const TO_MAX_OVERHEAD = 2; // 2-byte Sequence Count only — T->O never carries a Run/Idle header
        if (consumesO2T && outputBuf && request.otSize > 0 &&
            (request.otSize < outputBuf.length || request.otSize > outputBuf.length + OT_MAX_OVERHEAD)) {
            if (process.env.EIP_DEBUG_RAW) {
                console.log(`\x1b[31m[SIZE MISMATCH]\x1b[0m O->T instance ${o2tInstance}: device has ${outputBuf.length}B, Scanner requested ${request.otSize}B`);
            }
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0109 };
        }
        if (inputBuf && request.toSize > 0 &&
            (request.toSize < inputBuf.length || request.toSize > inputBuf.length + TO_MAX_OVERHEAD)) {
            if (process.env.EIP_DEBUG_RAW) {
                console.log(`\x1b[31m[SIZE MISMATCH]\x1b[0m T->O instance ${t2oInstance}: device has ${inputBuf.length}B, Scanner requested ${request.toSize}B`);
            }
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0109 };
        }

        if (this.strictDuplicateConnections && this._findMatchingConnection(request)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'duplicate');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0100 };
        }

        // Clean up any existing connection to this SAME (O->T, T->O) point pair from the same
        // originator or endpoint (skipped in strict mode — see the matching comment in the
        // explicit-connection branch above). Scoped to the same connection points deliberately:
        // originatorVendorId/originatorSerialNumber are a per-CLIENT identity (client.js's
        // buildForwardOpenRequest defaults both to fixed placeholders unless the caller overrides
        // them — i.e. every connection a given Scanner instance opens shares the same values,
        // by design, same as a real PLC's fixed station identity across all the connections it
        // opens), NOT a per-connection one — matching on originator alone, without also requiring
        // the SAME point pair, silently evicted any OTHER still-live connection that same
        // client/PLC had open to a DIFFERENT assembly pair the moment it opened a second one.
        // That breaks the ordinary case of one Scanner (or one real PLC's Data Exchange table)
        // holding several simultaneous connections to the same device — found via
        // bench/tag-scale.js splitting a large tag count across multiple connections from one
        // Scanner, where connections 2-4 each silently killed the ones opened before them.
        if (!this.strictDuplicateConnections) {
            for (const [id, existing] of this.connections.entries()) {
                if (
                    existing.o2tInstance === o2tInstance && existing.t2oInstance === t2oInstance &&
                    (
                        (existing.originatorSerialNumber === request.originatorSerialNumber && existing.originatorVendorId === request.originatorVendorId) ||
                        existing.remoteAddress === cleanAddress
                    )
                ) {
                    if (existing.timer) clearInterval(existing.timer);
                    this.connections.delete(id);
                }
            }
        }

        const otNetworkConnectionId = (Math.floor(Math.random() * 0x3FFFFFFF) + 0x10000000) >>> 0;
        // A multicast FOLLOWER must use the OWNER's toNetworkConnectionId, not its own Scanner's
        // proposed one — every listener has to recognize the SAME connection ID in the shared
        // multicast stream's datagram header for the data to be accepted as theirs. Ported from
        // OpENer's OpenProducingMulticastConnection() ("we need to inform our originator on the
        // correct connection id").
        const toNetworkConnectionId = multicastOwner ? multicastOwner.toNetworkConnectionId : request.toNetworkConnectionId;
        const state = {
            otNetworkConnectionId,
            toNetworkConnectionId,
            connectionSerialNumber: request.connectionSerialNumber,
            originatorVendorId: request.originatorVendorId,
            originatorSerialNumber: request.originatorSerialNumber,
            o2tInstance,
            t2oInstance,
            connType, // 'exclusiveOwner' | 'inputOnly' | 'listenOnly' | null (legacy/generic)
            consumesO2T,
            otSize: request.otSize,
            toSize: request.toSize,
            toRpiUs: request.toRpiUs,
            remoteAddress: cleanAddress,
            remotePort: null,
            sequenceNumber: 1,
            productionTrigger: decodeProductionTrigger(request.transportTypeTrigger),
            useRunIdleHeader: Boolean(request.useRunIdleHeader),
            runIdle: true,
            multicast: wantsMulticast,
            isMulticastFollower: Boolean(multicastOwner),
            timer: null
        };

        if (multicastOwner) {
            // A follower shares the existing owner's already-running multicast stream — it gets
            // no producer/timer of its own (the whole point of multicast: one stream, many
            // listeners). It still needs its own entry in `connections` so Forward_Close and
            // status reporting work normally for it.
        } else {
            this._startProducer(state, () => this.assemblyObject.getData(t2oInstance), () => {
                if (typeof this.onProduceData === 'function') {
                    try { this.onProduceData(t2oInstance); } catch {}
                }
            });
            if (wantsMulticast) {
                this.multicastProducers.set(t2oInstance, { toNetworkConnectionId, ownerConnId: otNetworkConnectionId });
            }
        }

        this.connections.set(otNetworkConnectionId, state);
        this.connectionManagerObject?.recordOpenRequest(true);

        if (!this.quiet) {
            const rpiMs = Math.max(1, Math.round(request.toRpiUs / 1000));
            const trigger = productionTriggerLabel(state.productionTrigger);
            const typeLabel = connType ? ` [${connType}]` : '';
            const mcastLabel = wantsMulticast ? (multicastOwner ? ' [multicast follower]' : ' [multicast owner]') : '';
            console.log(`\x1b[32m[PLC CLASS 1 I/O CONNECTED]\x1b[0m \x1b[1m${cleanAddress}\x1b[0m${typeLabel}${mcastLabel} | O->T: Assem ${o2tInstance} (${request.otSize}B), T->O: Assem ${t2oInstance} (${request.toSize}B), RPI: ${rpiMs}ms, Trigger: ${trigger} | ConnID: 0x${otNetworkConnectionId.toString(16)}`);
        }

        return {
            ok: true,
            response: {
                otNetworkConnectionId,
                toNetworkConnectionId,
                connectionSerialNumber: request.connectionSerialNumber,
                originatorVendorId: request.originatorVendorId,
                originatorSerialNumber: request.originatorSerialNumber,
                otApiUs: request.otRpiUs,
                toApiUs: request.toRpiUs
            }
        };
    }

    /**
     * Opens a symbolic Produced/Consumed Tag Class 1 I/O connection — the
     * runtime counterpart of eds-exporter.js's "Tag Connection" / SYMBOL_ANSI
     * entry. Unlike a numeric Assembly connection, the path carries a tag
     * NAME (decodeEPath's path.tagPath) instead of Class/ConnectionPoint
     * segments, resolved against this adapter's own tag registry
     * (EIPAdapter.tags, shared here as `this.tagStore`).
     *
     * Matches real hardware convention (confirmed against this project's own
     * real Delta SX3 EDS, eds/031F000E0F0600010001.eds's own "Tag Connection":
     * O->T size 0, only T->O populated) — one tag, bound to whichever
     * direction(s) have a nonzero size in the Forward_Open request: O->T only
     * (Consumed, PLC writes it), T->O only (Produced, PLC reads it), or both
     * (the same tag, readable and writable).
     */
    _openTagConnection(request, tagName, { remoteAddress }) {
        const tag = this.tagStore.get(tagName);
        if (!tag) {
            this.connectionManagerObject?.recordOpenRequest(false, 'resource');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0107 }; // connection not found at target
        }

        const consumes = request.otSize > 0;
        const produces = request.toSize > 0;
        if (!consumes && !produces) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.PathSegmentError, extendedStatus: 0x0120 };
        }
        if ((consumes && request.otSize !== tag.buffer.length) || (produces && request.toSize !== tag.buffer.length)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'format');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0109 }; // invalid connection size
        }

        if (this.strictDuplicateConnections && this._findMatchingConnection(request)) {
            this.connectionManagerObject?.recordOpenRequest(false, 'duplicate');
            return { ok: false, generalStatus: CipGeneralStatus.ConnectionFailure, extendedStatus: 0x0100 };
        }
        // Scoped to the same tag name — see the matching comment on the numeric-Assembly cleanup
        // above for why matching on originator alone (without also requiring the same tag) is
        // wrong: it silently evicts any OTHER still-live symbolic Tag connection that same
        // client/PLC had open to a DIFFERENT tag.
        if (!this.strictDuplicateConnections) {
            for (const [id, existing] of this.connections.entries()) {
                if (
                    existing.tagName === tagName &&
                    (
                        (existing.originatorSerialNumber === request.originatorSerialNumber && existing.originatorVendorId === request.originatorVendorId) ||
                        existing.remoteAddress === remoteAddress
                    )
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
            tagName,
            consumes,
            produces,
            otSize: request.otSize,
            toSize: request.toSize,
            toRpiUs: request.toRpiUs,
            remoteAddress,
            remotePort: null,
            sequenceNumber: 1,
            productionTrigger: decodeProductionTrigger(request.transportTypeTrigger),
            timer: null
        };

        if (produces) {
            this._startProducer(state, () => (this.tagStore.get(tagName) || {}).buffer || Buffer.alloc(state.toSize));
        }

        this.connections.set(otNetworkConnectionId, state);
        this.connectionManagerObject?.recordOpenRequest(true);

        if (!this.quiet) {
            const dir = [consumes && 'Consumed', produces && 'Produced'].filter(Boolean).join('+');
            const trigger = productionTriggerLabel(state.productionTrigger);
            console.log(`\x1b[32m[PLC CLASS 1 TAG CONNECTED]\x1b[0m \x1b[1m${remoteAddress}\x1b[0m | Tag: "${tagName}" (${dir}), Trigger: ${trigger} | ConnID: 0x${otNetworkConnectionId.toString(16)}`);
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

    /**
     * Drives cyclic Class 1 production (setInterval @ RPI) for a connection,
     * OR — when the Scanner selected Change-of-State at Forward_Open time —
     * event-driven production: send immediately when data actually changes,
     * with the RPI still acting as a maximum "heartbeat" interval so the
     * Originator's connection watchdog never times out on an unchanging value,
     * OR — for Application Object trigger — no automatic timer at all: CIP
     * Vol 1's own definition of this trigger type is that the APPLICATION
     * decides exactly when to produce, not a fixed timer or automatic value
     * comparison. Ported from OpENer's own public API for this
     * (cipconnectionmanager.c's `TriggerConnections()`, which an OpENer-based
     * device's application code calls directly) — see triggerProduction()
     * below, this project's equivalent entry point.
     * Shared by both numeric Assembly connections and symbolic Tag connections.
     *
     * @param {object} state - connection state (mutated: .timer, .sequenceNumber, .lastSentData, .lastSentAt, ._send, ._getProducedData)
     * @param {() => Buffer} getRawData - reads the current T->O source buffer (Assembly or tag)
     * @param {() => void} [beforeProduce] - optional hook run just before each read (e.g. DeviceBuilder's onProduceData sync)
     */
    _startProducer(state, getRawData, beforeProduce) {
        // Always send the T->O source buffer's OWN natural length, never padded/truncated to
        // state.toSize (the negotiated wire size). Those two are legitimately different numbers:
        // a real Scanner's negotiated toSize commonly already includes this driver's own 2-byte
        // Sequence Count overhead (see openConnection()'s doc comment), which sendAtCurrentSeq
        // below adds separately via includeSequenceCount. Padding/truncating to toSize FIRST and
        // then also adding the Sequence Count double-counts that overhead, producing a wire
        // datagram 2 bytes longer than what was actually negotiated. The source buffer (an
        // Assembly instance or a connected tag) is always fixed-length once defined/connected
        // (AssemblyObject.setData and _openTagConnection's own size check both enforce this), so
        // there's nothing to pad or truncate here in the first place.
        const getProducedData = () => {
            if (typeof beforeProduce === 'function') {
                try { beforeProduce(); } catch {}
            }
            return getRawData();
        };

        // Sends at the CURRENT sequence number without advancing it — used
        // only for the very first packet, which must go out as sequence 1
        // (matches every real Scanner's expectation, and the pre-existing
        // behavior this refactor must not change).
        const sendAtCurrentSeq = (data) => {
            const datagram = buildIoDatagram({
                connectionId: state.toNetworkConnectionId,
                sequenceNumber: state.sequenceNumber,
                data,
                useRunIdleHeader: false,
                runIdle: true,
                includeSequenceCount: true
            });
            this.sendDatagram(datagram, state.remoteAddress, state.remotePort, { multicast: Boolean(state.multicast) });
            // A copy, not the live reference: getRawData() (e.g. AssemblyObject.getData())
            // typically returns the SAME underlying Buffer every call, mutated in place —
            // caching that reference directly would make every future Change-of-State
            // comparison compare the buffer to itself and never detect a change.
            state.lastSentData = Buffer.from(data);
            state.lastSentAt = Date.now();
        };

        // Advances the sequence number, then sends — used for every packet after the first.
        const send = (data) => {
            state.sequenceNumber = (state.sequenceNumber + 1) >>> 0 || 1;
            sendAtCurrentSeq(data);
        };

        // Exposed so triggerProduction() can produce on demand for Application Object trigger
        // connections, from outside this closure.
        state._send = send;
        state._getProducedData = getProducedData;

        const rpiMs = Math.max(1, Math.round((state.toRpiUs || 20000) / 1000));

        // Immediate first packet dispatch to prevent PLC connection watchdog timeout,
        // unconditionally, regardless of trigger mode — real devices do this too.
        // In ODVA CIP Transport Class 1 specification, Connected Data (item 0x00B1)
        // carries a 16-bit Sequence Count (transport header) so controllers (Delta, Rockwell, Omron)
        // do not consume the first 2 bytes of data as sequence numbers.
        sendAtCurrentSeq(getProducedData());

        if (state.productionTrigger === ProductionTrigger.CHANGE_OF_STATE) {
            // Poll at the RPI (capped at 50ms so a very slow RPI doesn't poll needlessly rarely),
            // but only actually transmit when the data changed or the RPI heartbeat is due — CIP
            // Vol 1 3-4.5.2: for a Change of State connection the RPI is the *maximum* production
            // interval, not a fixed cadence. This floor used to be hardcoded to 5ms regardless of
            // a lower RPI (e.g. a real Scanner negotiating RPI=1ms would still only get checked
            // every 5ms) -- found via a real Delta PLC session logging every actual T->O send
            // timestamp (see eip_device.js's --csv-to*/--hires flags and analyze-eip-dump.js): the
            // measured average interval sat at a suspiciously exact ~5ms regardless of the
            // negotiated RPI, which was this floor, not network/OS jitter (that showed up
            // separately, as console-logging-induced event-loop stalls, and was a different fix).
            // 1ms is the practical floor for setInterval itself; going lower would just busy-loop.
            const pollMs = Math.max(1, Math.min(rpiMs, 50));
            state.timer = setInterval(() => {
                const current = getProducedData();
                const changed = !state.lastSentData || !current.equals(state.lastSentData);
                const heartbeatDue = Date.now() - state.lastSentAt >= rpiMs;
                if (changed || heartbeatDue) send(current);
            }, pollMs);
        } else if (state.productionTrigger === ProductionTrigger.APPLICATION_OBJECT) {
            // No automatic timer — production only happens via an explicit
            // triggerProduction() call (plus the unconditional initial packet just above).
            state.timer = null;
        } else {
            state.timer = setInterval(() => send(getProducedData()), rpiMs);
        }
    }

    /**
     * Explicitly triggers production for Application-Object-trigger connections currently
     * producing the given T->O Assembly instance or symbolic tag name — CIP Vol 1's definition
     * of this trigger type is that the APPLICATION decides exactly when to produce, unlike
     * Cyclic's fixed timer or Change-of-State's automatic value comparison. Ported from OpENer's
     * own public `TriggerConnections()` API, which a device's application code calls the same
     * way. A no-op (returns 0) for any connection using a different trigger type, or if no
     * matching connection is currently open.
     *
     * @param {number|string} t2oInstanceOrTagName
     * @returns {number} how many connections were actually triggered
     */
    triggerProduction(t2oInstanceOrTagName) {
        let triggered = 0;
        for (const state of this.connections.values()) {
            const matches = state.tagName !== undefined
                ? state.tagName === t2oInstanceOrTagName
                : state.t2oInstance === t2oInstanceOrTagName;
            if (matches && state.productionTrigger === ProductionTrigger.APPLICATION_OBJECT && typeof state._send === 'function') {
                state._send(state._getProducedData());
                triggered += 1;
            }
        }
        return triggered;
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
                this._releaseMulticastOwnership(id, state);
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
            const isTagConnection = state.tagName !== undefined;
            if (isTagConnection && !state.consumes) return; // produce-only tag connection — nothing to consume
            if (!isTagConnection && state.consumesO2T === false) return; // Input-Only/Listen-Only — nothing to consume

            let payload = parsed.data;

            if (process.env.EIP_DEBUG_RAW && !isTagConnection) {
                console.log(`\x1b[35m[RAW O->T]\x1b[0m seq=${parsed.sequenceNumber} otSize=${state.otSize} rawLen=${payload.length} rawHex=${payload.toString('hex')}`);
            }

            // Strip CIP I/O transport headers (a mandatory 2-byte Sequence Count, and — for
            // Exclusive-Owner/Input-Only connections whose EDS entry advertises a 4-byte Run/Idle
            // header — that too) by comparing the datagram's actual length against the REAL target
            // buffer's own current length — NOT by sniffing the data's own numeric value (guessing
            // "is this 4-byte word 0 or 1?" is genuinely ambiguous whenever live application data
            // legitimately contains 0 or 1, e.g. status/command words), and NOT by resizing the
            // target buffer to match the wire size either (that makes the two lengths equal by
            // construction, so no header could ever be detected at all — see openConnection()'s own
            // doc comment on this for the full story, including the live production incident that
            // is why this comment exists). The target buffer's declared length is the one thing
            // that's actually fixed and known in advance; the header length is simply whatever is
            // left over once that's accounted for.
            const targetBuf = isTagConnection
                ? ((this.tagStore.get(state.tagName) || {}).buffer || Buffer.alloc(0))
                : this.assemblyObject.getData(state.o2tInstance);

            if (payload.length > targetBuf.length) {
                const headerLen = payload.length - targetBuf.length;
                // When a Run/Idle header is present it's always the 4 bytes immediately
                // preceding the application data — recovered here only for the runIdle status
                // flag; the strip itself doesn't depend on knowing this.
                if (headerLen >= 4) {
                    state.runIdle = Boolean(payload.readUInt32LE(headerLen - 4) & 0x01);
                }
                payload = payload.subarray(headerLen);
            } else if (payload.length < targetBuf.length) {
                // Genuinely too short to be this target's data plus known overhead — not a
                // header we can strip. Drop rather than write a truncated/misaligned buffer.
                if (!this.quiet) {
                    console.warn(`[EIP] O->T payload (${payload.length}B) shorter than target (${targetBuf.length}B) on connection 0x${state.otNetworkConnectionId.toString(16)}; dropping`);
                }
                return;
            }

            if (isTagConnection) {
                if (payload.length === 0) return;
                if (typeof this.onTagWrite === 'function') {
                    this.onTagWrite(state.tagName, payload);
                } else {
                    const tag = this.tagStore.get(state.tagName);
                    if (tag) tag.buffer = Buffer.from(payload);
                }
            } else {
                this.assemblyObject.setData(state.o2tInstance, payload);
            }
            return;
        }
    }

    closeAll() {
        for (const state of this.connections.values()) clearInterval(state.timer);
        this.connections.clear();
        this.multicastProducers.clear();
    }

    /**
     * If the connection just closed/timed out was the multicast OWNER for its T->O instance,
     * releases that ownership and closes every FOLLOWER connection still registered against it
     * (they have no producer of their own and nothing left to share — see the constructor's
     * multicastProducers doc comment). This is a deliberate simplification of OpENer's own
     * behavior: the reference stack instead tries to hand ownership over to another still-active
     * master connection first (transfer_master_connection()) before falling back to closing the
     * listeners; this project always falls back directly. Acceptable for now — see docs/ROADMAP.md.
     */
    _releaseMulticastOwnership(closedId, closedState) {
        if (!closedState.multicast || closedState.isMulticastFollower) return;
        const owner = this.multicastProducers.get(closedState.t2oInstance);
        if (!owner || owner.ownerConnId !== closedId) return;
        this.multicastProducers.delete(closedState.t2oInstance);
        for (const [id, state] of this.connections.entries()) {
            if (state.isMulticastFollower && state.t2oInstance === closedState.t2oInstance) {
                clearInterval(state.timer);
                this.connections.delete(id);
            }
        }
    }
}

module.exports = { ConnectionHandler, ProductionTrigger, decodeProductionTrigger };
