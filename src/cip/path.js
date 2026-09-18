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
 * Encodes an ANSI Extended Symbol Segment — CIP Vol 1, Appendix C (C-1.4.3 Data Segments).
 * Segment Type: 0x91 (0b10010001: Data Segment, subtype 17 = ANSI Extended Symbol).
 * Followed by 1 byte length, ASCII characters, and 1 pad byte if length is odd.
 *
 * @param {string} symbol Tag or symbol name
 * @returns {Buffer}
 */
function encodeAnsiSymbolSegment(symbol) {
    if (typeof symbol !== 'string' || symbol.length === 0) {
        throw new TypeError(`encodeAnsiSymbolSegment: symbol must be a non-empty string, got ${symbol}`);
    }
    const len = Buffer.byteLength(symbol, 'ascii');
    if (len > 255) {
        throw new RangeError(`encodeAnsiSymbolSegment: symbol length exceeds 255 bytes, got ${len}`);
    }
    const padNeeded = len % 2 !== 0;
    const totalLen = 2 + len + (padNeeded ? 1 : 0);
    const buf = Buffer.alloc(totalLen);
    buf[0] = 0x91;
    buf[1] = len;
    buf.write(symbol, 2, 'ascii');
    if (padNeeded) {
        buf[totalLen - 1] = 0x00; // Pad byte to preserve 16-bit word alignment
    }
    return buf;
}

/**
 * Decodes an ANSI Extended Symbol Segment starting at `offset`.
 *
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ symbol: string, bytesConsumed: number }}
 */
function decodeAnsiSymbolSegment(buf, offset = 0) {
    if (offset >= buf.length) {
        throw new RangeError(`decodeAnsiSymbolSegment: offset ${offset} exceeds buffer length ${buf.length}`);
    }
    const head = buf[offset];
    if (head !== 0x91) {
        throw new Error(`decodeAnsiSymbolSegment: byte 0x${head.toString(16)} at offset ${offset} is not an ANSI Extended Symbol Segment (expected 0x91)`);
    }
    if (offset + 2 > buf.length) {
        throw new RangeError('decodeAnsiSymbolSegment: truncated symbol segment header');
    }
    const len = buf[offset + 1];
    const pad = len % 2 !== 0 ? 1 : 0;
    const totalBytes = 2 + len + pad;
    if (offset + totalBytes > buf.length) {
        throw new RangeError(`decodeAnsiSymbolSegment: truncated symbol data (expected ${totalBytes} bytes, got ${buf.length - offset})`);
    }
    const symbol = buf.toString('ascii', offset + 2, offset + 2 + len);
    return { symbol, bytesConsumed: totalBytes };
}

/**
 * Encodes a complete symbolic tag path expression into EPATH segments (§26, §27).
 * Supports simple tags, dot-separated struct members, and bracketed array subscripts.
 * e.g. "TotalCount", "Motor.Speed", "Tanks[3]", "Lines[0].Motors[1].Current"
 *
 * @param {string} tagPath
 * @returns {Buffer}
 */
