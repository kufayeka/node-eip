'use strict';

/**
 * Connection Manager Object (Class 0x06) — Forward_Open / Forward_Close,
 * CIP Vol 1, section 3-5.5. Establishes/tears down a Class 1 (I/O,
 * implicit) or Class 3 (explicit) connection. This module only implements
 * the classic Forward_Open (service 0x54, network connection size up to
 * 511 bytes) — Large_Forward_Open (0x5B, up to 65535 bytes) is not needed
 * yet since every connection this driver has tested so far (Delta SX-3,
 * default 200 bytes / max 500 bytes per its own EDS) fits comfortably
 * under 511 bytes.
 *
 * Forward_Open/Forward_Close requests are themselves ordinary CIP Message
 * Router requests (service + path + data, see cip/message-router.js),
 * always addressed to Connection Manager Class 0x06 Instance 1 — NOT to be
 * confused with the "connection path" field embedded *inside* the request
 * data, which is the application object (e.g. an Assembly) the connection
 * is actually being made to.
 */

const { LogicalType, encodeLogicalSegment } = require('./path');

const ConnectionManagerServices = Object.freeze({
    ForwardClose: 0x4e,
    UnconnectedSend: 0x52,
    ForwardOpen: 0x54,
    LargeForwardOpen: 0x5b
});

function connectionManagerPath() {
    return Buffer.concat([
        encodeLogicalSegment(LogicalType.ClassId, 0x06),
        encodeLogicalSegment(LogicalType.InstanceId, 1)
    ]);
}

const ConnectionType = Object.freeze({ Null: 0, Multicast: 1, PointToPoint: 2, Reserved: 3 });
const ConnectionPriority = Object.freeze({ Low: 0, High: 1, Scheduled: 2, Urgent: 3 });

/**
 * Encodes the 16-bit Network Connection Parameters word (CIP Vol 1, Table
 * 3-5.13) used by classic Forward_Open for each direction (O->T/T->O).
 *   bits 0-8  : connection size, 0-511 bytes
 *   bit  9    : size type, 0 = fixed, 1 = variable
 *   bits 10-11: priority
 *   bit  12   : reserved (0)
 *   bits 13-14: connection type (Null/Multicast/PointToPoint)
 *   bit  15   : redundant owner (0 = exclusive, almost always 0)
 */
function encodeNetworkConnectionParams({ size, variableSize = false, priority = ConnectionPriority.Low, connectionType = ConnectionType.PointToPoint, redundantOwner = false }) {
    if (size < 0 || size > 511) {
        throw new RangeError(`encodeNetworkConnectionParams: size must be 0-511 for classic Forward_Open, got ${size}`);
    }
    let word = size & 0x1ff;
    if (variableSize) word |= 1 << 9;
    word |= (priority & 0x3) << 10;
    word |= (connectionType & 0x3) << 13;
    if (redundantOwner) word |= 1 << 15;
    return word;
}

function decodeNetworkConnectionParams(word) {
    return {
        size: word & 0x1ff,
        variableSize: Boolean((word >> 9) & 0x1),
        priority: (word >> 10) & 0x3,
        connectionType: (word >> 13) & 0x3,
        redundantOwner: Boolean((word >> 15) & 0x1)
    };
}

/** Encodes the Priority/Time_tick + Timeout_ticks pair that appears at the start of both requests. */
function encodeTimingBytes({ timeTick = 0x0a, timeoutTicks = 0x0e } = {}) {
    return Buffer.from([timeTick & 0xff, timeoutTicks & 0xff]);
}

let _nextConnectionSerial = 1;
/** Simple monotonic generator — good enough for one originator/process; not persisted across restarts. */
function nextConnectionSerialNumber() {
    const value = _nextConnectionSerial;
    _nextConnectionSerial = (_nextConnectionSerial + 1) & 0xffff || 1;
    return value;
}

/**
 * The T->O Network Connection ID is authoritative as sent by the originator
 * (the target must use exactly this value in its produced packets), so it
 * should be a reasonably unique nonzero value rather than a fixed constant
 * — matters once more than one connection/originator may be active against
 * the same target. (The O->T id is just a proposal; the target always
 * returns its own authoritative value in the Forward_Open response, so its
 * default is left at 0 — there's nothing to gain from randomizing it.)
 */
function randomUInt32() {
    return Math.floor(Math.random() * 0x100000000);
}

