'use strict';

/**
 * ODVA CIP Multiple Service Packet (0x0A) — CIP Vol 1, Section 3-5.5.
 *
 * Packages multiple CIP requests into a single Message Router request
 * (Class 0x02, Instance 1, Service 0x0A), reducing network round-trips.
 *
 * Request data format:
 *   Count:               UINT16 (number of packaged requests)
 *   Offset Table:        N x UINT16 (byte offset from start of Count to each sub-request)
 *   Sub-requests:        Concatenated CIP requests (service, pathSize, path, data)
 *
 * Response data format:
 *   Count:               UINT16 (number of replies)
 *   Offset Table:        N x UINT16 (byte offset from start of Count to each sub-reply)
 *   Sub-replies:         Concatenated CIP responses (replyService, reserved, generalStatus, extStatusSize, extStatus, data)
 */

const { CipCommonServices, CipGeneralStatus, CipClassCodes } = require('../constants');
const { encodeEPath } = require('./path');
const { buildRequest, parseResponse, buildResponse } = require('./message-router');

const MESSAGE_ROUTER_PATH = encodeEPath({ classId: CipClassCodes.MessageRouter || 0x02, instance: 1 });

/**
 * Encodes an array of sub-requests into a Multiple Service Packet (0x0A) payload.
 *
 * @param {Array<Buffer|{service: number, path?: Buffer, data?: Buffer}>} requests
 * @returns {Buffer} Raw Multiple Service Packet request data (count + offsets + sub-requests)
 */
function encodeMultipleServiceData(requests) {
    if (!Array.isArray(requests) || requests.length === 0) {
        throw new TypeError('encodeMultipleServiceData: requests must be a non-empty array');
    }

    const count = requests.length;
    const requestBuffers = requests.map((req) => {
        if (Buffer.isBuffer(req)) return req;
        return buildRequest(req);
    });

    const offsetTableSize = 2 + count * 2;
    const offsets = [];
    let currentOffset = offsetTableSize;

    for (let i = 0; i < count; i++) {
        offsets.push(currentOffset);
        currentOffset += requestBuffers[i].length;
    }

    const headerBuf = Buffer.alloc(offsetTableSize);
    headerBuf.writeUInt16LE(count, 0);
    for (let i = 0; i < count; i++) {
        headerBuf.writeUInt16LE(offsets[i], 2 + i * 2);
    }

    return Buffer.concat([headerBuf, ...requestBuffers]);
}

/**
 * Builds a complete CIP Multiple Service Packet request targeting the Message Router (0x02/1).
 *
 * @param {Array<Buffer|{service: number, path?: Buffer, data?: Buffer}>} requests
 * @returns {Buffer} CIP Request buffer ready to be sent via SendRRData
 */
function buildMultipleServiceRequest(requests) {
    const data = encodeMultipleServiceData(requests);
    return buildRequest({
        service: CipCommonServices.MultipleServicePacket,
        path: MESSAGE_ROUTER_PATH,
        data
    });
}

/**
 * Parses the response data of a successful Multiple Service Packet (0x0A).
 *
 * @param {Buffer} data Payload buffer of the Multiple Service response (starts with Count)
 * @returns {Array<{service: number, generalStatus: number, additionalStatus: number[], data: Buffer}>}
 */
function parseMultipleServiceResponse(data) {
    if (!Buffer.isBuffer(data) || data.length < 2) {
        throw new RangeError('parseMultipleServiceResponse: data too short for Multiple Service header');
    }

    const count = data.readUInt16LE(0);
    const expectedHeaderSize = 2 + count * 2;
    if (data.length < expectedHeaderSize) {
        throw new RangeError(`parseMultipleServiceResponse: data length (${data.length}) shorter than offset table (${expectedHeaderSize})`);
    }

    const offsets = [];
    for (let i = 0; i < count; i++) {
        offsets.push(data.readUInt16LE(2 + i * 2));
    }

    const responses = [];
    for (let i = 0; i < count; i++) {
        const start = offsets[i];
        const end = (i + 1 < count) ? offsets[i + 1] : data.length;
        if (start >= data.length || end > data.length || start >= end) {
            throw new RangeError(`parseMultipleServiceResponse: invalid sub-response offset range [${start}, ${end}) in data of length ${data.length}`);
        }
        const subBuf = data.subarray(start, end);
        responses.push(parseResponse(subBuf));
    }

    return responses;
}

/**
 * Encodes an array of sub-response buffers into a Multiple Service Packet response payload.
 * Used by EIPAdapter (server-side).
 *
 * @param {Array<Buffer|{service: number, generalStatus?: number, additionalStatus?: number[], data?: Buffer}>} responses
 * @returns {Buffer}
 */
function encodeMultipleServiceResponseData(responses) {
    const count = responses.length;
    const respBuffers = responses.map((r) => {
        if (Buffer.isBuffer(r)) return r;
        return buildResponse(r);
    });

    const offsetTableSize = 2 + count * 2;
    const offsets = [];
    let currentOffset = offsetTableSize;

    for (let i = 0; i < count; i++) {
        offsets.push(currentOffset);
        currentOffset += respBuffers[i].length;
    }

    const headerBuf = Buffer.alloc(offsetTableSize);
    headerBuf.writeUInt16LE(count, 0);
    for (let i = 0; i < count; i++) {
        headerBuf.writeUInt16LE(offsets[i], 2 + i * 2);
    }

    return Buffer.concat([headerBuf, ...respBuffers]);
}

module.exports = {
    MESSAGE_ROUTER_PATH,
    encodeMultipleServiceData,
    buildMultipleServiceRequest,
    parseMultipleServiceResponse,
    encodeMultipleServiceResponseData
};
