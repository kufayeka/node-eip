'use strict';

/**
 * CIP request/response framing via the Message Router Object (Class 0x02)
 * — CIP Vol 1, section 2-4.1. This is the vendor-neutral envelope every
 * CIP service request/response uses, whether carried unconnected
 * (SendRRData) or over an established connection (SendUnitData).
 *
 * Request:
 *   Service          USINT (1 byte, request service code, e.g. 0x0E Get_Attribute_Single)
 *   Path Size        USINT (1 byte, EPATH length in 16-bit WORDS, not bytes)
 *   Path             (Path Size * 2) bytes, padded EPATH — see cip/path.js
 *   Request Data     remaining bytes, service-specific
 *
 * Response:
 *   Reply Service    USINT (1 byte = request service | 0x80)
 *   Reserved         USINT (1 byte, must be 0)
 *   General Status   USINT (1 byte, CIP Vol 1 Appx B — see constants.js CipGeneralStatus)
 *   Ext Status Size  USINT (1 byte, in 16-bit WORDS)
 *   Ext Status       (Ext Status Size * 2) bytes, only present on certain errors
 *   Response Data    remaining bytes, service-specific (only meaningful if General Status is Success)
 */

function buildRequest({ service, path = Buffer.alloc(0), data = Buffer.alloc(0) }) {
    if (typeof service !== 'number') {
        throw new TypeError('buildRequest: service is required');
    }
    if (path.length % 2 !== 0) {
        throw new RangeError('buildRequest: path must be an even number of bytes (padded EPATH)');
    }

    const pathSizeWords = path.length / 2;
    return Buffer.concat([Buffer.from([service, pathSizeWords]), path, data]);
}

function parseResponse(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) {
        throw new RangeError('parseResponse: buffer too short for a CIP response header');
    }

    const replyService = buf.readUInt8(0);
    const reserved = buf.readUInt8(1);
    const generalStatus = buf.readUInt8(2);
    const extStatusSizeWords = buf.readUInt8(3);
    const extStatusEnd = 4 + extStatusSizeWords * 2;

    if (buf.length < extStatusEnd) {
        throw new RangeError('parseResponse: buffer shorter than declared additional-status size');
    }

    const additionalStatus = [];
    for (let i = 4; i < extStatusEnd; i += 2) {
        additionalStatus.push(buf.readUInt16LE(i));
    }

    return {
        service: replyService & 0x7f,
        reserved,
        generalStatus,
        additionalStatus,
        data: buf.subarray(extStatusEnd)
    };
}

/**
 * Parses an incoming CIP request (the inverse of buildRequest()) — needed
 * on the Adapter (Phase 3) side to see what a Scanner is asking for.
 * `path` is returned raw (still needs cip/path.js's decodeEPath() to
 * interpret it); this function only knows the request's own framing.
 */
function parseRequest(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) {
        throw new RangeError('parseRequest: buffer too short for a CIP request header');
    }

    const service = buf.readUInt8(0);
    const pathSizeWords = buf.readUInt8(1);
    const pathEnd = 2 + pathSizeWords * 2;
    if (buf.length < pathEnd) {
        throw new RangeError('parseRequest: buffer shorter than declared path size');
    }

    return {
        service,
        path: buf.subarray(2, pathEnd),
        data: buf.subarray(pathEnd)
    };
}

/**
 * Builds an outgoing CIP response (the inverse of parseResponse()) —
 * needed on the Adapter side to answer a Scanner's request.
 */
function buildResponse({ service, generalStatus, additionalStatus = [], data = Buffer.alloc(0) }) {
    if (typeof service !== 'number' || typeof generalStatus !== 'number') {
        throw new TypeError('buildResponse: service and generalStatus are required');
    }

    const header = Buffer.alloc(4);
    header.writeUInt8(service | 0x80, 0);
    header.writeUInt8(0, 1); // reserved
    header.writeUInt8(generalStatus, 2);
    header.writeUInt8(additionalStatus.length, 3);

    const extStatus = Buffer.alloc(additionalStatus.length * 2);
    additionalStatus.forEach((word, i) => extStatus.writeUInt16LE(word, i * 2));

    return Buffer.concat([header, extStatus, data]);
}

module.exports = {
    buildRequest,
    parseResponse,
    parseRequest,
    buildResponse
};
