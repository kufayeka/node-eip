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
function encodeEPath({ classId, instance, connectionPoint, member, attribute } = {}) {
    const parts = [];
    if (classId !== undefined) parts.push(encodeLogicalSegment(LogicalType.ClassId, classId));
    if (instance !== undefined) parts.push(encodeLogicalSegment(LogicalType.InstanceId, instance));
    if (connectionPoint !== undefined) parts.push(encodeLogicalSegment(LogicalType.ConnectionPoint, connectionPoint));
    if (member !== undefined) parts.push(encodeLogicalSegment(LogicalType.MemberId, member));
    if (attribute !== undefined) parts.push(encodeLogicalSegment(LogicalType.AttributeId, attribute));
    return Buffer.concat(parts);
}

/**
 * Builds the conventional "3-connection-point" Assembly path used by
 * Forward Open when a device exposes separate Config/O->T/T->O assembly
 * instances in a single connection — e.g. Delta SX-3's own EDS file
 * (eds/031F000E0F0600010001.eds) declares its Connection1 path as exactly
 * this shape: `20 04 24 80 2C 64 2C 65` (Class 0x04, Instance 0x80=128
 * Config, Connection Point 0x64=100 O->T, Connection Point 0x65=101 T->O).
 * This is a generic CIP convention, not vendor-specific — any Connection
 * Point segment count/order combination is valid EPATH, but this 4-segment
 * form is by far the most common for Assembly-based I/O connections.
 */
function encodeAssemblyConnectionPath({ configInstance, o2tInstance, t2oInstance }) {
    return Buffer.concat([
        encodeLogicalSegment(LogicalType.ClassId, 0x04),
        encodeLogicalSegment(LogicalType.InstanceId, configInstance),
        encodeLogicalSegment(LogicalType.ConnectionPoint, o2tInstance),
        encodeLogicalSegment(LogicalType.ConnectionPoint, t2oInstance)
    ]);
}

/**
 * Decodes one padded Logical Segment starting at `offset`. Needed by the
 * Adapter (Phase 3) to parse incoming request paths — the Scanner side
 * only ever needed to encode paths it built itself.
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
 * Decodes a full padded EPATH into { classId, instance, attribute, member,
 * connectionPoints } — the inverse of encodeEPath()/encodeAssemblyConnectionPath().
 * Multiple Connection Point segments (as encodeAssemblyConnectionPath()
 * produces) collect into the `connectionPoints` array, in path order.
 */
function decodeEPath(buf) {
    const result = {};
    let offset = 0;
    while (offset < buf.length) {
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
                // Special/ServiceId segments: preserved positionally but not
                // specially interpreted — no adapter feature needs them yet.
                break;
        }
        offset += segment.bytesConsumed;
    }
    return result;
}

module.exports = {
    LogicalType,
    encodeLogicalSegment,
    decodeLogicalSegment,
    encodeEPath,
    decodeEPath,
    encodeAssemblyConnectionPath
};