/**
 * Builds a Forward_Open request body (the CIP request DATA — caller wraps
 * it with cip/message-router.js's buildRequest({ service:
 * ConnectionManagerServices.ForwardOpen, path: connectionManagerPath(), data })).
 *
 * @param {object} opts
 * @param {Buffer} opts.connectionPath - application path, e.g. from
 *   cip/path.js's encodeAssemblyConnectionPath()
 * @param {number} [opts.rpiUs] - O->T and T->O Requested Packet Interval, in
 *   microseconds, if `otRpiUs`/`toRpiUs` aren't given separately.
 * @param {number} [opts.otSize] - O->T (originator->target) data size in bytes.
 * @param {number} [opts.toSize] - T->O (target->originator) data size in bytes.
 * @param {number} [opts.connectionSerialNumber] - defaults to an internal counter.
 * @param {number} [opts.originatorVendorId] - this driver's own Vendor ID (administrative, not wire-format-critical).
 * @param {number} [opts.originatorSerialNumber] - defaults to a fixed placeholder.
 * @param {number} [opts.transportTypeTrigger] - default 0x01: Transport Class 1, Trigger Cyclic, Direction Server — the conventional value for a plain cyclic I/O connection.
 */
function buildForwardOpenRequest({
    connectionPath,
    rpiUs = 20000,
    otRpiUs = rpiUs,
    toRpiUs = rpiUs,
    otSize,
    toSize,
    otConnectionType = ConnectionType.PointToPoint,
    toConnectionType = ConnectionType.PointToPoint,
    otVariableSize = false,
    toVariableSize = false,
    connectionTimeoutMultiplier = 3,
    timeTick = 0x0a,
    timeoutTicks = 0x0e,
    connectionSerialNumber = nextConnectionSerialNumber(),
    originatorVendorId = 0xffff,
    originatorSerialNumber = 0x00000001,
    otNetworkConnectionId = 0,
    toNetworkConnectionId = randomUInt32(),
    transportTypeTrigger = 0x01
}) {
    if (!Buffer.isBuffer(connectionPath) || connectionPath.length % 2 !== 0) {
        throw new RangeError('buildForwardOpenRequest: connectionPath must be an even-length Buffer (padded EPATH)');
    }
    if (typeof otSize !== 'number' || typeof toSize !== 'number') {
        throw new TypeError('buildForwardOpenRequest: otSize and toSize are required');
    }

    const parts = [];
    parts.push(encodeTimingBytes({ timeTick, timeoutTicks }));

    const idsAndSerial = Buffer.alloc(4 + 4 + 2 + 2 + 4);
    idsAndSerial.writeUInt32LE(otNetworkConnectionId, 0);
    idsAndSerial.writeUInt32LE(toNetworkConnectionId, 4);
    idsAndSerial.writeUInt16LE(connectionSerialNumber, 8);
    idsAndSerial.writeUInt16LE(originatorVendorId, 10);
    idsAndSerial.writeUInt32LE(originatorSerialNumber, 12);
    parts.push(idsAndSerial);

    parts.push(Buffer.from([connectionTimeoutMultiplier & 0xff, 0x00, 0x00, 0x00])); // + 3 reserved bytes

    const otParams = Buffer.alloc(6);
    otParams.writeUInt32LE(otRpiUs, 0);
    otParams.writeUInt16LE(encodeNetworkConnectionParams({ size: otSize, variableSize: otVariableSize, connectionType: otConnectionType }), 4);
    parts.push(otParams);

    const toParams = Buffer.alloc(6);
    toParams.writeUInt32LE(toRpiUs, 0);
    toParams.writeUInt16LE(encodeNetworkConnectionParams({ size: toSize, variableSize: toVariableSize, connectionType: toConnectionType }), 4);
    parts.push(toParams);

    parts.push(Buffer.from([transportTypeTrigger & 0xff]));
    parts.push(Buffer.from([connectionPath.length / 2]));
    parts.push(connectionPath);

    return { data: Buffer.concat(parts), connectionSerialNumber, originatorVendorId, originatorSerialNumber };
}

/**
 * Parses a successful Forward_Open response body (already unwrapped from
 * the Message Router envelope — pass response.data from
 * cip/message-router.js's parseResponse(), after confirming generalStatus
 * is Success).
 */
function parseForwardOpenResponse(data) {
    if (data.length < 26) {
        throw new RangeError('parseForwardOpenResponse: response too short');
    }
    const otNetworkConnectionId = data.readUInt32LE(0);
    const toNetworkConnectionId = data.readUInt32LE(4);
    const connectionSerialNumber = data.readUInt16LE(8);
    const originatorVendorId = data.readUInt16LE(10);
    const originatorSerialNumber = data.readUInt32LE(12);
    const otApiUs = data.readUInt32LE(16);
    const toApiUs = data.readUInt32LE(20);
    const appReplySizeWords = data.readUInt8(24);
    const appReplyEnd = 26 + appReplySizeWords * 2;
    const applicationReply = data.subarray(26, appReplyEnd);

    return {
        otNetworkConnectionId,
        toNetworkConnectionId,
        connectionSerialNumber,
        originatorVendorId,
        originatorSerialNumber,
        otApiUs,
        toApiUs,
        applicationReply
    };
}