function encodeSymbolicPath(tagPath) {
    if (typeof tagPath !== 'string' || tagPath.trim().length === 0) {
        throw new TypeError(`encodeSymbolicPath: tagPath must be a non-empty string, got ${tagPath}`);
    }

    const segments = [];
    const parts = tagPath.trim().split('.');

    for (const part of parts) {
        if (!part) continue;
        const match = part.match(/^([^\[]+)((\[\d+\])+)$/);
        if (match) {
            const baseName = match[1];
            segments.push(encodeAnsiSymbolSegment(baseName));
            const indices = match[2].match(/\[(\d+)\]/g);
            for (const idxStr of indices) {
                const idx = parseInt(idxStr.slice(1, -1), 10);
                segments.push(encodeLogicalSegment(LogicalType.MemberId, idx));
            }
        } else {
            segments.push(encodeAnsiSymbolSegment(part));
        }
    }

    return Buffer.concat(segments);
}

/**
 * Decodes a series of ANSI Extended Symbol and Member segments back into a string tag path.
 *
 * @param {Buffer} buf
 * @param {number} [offset=0]
 * @returns {{ tagPath: string, tokens: Array<{type: 'symbol'|'member', value: string|number}>, bytesConsumed: number }}
 */
function decodeSymbolicPath(buf, offset = 0) {
    const tokens = [];
    let cur = offset;

    while (cur < buf.length) {
        const head = buf[cur];
        if (head === 0x91) {
            const seg = decodeAnsiSymbolSegment(buf, cur);
            tokens.push({ type: 'symbol', value: seg.symbol });
            cur += seg.bytesConsumed;
        } else if ((head & 0xe0) === 0x20 && ((head >> 2) & 0x07) === LogicalType.MemberId) {
            const seg = decodeLogicalSegment(buf, cur);
            tokens.push({ type: 'member', value: seg.value });
            cur += seg.bytesConsumed;
        } else {
            break;
        }
    }

    let tagPath = '';
    for (const token of tokens) {
        if (token.type === 'symbol') {
            tagPath = tagPath ? `${tagPath}.${token.value}` : token.value;
        } else if (token.type === 'member') {
            tagPath = `${tagPath}[${token.value}]`;
        }
    }

    return { tagPath, tokens, bytesConsumed: cur - offset };
}

/**
 * Builds a padded EPATH from Port segments, ANSI Symbolic segments, and/or
 * Class/Instance/Attribute logical segments in standard CIP order.
 */
function encodeEPath(params = {}) {
    if (typeof params === 'string') {
        return encodeSymbolicPath(params);
    }
    if (Buffer.isBuffer(params)) return params;

    const {
        port,
        linkAddress,
        portSegments,
        classId,
        instance,
        connectionPoint,
        member,
        attribute,
        tag,
        symbol
    } = params;
    const parts = [];

    // 1. Port Segments (for multi-hop routing)
    if (Array.isArray(portSegments)) {
        for (const seg of portSegments) {
            parts.push(encodePortSegment(seg));
        }
    } else if (port !== undefined) {
        parts.push(encodePortSegment({ port, linkAddress }));
    }

    // 2. Symbolic Segment (Tag Addressing)
    if (tag || symbol) {
        parts.push(encodeSymbolicPath(tag || symbol));
    }

    // 3. Logical Segments
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
 * @param {object|Buffer|string} target Target logical path object, string tag, or Buffer
 * @returns {Buffer}
 */
function encodeRoutePath(hops, target) {
    const hopBuffers = (hops || []).map((h) => encodePortSegment(h));
    const targetBuf = Buffer.isBuffer(target) ? target : encodeEPath(target);
    return Buffer.concat([...hopBuffers, targetBuf]);
}

/**
 * Encodes a Tag Connection Path for Produced/Consumed Tag I/O Connections (§26, §27).
 * Allows binding Class 1 I/O connections directly to symbolic tag names.
 *
 * @param {object} params
 * @param {string|Buffer} [params.configTag] Configuration tag name or buffer
 * @param {string|Buffer} [params.o2tTag] Originator-to-Target (Consumed) tag
 * @param {string|Buffer} [params.t2oTag] Target-to-Originator (Produced) tag
 * @returns {Buffer}
 */
function encodeTagConnectionPath({ configTag, o2tTag, t2oTag }) {
    const segments = [];
    if (configTag) {
        segments.push(Buffer.isBuffer(configTag) ? configTag : encodeSymbolicPath(configTag));
    }
    if (o2tTag) {
        segments.push(Buffer.isBuffer(o2tTag) ? o2tTag : encodeSymbolicPath(o2tTag));
    }
    if (t2oTag) {
        segments.push(Buffer.isBuffer(t2oTag) ? t2oTag : encodeSymbolicPath(t2oTag));
    }
    return Buffer.concat(segments);
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
 * Encodes an Electronic Key Segment — CIP Vol 1, Appendix C (C-1.4.5.2).
 * Segment byte: 0x34 (Logical Segment, Logical Type = Special (5), Logical
 * Format = 0). Unlike every other Logical Segment, "format 0" here does
 * NOT mean "8-bit value" — it means "this 10-byte structure follows":
 *   Key Format   USINT  (always 4 = the only format ODVA has ever defined)
 *   Vendor ID    UINT
 *   Device Type  UINT
 *   Product Code UINT
 *   Major Rev    USINT  (bit 7 = Compatibility flag)
 *   Minor Rev    USINT
 * Real Scanners (any conformant PLC, not just Rockwell) prepend this to a
 * Forward_Open connection path so the Target can verify it's actually
 * talking to the device the configuration tool thinks it is — decoding it
 * as if it were a plain Class/Instance/Attribute segment (a single 8-bit
 * value, 2 bytes total) desyncs every segment after it in the path,
 * which is exactly what caused this driver's Adapter to reject real
 * Forward_Open requests with Path Segment Error (0x04).
 */
function encodeElectronicKeySegment({ vendorId, deviceType, productCode, majorRevision, minorRevision, compatibility = false }) {
    const buf = Buffer.alloc(10);
    buf[0] = 0x34;
    buf[1] = 0x04; // Key Format 4 — the only one ODVA defines
    buf.writeUInt16LE(vendorId & 0xffff, 2);
    buf.writeUInt16LE(deviceType & 0xffff, 4);
    buf.writeUInt16LE(productCode & 0xffff, 6);
    buf[8] = (majorRevision & 0x7f) | (compatibility ? 0x80 : 0x00);
    buf[9] = minorRevision & 0xff;
    return buf;
}

function decodeElectronicKeySegment(buf, offset) {
    if (offset + 10 > buf.length) {
        throw new RangeError('decodeElectronicKeySegment: truncated Electronic Key Segment (need 10 bytes)');
    }
    const keyFormat = buf.readUInt8(offset + 1);
    const vendorId = buf.readUInt16LE(offset + 2);
    const deviceType = buf.readUInt16LE(offset + 4);
    const productCode = buf.readUInt16LE(offset + 6);
    const majorByte = buf.readUInt8(offset + 8);
    const minorRevision = buf.readUInt8(offset + 9);
    return {
        keyFormat,
        vendorId,
        deviceType,
        productCode,
        majorRevision: majorByte & 0x7f,
        minorRevision,
        compatibility: Boolean(majorByte & 0x80),
        bytesConsumed: 10
    };
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

    if (logicalType === LogicalType.Special && format === 0x00) {
        const key = decodeElectronicKeySegment(buf, offset);
        return { logicalType, electronicKey: key, bytesConsumed: key.bytesConsumed };
    }

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
                case LogicalType.Special:
                    if (segment.electronicKey) result.electronicKey = segment.electronicKey;
                    break;
                default:
                    break;
            }
            offset += segment.bytesConsumed;
        } else if (segType === 4 && buf[offset] === 0x91) {
            // Data Segment (Type 100xxx): ANSI Extended Symbol Segment (0x91)
            const sym = decodeSymbolicPath(buf, offset);
            result.tagPath = sym.tagPath;
            result.symbols = sym.tokens.filter((t) => t.type === 'symbol').map((t) => t.value);
            offset += sym.bytesConsumed;
        } else {
            throw new Error(`decodeEPath: unsupported segment type 0x${segType.toString(16)} (byte 0x${buf[offset].toString(16)}) at offset ${offset}`);
        }
    }
    return result;
}

module.exports = {
    LogicalType,
    encodeLogicalSegment,
    decodeLogicalSegment,
    encodeElectronicKeySegment,
    decodeElectronicKeySegment,
    encodePortSegment,
    decodePortSegment,
    encodeAnsiSymbolSegment,
    decodeAnsiSymbolSegment,
    encodeSymbolicPath,
    decodeSymbolicPath,
    encodeTagConnectionPath,
    encodeRoutePath,
    encodeEPath,
    decodeEPath,
    encodeAssemblyConnectionPath
};
