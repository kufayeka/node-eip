'use strict';

/**
 * CIP EPATH encoding — CIP Vol 1, Appendix C (C-1.4 Logical Segments).
 * Only the "padded" logical segment forms are implemented here (the ones
 * every explicit-messaging client uses in practice for Class/Instance/
 * Attribute addressing); Port segments, Data segments, and the ANSI
 * extended symbol segment are a separate, additive concern layered on top
 * later — NOT Rockwell/Logix-exclusive despite the common assumption:
 * Delta SX-3's own EDS file declares a `SYMBOL_ANSI` "Tag Connection" too.
 *
 * Segment byte layout for a padded Logical Segment:
 *   bits 7-5 = 001 (Logical Segment)
 *   bits 4-2 = Logical Type   (0 Class, 1 Instance, 2 Member, 3 Connection
 *                              Point, 4 Attribute, 5 Special, 6 Service ID)
 *   bits 1-0 = Logical Format (00 = 8-bit, 01 = 16-bit, 10 = 32-bit)
 *
 * 16-bit and 32-bit forms insert a single 0x00 pad byte after the segment
 * type byte before the value (hence "padded" EPATH), which keeps the whole
 * path an even number of bytes — required, since the CIP request header
 * expresses path length in 16-bit words.
 */

const LogicalType = Object.freeze({
    ClassId: 0,
    InstanceId: 1,
    MemberId: 2,
    ConnectionPoint: 3,
    AttributeId: 4,
    Special: 5,
    ServiceId: 6
});

function encodeLogicalSegment(logicalType, value) {
    if (value < 0 || !Number.isInteger(value)) {
        throw new RangeError(`encodeLogicalSegment: value must be a non-negative integer, got ${value}`);
    }

    if (value <= 0xff) {
        return Buffer.from([0x20 | (logicalType << 2) | 0x00, value]);
    }
    if (value <= 0xffff) {
        const buf = Buffer.alloc(4);
        buf[0] = 0x20 | (logicalType << 2) | 0x01;
        buf[1] = 0x00; // pad
        buf.writeUInt16LE(value, 2);
        return buf;
    }
    const buf = Buffer.alloc(6);
    buf[0] = 0x20 | (logicalType << 2) | 0x02;
    buf[1] = 0x00; // pad
    buf.writeUInt32LE(value, 2);
    return buf;
}

/**
 * Builds a padded EPATH from Class/Instance/Attribute (and, less commonly,
 * Connection Point/Member) logical segments, in the conventional order.
 * Any field left undefined is simply omitted from the path.
 */
/**
 * Encodes a CIP Port Segment — CIP Vol 1, Appendix C (C-1.3 Port Segment).
 * Supports standard ports (0-14), extended ports (>= 15), numeric link addresses (e.g. backplane slot),
 * and extended link addresses (string IP or node address) with required 16-bit word padding.
 *
 * @param {object} params
 * @param {number} params.port Port identifier (e.g. 1 = Backplane, 2 = Ethernet)
 * @param {number|string} params.linkAddress Numeric node/slot or ASCII string (e.g. "192.168.1.10")
 * @returns {Buffer}
 */