/**
 * Builds a Forward_Close request body. `connectionSerialNumber`,
 * `originatorVendorId`, and `originatorSerialNumber` MUST match the values
 * used in the original Forward_Open (that triple is how the target looks
 * the connection up) — pass through the object buildForwardOpenRequest()
 * returned.
 */
function buildForwardCloseRequest({
    connectionPath,
    connectionSerialNumber,
    originatorVendorId,
    originatorSerialNumber,
    timeTick = 0x0a,
    timeoutTicks = 0x0e
}) {
    if (!Buffer.isBuffer(connectionPath) || connectionPath.length % 2 !== 0) {
        throw new RangeError('buildForwardCloseRequest: connectionPath must be an even-length Buffer (padded EPATH)');
    }

    const parts = [];
    parts.push(encodeTimingBytes({ timeTick, timeoutTicks }));

    const idsAndSerial = Buffer.alloc(2 + 2 + 4);
    idsAndSerial.writeUInt16LE(connectionSerialNumber, 0);
    idsAndSerial.writeUInt16LE(originatorVendorId, 2);
    idsAndSerial.writeUInt32LE(originatorSerialNumber, 4);
    parts.push(idsAndSerial);

    parts.push(Buffer.from([connectionPath.length / 2, 0x00])); // path size (words) + 1 reserved byte
    parts.push(connectionPath);

    return Buffer.concat(parts);
}

function parseForwardCloseResponse(data) {
    if (data.length < 10) {
        throw new RangeError('parseForwardCloseResponse: response too short');
    }
    const connectionSerialNumber = data.readUInt16LE(0);
    const originatorVendorId = data.readUInt16LE(2);
    const originatorSerialNumber = data.readUInt32LE(4);
    const appReplySizeWords = data.readUInt8(8);
    const appReplyEnd = 10 + appReplySizeWords * 2;
    const applicationReply = data.subarray(10, appReplyEnd);

    return { connectionSerialNumber, originatorVendorId, originatorSerialNumber, applicationReply };
}

/**
 * Parses an incoming Forward_Open request body — the inverse of
 * buildForwardOpenRequest(), needed on the Adapter (Phase 3) side to see
 * what a Scanner is asking to connect to. Field layout is the exact mirror
 * of buildForwardOpenRequest() above; see that function's comments for
 * what each field means.
 */
function parseForwardOpenRequest(data) {
    if (data.length < 36) {
        throw new RangeError('parseForwardOpenRequest: request too short');
    }
    const otParams = decodeNetworkConnectionParams(data.readUInt16LE(26));
    const toParams = decodeNetworkConnectionParams(data.readUInt16LE(32));
    const pathSizeWords = data.readUInt8(35);
    const connectionPath = data.subarray(36, 36 + pathSizeWords * 2);

    return {
        timeTick: data.readUInt8(0),
        timeoutTicks: data.readUInt8(1),
        otNetworkConnectionId: data.readUInt32LE(2),
        toNetworkConnectionId: data.readUInt32LE(6),
        connectionSerialNumber: data.readUInt16LE(10),
        originatorVendorId: data.readUInt16LE(12),
        originatorSerialNumber: data.readUInt32LE(14),
        connectionTimeoutMultiplier: data.readUInt8(18),
        otRpiUs: data.readUInt32LE(22),
        otSize: otParams.size,
        otConnectionType: otParams.connectionType,
        otVariableSize: otParams.variableSize,
        toRpiUs: data.readUInt32LE(28),
        toSize: toParams.size,
        toConnectionType: toParams.connectionType,
        toVariableSize: toParams.variableSize,
        transportTypeTrigger: data.readUInt8(34),
        connectionPath
    };
}

/**
 * Builds a Forward_Open response body — the inverse of
 * parseForwardOpenResponse(), used by an Adapter to accept a connection.
 * `otNetworkConnectionId` here is the Adapter's OWN authoritative value
 * (the Scanner's proposed one in the request may simply be ignored/replaced);
 * `toNetworkConnectionId`/`connectionSerialNumber`/`originatorVendorId`/
 * `originatorSerialNumber` must be echoed back exactly as the Scanner sent
 * them (see parseForwardOpenRequest()'s output).
 */
