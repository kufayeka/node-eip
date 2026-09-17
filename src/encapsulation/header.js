'use strict';

const { ENCAPSULATION_HEADER_LENGTH } = require('../constants');

/**
 * Encapsulation header, CIP Vol 2 section 2-3.1 — 24 bytes, all fields
 * little-endian:
 *   Command        UINT   (2 bytes)
 *   Length         UINT   (2 bytes)  — length of the data following this header
 *   Session Handle UDINT  (4 bytes)
 *   Status         UDINT  (4 bytes)
 *   Sender Context (8 bytes)          — opaque, echoed back verbatim by the target
 *   Options        UDINT  (4 bytes)  — reserved, must be 0
 */
function encodeHeader({ command, length = 0, sessionHandle = 0, status = 0, senderContext = Buffer.alloc(8), options = 0 }) {
    if (typeof command !== 'number') {
        throw new TypeError('encodeHeader: command is required');
    }
    if (senderContext.length !== 8) {
        throw new RangeError('encodeHeader: senderContext must be exactly 8 bytes');
    }

    const buf = Buffer.alloc(ENCAPSULATION_HEADER_LENGTH);
    buf.writeUInt16LE(command, 0);
    buf.writeUInt16LE(length, 2);
    buf.writeUInt32LE(sessionHandle >>> 0, 4);
    buf.writeUInt32LE(status >>> 0, 8);
    senderContext.copy(buf, 12);
    buf.writeUInt32LE(options >>> 0, 20);
    return buf;
}

function decodeHeader(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < ENCAPSULATION_HEADER_LENGTH) {
        throw new RangeError(`decodeHeader: buffer must be at least ${ENCAPSULATION_HEADER_LENGTH} bytes`);
    }

    return {
        command: buf.readUInt16LE(0),
        length: buf.readUInt16LE(2),
        sessionHandle: buf.readUInt32LE(4),
        status: buf.readUInt32LE(8),
        senderContext: buf.subarray(12, 20),
        options: buf.readUInt32LE(20)
    };
}

/**
 * Encapsulates a command + data payload into a full wire-ready buffer
 * (header with length auto-filled, followed by the data).
 */
function encodeMessage(fields, data = Buffer.alloc(0)) {
    const header = encodeHeader({ ...fields, length: data.length });
    return Buffer.concat([header, data]);
}

/**
 * Splits a full encapsulation message (header + data) read off the wire.
 * Returns null if `buf` does not yet contain a complete message (caller
 * should keep buffering until more bytes arrive over TCP).
 */
function decodeMessage(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < ENCAPSULATION_HEADER_LENGTH) {
        return null;
    }
    const header = decodeHeader(buf);
    const total = ENCAPSULATION_HEADER_LENGTH + header.length;
    if (buf.length < total) {
        return null;
    }
    return {
        header,
        data: buf.subarray(ENCAPSULATION_HEADER_LENGTH, total),
        bytesConsumed: total
    };
}

module.exports = {
    encodeHeader,
    decodeHeader,
    encodeMessage,
    decodeMessage
};