function encodePortSegment({ port, linkAddress = 0 }) {
    if (typeof port !== 'number' || port < 0 || !Number.isInteger(port)) {
        throw new RangeError(`encodePortSegment: port must be a non-negative integer, got ${port}`);
    }

    const isExtendedPort = port >= 15;
    const isExtendedLink = typeof linkAddress === 'string';
    const portNibble = isExtendedPort ? 15 : port;
    const extBit = isExtendedLink ? 0x10 : 0x00;
    const headerByte = 0x00 | extBit | (portNibble & 0x0F);

    if (!isExtendedPort && !isExtendedLink) {
        // Standard port, numeric link address (2 bytes)
        const addrNum = Number(linkAddress);
        if (addrNum < 0 || addrNum > 255) {
            throw new RangeError(`encodePortSegment: numeric link address must fit in a single byte (0-255), got ${addrNum}`);
        }
        return Buffer.from([headerByte, addrNum]);
    }

    if (!isExtendedPort && isExtendedLink) {
        // Standard port, extended link address (string)
        const addrBuf = Buffer.from(String(linkAddress), 'ascii');
        const len = addrBuf.length;
        const padNeeded = len % 2 !== 0;
        const totalLen = 2 + len + (padNeeded ? 1 : 0);
        const buf = Buffer.alloc(totalLen);
        buf[0] = headerByte;
        buf[1] = len;
        addrBuf.copy(buf, 2);
        if (padNeeded) {
            buf[totalLen - 1] = 0x00; // Pad byte to preserve 16-bit word boundary
        }
        return buf;
    }

    if (isExtendedPort && !isExtendedLink) {
        // Extended port, numeric link address (4 bytes: header + 2-byte port + 1-byte addr + 1-byte pad)
        const addrNum = Number(linkAddress);
        const buf = Buffer.alloc(4);
        buf[0] = headerByte;
        buf.writeUInt16LE(port, 1);
        buf[3] = addrNum;
        return buf;
    }

    // Extended port, extended link address
    const addrBuf = Buffer.from(String(linkAddress), 'ascii');
    const len = addrBuf.length;
    const padNeeded = (4 + len) % 2 !== 0;
    const totalLen = 4 + len + (padNeeded ? 1 : 0);
    const buf = Buffer.alloc(totalLen);
    buf[0] = headerByte;
    buf.writeUInt16LE(port, 1);
    buf[3] = len;
    addrBuf.copy(buf, 4);
    if (padNeeded) {
        buf[totalLen - 1] = 0x00;
    }
    return buf;
}

/**
 * Decodes one CIP Port Segment starting at `offset`.
 * @returns {{ port: number, linkAddress: number|string, bytesConsumed: number }}
 */
function decodePortSegment(buf, offset = 0) {
    const head = buf[offset];
    if ((head & 0xE0) !== 0x00) {
        throw new Error(`decodePortSegment: byte 0x${head.toString(16)} at offset ${offset} is not a Port Segment`);
    }

    const isExtendedLink = (head & 0x10) !== 0;
    const portNibble = head & 0x0F;
    const isExtendedPort = portNibble === 15;

    let port = portNibble;
    let curr = offset + 1;

    if (isExtendedPort) {
        if (curr + 2 > buf.length) throw new RangeError('decodePortSegment: truncated extended port identifier');
        port = buf.readUInt16LE(curr);
        curr += 2;
    }

    let linkAddress;
    let bytesConsumed;

    if (!isExtendedLink) {
        if (curr >= buf.length) throw new RangeError('decodePortSegment: missing numeric link address');
        linkAddress = buf.readUInt8(curr);
        curr += 1;
        bytesConsumed = curr - offset;
    } else {
        if (curr >= buf.length) throw new RangeError('decodePortSegment: missing extended link address length');
        const len = buf.readUInt8(curr);
        curr += 1;
        if (curr + len > buf.length) throw new RangeError(`decodePortSegment: truncated extended link address (need ${len} bytes)`);
        linkAddress = buf.subarray(curr, curr + len).toString('ascii');
        curr += len;
        if ((curr - offset) % 2 !== 0) {
            curr += 1; // skip pad byte
        }
        bytesConsumed = curr - offset;
    }

    return { port, linkAddress, bytesConsumed };
}

/**
 * Builds a padded EPATH from Port segments and/or Class/Instance/Attribute
 * (and Connection Point/Member) logical segments, in standard CIP order.
 * Port segments always precede the target logical segment.
 */
function encodeEPath({
    port,
    linkAddress,
    portSegments,
    classId,
    instance,
    connectionPoint,
    member,
    attribute
} = {}) {
    const parts = [];

    // 1. Port Segments (for multi-hop routing)
    if (Array.isArray(portSegments)) {
        for (const seg of portSegments) {
            parts.push(encodePortSegment(seg));
        }
    } else if (port !== undefined) {
        parts.push(encodePortSegment({ port, linkAddress }));
    }

    // 2. Logical Segments
    if (classId !== undefined) parts.push(encodeLogicalSegment(LogicalType.ClassId, classId));
    if (instance !== undefined) parts.push(encodeLogicalSegment(LogicalType.InstanceId, instance));
    if (connectionPoint !== undefined) parts.push(encodeLogicalSegment(LogicalType.ConnectionPoint, connectionPoint));
    if (member !== undefined) parts.push(encodeLogicalSegment(LogicalType.MemberId, member));
    if (attribute !== undefined) parts.push(encodeLogicalSegment(LogicalType.AttributeId, attribute));

    return Buffer.concat(parts);
}

