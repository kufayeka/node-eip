'use strict';

/**
 * CIP Fragmentation & Large Data Transfer Engine — CIP Vol 1, Section 33 & 34.
 *
 * Provides progressive chunking, offset tracking, and automated buffer reassembly
 * for explicit messaging operations exceeding standard MTU limits (e.g. 480-505 bytes):
 * - Handles CIP general status 0x06 (Partial Transfer) automatically.
 * - Slices large write buffers into MTU-safe chunks carrying 32-bit byte offsets.
 * - Emits progress and chunk events for large industrial data telemetry.
 */

const EventEmitter = require('events');
const { buildRequest, parseResponse } = require('./message-router');
const { CipGeneralStatus, CipCommonServices } = require('../constants');

const DEFAULT_MAX_CHUNK_SIZE = 480; // Safe for standard unconnected 505-byte buffer limits

/**
 * FragmentReader manages multi-part read requests with status 0x06 Partial Transfer.
 */
class FragmentReader extends EventEmitter {
    /**
     * @param {import('../client').EIPSession} session
     * @param {object} options
     * @param {number} [options.service=0x0E] - CIP Service (default: Get_Attribute_Single)
     * @param {Buffer} options.path - Encoded CIP EPATH
     * @param {number} [options.chunkSize=480] - Maximum requested chunk size
     * @param {number} [options.maxTotalBytes=10485760] - Safety ceiling (default 10 MB)
     */
    constructor(session, {
        service = CipCommonServices.GetAttributeSingle,
        path,
        chunkSize = DEFAULT_MAX_CHUNK_SIZE,
        maxTotalBytes = 10 * 1024 * 1024
    } = {}) {
        super();
        if (!session) throw new Error('FragmentReader: session is required');
        if (!path) throw new Error('FragmentReader: path is required');

        this.session = session;
        this.service = service;
        this.path = path;
        this.chunkSize = chunkSize;
        this.maxTotalBytes = maxTotalBytes;
    }

    /**
     * Executes the fragmented read to completion.
     * @returns {Promise<{ data: Buffer, fragmentsCount: number, totalBytes: number }>}
     */
    async read() {
        const chunks = [];
        let offset = 0;
        let fragmentsCount = 0;
        let done = false;

        while (!done) {
            // Build offset payload (32-bit unsigned little-endian)
            const offsetBuf = Buffer.alloc(4);
            offsetBuf.writeUInt32LE(offset >>> 0, 0);

            const request = buildRequest({
                service: this.service,
                path: this.path,
                data: offset === 0 ? Buffer.alloc(0) : offsetBuf
            });

            const response = await this.session.sendUnconnected(request);
            fragmentsCount++;

            if (response.generalStatus !== CipGeneralStatus.Success &&
                response.generalStatus !== CipGeneralStatus.PartialTransfer) {
                const ext = response.additionalStatus[0] !== undefined ? ` (extended 0x${response.additionalStatus[0].toString(16)})` : '';
                throw new Error(`Fragmented read failed at offset ${offset}: status 0x${response.generalStatus.toString(16)}${ext}`);
            }

            const chunkData = response.data || Buffer.alloc(0);
            chunks.push(chunkData);
            offset += chunkData.length;

            if (offset > this.maxTotalBytes) {
                throw new RangeError(`Fragmented read exceeded maxTotalBytes limit (${this.maxTotalBytes} bytes)`);
            }

            this.emit('chunk', {
                fragmentIndex: fragmentsCount,
                chunkLength: chunkData.length,
                totalBytes: offset,
                isPartial: response.generalStatus === CipGeneralStatus.PartialTransfer
            });

            this.emit('progress', {
                bytesRead: offset,
                fragmentsCount
            });

            if (response.generalStatus === CipGeneralStatus.Success) {
                done = true;
            }
        }

        const completeBuffer = Buffer.concat(chunks);
        return {
            data: completeBuffer,
            fragmentsCount,
            totalBytes: completeBuffer.length
        };
    }
}

/**
 * FragmentWriter manages multi-part chunked writes.
 */