function buildForwardOpenResponse({
    otNetworkConnectionId,
    toNetworkConnectionId,
    connectionSerialNumber,
    originatorVendorId,
    originatorSerialNumber,
    otApiUs,
    toApiUs,
    applicationReply = Buffer.alloc(0)
}) {
    const buf = Buffer.alloc(26 + applicationReply.length);
    buf.writeUInt32LE(otNetworkConnectionId, 0);
    buf.writeUInt32LE(toNetworkConnectionId, 4);
    buf.writeUInt16LE(connectionSerialNumber, 8);
    buf.writeUInt16LE(originatorVendorId, 10);
    buf.writeUInt32LE(originatorSerialNumber, 12);
    buf.writeUInt32LE(otApiUs, 16);
    buf.writeUInt32LE(toApiUs, 20);
    buf.writeUInt8(applicationReply.length / 2, 24);
    buf.writeUInt8(0, 25);
    applicationReply.copy(buf, 26);
    return buf;
}

/** Parses an incoming Forward_Close request body — the inverse of buildForwardCloseRequest(). */
function parseForwardCloseRequest(data) {
    if (data.length < 12) {
        throw new RangeError('parseForwardCloseRequest: request too short');
    }
    const pathSizeWords = data.readUInt8(10);
    return {
        timeTick: data.readUInt8(0),
        timeoutTicks: data.readUInt8(1),
        connectionSerialNumber: data.readUInt16LE(2),
        originatorVendorId: data.readUInt16LE(4),
        originatorSerialNumber: data.readUInt32LE(6),
        connectionPath: data.subarray(12, 12 + pathSizeWords * 2)
    };
}

/** Builds a Forward_Close response body — the inverse of parseForwardCloseResponse(). */
function buildForwardCloseResponse({ connectionSerialNumber, originatorVendorId, originatorSerialNumber, applicationReply = Buffer.alloc(0) }) {
    const buf = Buffer.alloc(10 + applicationReply.length);
    buf.writeUInt16LE(connectionSerialNumber, 0);
    buf.writeUInt16LE(originatorVendorId, 2);
    buf.writeUInt32LE(originatorSerialNumber, 4);
    buf.writeUInt8(applicationReply.length / 2, 8);
    buf.writeUInt8(0, 9);
    applicationReply.copy(buf, 10);
    return buf;
}

/**
 * A small, deliberately non-exhaustive lookup of common Connection Manager
 * extended status codes (CIP Vol 1, Table B-2) for Forward_Open/Forward_Close
 * failures — for debugging only. Consult the CIP spec or Wireshark's
 * packet-enip.c for the authoritative full table.
 */
const ForwardOpenExtendedStatus = Object.freeze({
    0x0100: 'Connection in use or duplicate Forward Open',
    0x0103: 'Transport class/trigger combination not supported',
    0x0106: 'Ownership conflict',
    0x0107: 'Connection not found at target',
    0x0108: 'Invalid connection type',
    0x0109: 'Invalid connection size',
    0x0110: 'Module not configured',
    0x0111: 'RPI not acceptable (extended status may specify supported range)',
    0x0112: 'Module already owned by another originator',
    0x0113: 'Connection size mismatch',
    0x0114: 'Requested Packet Interval not supported',
    0x0115: 'No more connections available',
    0x0116: 'Vendor ID or Product Code mismatch',
    0x0117: 'Product Type mismatch',
    0x0118: 'Revision mismatch',
    0x0119: 'Invalid produced/consumed application path combination',
    0x011a: 'Invalid or inconsistent configuration application path',
    0x011e: 'Connection Manager cannot support any more connections',
    0x0120: 'Invalid segment in connection path',
    0x0121: 'Forward Close service connection path mismatch',
    0x0123: 'Link address to self invalid',
    0x0125: 'Rack connection already established',
    0x0126: 'Module connection already established',
    0x0128: 'Redundant connection mismatch'
});

module.exports = {
    ConnectionManagerServices,
    ConnectionType,
    ConnectionPriority,
    connectionManagerPath,
    encodeNetworkConnectionParams,
    decodeNetworkConnectionParams,
    buildForwardOpenRequest,
    parseForwardOpenResponse,
    parseForwardOpenRequest,
    buildForwardOpenResponse,
    buildForwardCloseRequest,
    parseForwardCloseResponse,
    parseForwardCloseRequest,
    buildForwardCloseResponse,
    nextConnectionSerialNumber,
    ForwardOpenExtendedStatus
};