/**
 * Helper to build a multi-hop routing path: concatenates an array of port hops
 * followed by the target object's logical path.
 *
 * @param {Array<{port: number, linkAddress: number|string}>} hops Array of routing hops
 * @param {object|Buffer} target Target logical path object or Buffer
 * @returns {Buffer}
 */
function encodeRoutePath(hops, target) {
    const hopBuffers = (hops || []).map((h) => encodePortSegment(h));
    const targetBuf = Buffer.isBuffer(target) ? target : encodeEPath(target);
    return Buffer.concat([...hopBuffers, targetBuf]);
}

function encodeAssemblyConnectionPath({ configInstance, o2tInstance, t2oInstance, outputInstance, inputInstance }) {
    const o2t = o2tInstance !== undefined ? o2tInstance : outputInstance;
    const t2o = t2oInstance !== undefined ? t2oInstance : inputInstance;
    const segments = [encodeLogicalSegment(LogicalType.ClassId, 0x04)];
    if (configInstance !== undefined) {
        segments.push(encodeLogicalSegment(LogicalType.InstanceId, configInstance));
    }
    if (o2t !== undefined) {
        segments.push(encodeLogicalSegment(LogicalType.ConnectionPoint, o2t));
    }
    if (t2o !== undefined) {
        segments.push(encodeLogicalSegment(LogicalType.ConnectionPoint, t2o));
    }
    return Buffer.concat(segments);
}

/**
 * Decodes one padded Logical Segment starting at `offset`.
 */
function decodeLogicalSegment(buf, offset) {
    const head = buf[offset];
    if ((head & 0xe0) !== 0x20) {
        throw new Error(`decodeLogicalSegment: byte 0x${head.toString(16)} at offset ${offset} is not a padded Logical Segment`);
    }
    const logicalType = (head >> 2) & 0x07;
    const format = head & 0x03;

    if (format === 0x00) {
        return { logicalType, value: buf.readUInt8(offset + 1), bytesConsumed: 2 };
    }
    if (format === 0x01) {
        if (offset + 4 > buf.length) throw new RangeError('decodeLogicalSegment: truncated 16-bit segment');
        return { logicalType, value: buf.readUInt16LE(offset + 2), bytesConsumed: 4 };
    }
    if (format === 0x02) {
        if (offset + 6 > buf.length) throw new RangeError('decodeLogicalSegment: truncated 32-bit segment');
        return { logicalType, value: buf.readUInt32LE(offset + 2), bytesConsumed: 6 };
    }
    throw new Error(`decodeLogicalSegment: unsupported Logical Format 0x${format.toString(16)} (reserved)`);
}

/**
 * Decodes a full padded EPATH into:
 * { portSegments, classId, instance, attribute, member, connectionPoints }
 * Supports both Port Segments (Type 000xxx) and Logical Segments (Type 001xxx).
 */
function decodeEPath(buf) {
    const result = {};
    let offset = 0;
    while (offset < buf.length) {
        const segType = (buf[offset] >> 5) & 0x07;
        if (segType === 0) {
            // Port Segment (Type 000xxx)
            const portSeg = decodePortSegment(buf, offset);
            (result.portSegments = result.portSegments || []).push({
                port: portSeg.port,
                linkAddress: portSeg.linkAddress
            });
            offset += portSeg.bytesConsumed;
        } else if (segType === 1) {
            // Logical Segment (Type 001xxx)
            const segment = decodeLogicalSegment(buf, offset);
            switch (segment.logicalType) {
                case LogicalType.ClassId: result.classId = segment.value; break;
                case LogicalType.InstanceId: result.instance = segment.value; break;
                case LogicalType.AttributeId: result.attribute = segment.value; break;
                case LogicalType.MemberId: result.member = segment.value; break;
                case LogicalType.ConnectionPoint:
                    (result.connectionPoints = result.connectionPoints || []).push(segment.value);
                    break;
                default:
                    break;
            }
            offset += segment.bytesConsumed;
        } else {
            throw new Error(`decodeEPath: unsupported segment type 0x${segType.toString(16)} at offset ${offset}`);
        }
    }
    return result;
}

module.exports = {
    LogicalType,
    encodeLogicalSegment,
    decodeLogicalSegment,
    encodePortSegment,
    decodePortSegment,
    encodeRoutePath,
    encodeEPath,
    decodeEPath,
    encodeAssemblyConnectionPath
};