class FragmentWriter extends EventEmitter {
    /**
     * @param {import('../client').EIPSession} session
     * @param {object} options
     * @param {number} [options.service=0x10] - CIP Service (default: Set_Attribute_Single)
     * @param {Buffer} options.path - Encoded CIP EPATH
     * @param {Buffer} options.data - Complete payload to write
     * @param {number} [options.chunkSize=480] - Chunk size per fragment
     */
    constructor(session, {
        service = CipCommonServices.SetAttributeSingle,
        path,
        data,
        chunkSize = DEFAULT_MAX_CHUNK_SIZE
    } = {}) {
        super();
        if (!session) throw new Error('FragmentWriter: session is required');
        if (!path) throw new Error('FragmentWriter: path is required');
        if (!Buffer.isBuffer(data)) throw new TypeError('FragmentWriter: data must be a Buffer');

        this.session = session;
        this.service = service;
        this.path = path;
        this.data = data;
        this.chunkSize = Math.max(1, chunkSize);
    }

    /**
     * Executes the fragmented write to completion.
     * @returns {Promise<{ ok: true, bytesWritten: number, fragmentsCount: number }>}
     */
    async write() {
        const totalLength = this.data.length;
        let offset = 0;
        let fragmentsCount = 0;

        // If data fits in one chunk, send directly
        if (totalLength <= this.chunkSize) {
            const request = buildRequest({
                service: this.service,
                path: this.path,
                data: this.data
            });
            const response = await this.session.sendUnconnected(request);
            if (response.generalStatus !== CipGeneralStatus.Success) {
                throw new Error(`Write failed: status 0x${response.generalStatus.toString(16)}`);
            }
            return { ok: true, bytesWritten: totalLength, fragmentsCount: 1 };
        }

        while (offset < totalLength) {
            const end = Math.min(offset + this.chunkSize, totalLength);
            const chunkSlice = this.data.subarray(offset, end);
            fragmentsCount++;

            // Prepend 32-bit unsigned offset
            const header = Buffer.alloc(4);
            header.writeUInt32LE(offset >>> 0, 0);
            const payload = Buffer.concat([header, chunkSlice]);

            const request = buildRequest({
                service: this.service,
                path: this.path,
                data: payload
            });

            const response = await this.session.sendUnconnected(request);

            if (response.generalStatus !== CipGeneralStatus.Success &&
                response.generalStatus !== CipGeneralStatus.PartialTransfer) {
                const ext = response.additionalStatus[0] !== undefined ? ` (extended 0x${response.additionalStatus[0].toString(16)})` : '';
                throw new Error(`Fragmented write failed at offset ${offset}: status 0x${response.generalStatus.toString(16)}${ext}`);
            }

            offset = end;

            this.emit('progress', {
                bytesWritten: offset,
                totalBytes: totalLength,
                percent: Math.round((offset / totalLength) * 100),
                fragmentsCount
            });
        }

        return {
            ok: true,
            bytesWritten: totalLength,
            fragmentsCount
        };
    }
}

/**
 * High-level helper: reads a large attribute or assembly using progressive fragmentation.
 */
async function readLargeData(session, {
    service = CipCommonServices.GetAttributeSingle,
    path,
    chunkSize = DEFAULT_MAX_CHUNK_SIZE,
    maxTotalBytes
} = {}) {
    const reader = new FragmentReader(session, {
        service,
        path,
        chunkSize,
        ...(maxTotalBytes ? { maxTotalBytes } : {})
    });
    return reader.read();
}

/**
 * High-level helper: writes a large attribute or assembly using progressive fragmentation.
 */
async function writeLargeData(session, {
    service = CipCommonServices.SetAttributeSingle,
    path,
    data,
    chunkSize = DEFAULT_MAX_CHUNK_SIZE
}) {
    const writer = new FragmentWriter(session, { service, path, data, chunkSize });
    return writer.write();
}

module.exports = {
    FragmentReader,
    FragmentWriter,
    readLargeData,
    writeLargeData,
    DEFAULT_MAX_CHUNK_SIZE
};
