'use strict';

/**
 * ODVA CIP Data Type System — CIP Vol 1, Appendix C (C-2 Data Type Specifications).
 *
 * Implements centralized binary codecs for CIP elementary data types,
 * bit-level access, packed boolean structures, and CIP string encodings.
 *
 * All multi-byte integers and IEEE-754 floating-point values are strictly
 * Little-Endian per ODVA specification.
 */

const CipDataTypeCode = Object.freeze({
    BOOL: 0xC1,         // Logical boolean (1 bit / 1 byte)
    SINT: 0xC2,         // Signed 8-bit integer
    INT: 0xC3,          // Signed 16-bit integer
    DINT: 0xC4,         // Signed 32-bit integer
    LINT: 0xC5,         // Signed 64-bit integer
    USINT: 0xC6,        // Unsigned 8-bit integer
    UINT: 0xC7,         // Unsigned 16-bit integer
    UDINT: 0xC8,        // Unsigned 32-bit integer
    ULINT: 0xC9,        // Unsigned 64-bit integer
    REAL: 0xCA,         // 32-bit IEEE 754 floating point
    LREAL: 0xCB,        // 64-bit IEEE 754 floating point
    STIME: 0xCC,        // Synchronous time
    DATE: 0xCD,         // Date
    TIME_OF_DAY: 0xCE,  // Time of day
    DATE_AND_TIME: 0xCF,// Date and time
    STRING: 0xD0,       // Character string (UINT16 length + ASCII characters)
    BYTE: 0xD1,         // 8-bit bit string
    WORD: 0xD2,         // 16-bit bit string
    DWORD: 0xD3,        // 32-bit bit string
    LWORD: 0xD4,        // 64-bit bit string
    STRING2: 0xD5,      // Wide character string
    FTIME: 0xD6,        // High-resolution duration
    LTIME: 0xD7,        // Extended duration
    ITIME: 0xD8,        // Short duration
    STRINGN: 0xD9,      // N-byte character string
    SHORT_STRING: 0xDA, // Character string (UINT8 length + ASCII characters)
    TIME: 0xDB,         // Duration (milliseconds)
    EPATH: 0xDC,        // CIP EPATH
    ENGUNIT: 0xDD,      // Engineering units
    STRINGI: 0xDE       // International character string
});

/**
 * CIP Type Metadata Dictionary
 */
const CIP_DATA_TYPES = Object.freeze({
    [CipDataTypeCode.BOOL]: {
        code: CipDataTypeCode.BOOL,
        name: 'BOOL',
        size: 1,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt8(offset) !== 0,
        write: (buf, val, offset = 0) => { buf.writeUInt8(val ? 1 : 0, offset); return 1; }
    },
    [CipDataTypeCode.SINT]: {
        code: CipDataTypeCode.SINT,
        name: 'SINT',
        size: 1,
        signed: true,
        read: (buf, offset = 0) => buf.readInt8(offset),
        write: (buf, val, offset = 0) => { buf.writeInt8(val, offset); return 1; }
    },
    [CipDataTypeCode.INT]: {
        code: CipDataTypeCode.INT,
        name: 'INT',
        size: 2,
        signed: true,
        read: (buf, offset = 0) => buf.readInt16LE(offset),
        write: (buf, val, offset = 0) => { buf.writeInt16LE(val, offset); return 2; }
    },
    [CipDataTypeCode.DINT]: {
        code: CipDataTypeCode.DINT,
        name: 'DINT',
        size: 4,
        signed: true,
        read: (buf, offset = 0) => buf.readInt32LE(offset),
        write: (buf, val, offset = 0) => { buf.writeInt32LE(val, offset); return 4; }
    },
    [CipDataTypeCode.LINT]: {
        code: CipDataTypeCode.LINT,
        name: 'LINT',
        size: 8,
        signed: true,
        read: (buf, offset = 0) => buf.readBigInt64LE(offset),
        write: (buf, val, offset = 0) => { buf.writeBigInt64LE(BigInt(val), offset); return 8; }
    },
    [CipDataTypeCode.USINT]: {
        code: CipDataTypeCode.USINT,
        name: 'USINT',
        size: 1,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt8(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt8(val, offset); return 1; }
    },
    [CipDataTypeCode.UINT]: {
        code: CipDataTypeCode.UINT,
        name: 'UINT',
        size: 2,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt16LE(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt16LE(val, offset); return 2; }
    },
    [CipDataTypeCode.UDINT]: {
        code: CipDataTypeCode.UDINT,
        name: 'UDINT',
        size: 4,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt32LE(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt32LE(val, offset); return 4; }
    },
    [CipDataTypeCode.ULINT]: {
        code: CipDataTypeCode.ULINT,
        name: 'ULINT',
        size: 8,
        signed: false,
        read: (buf, offset = 0) => buf.readBigUInt64LE(offset),
        write: (buf, val, offset = 0) => { buf.writeBigUInt64LE(BigInt(val), offset); return 8; }
    },
    [CipDataTypeCode.REAL]: {
        code: CipDataTypeCode.REAL,
        name: 'REAL',
        size: 4,
        signed: true,
        read: (buf, offset = 0) => buf.readFloatLE(offset),
        write: (buf, val, offset = 0) => { buf.writeFloatLE(val, offset); return 4; }
    },
    [CipDataTypeCode.LREAL]: {
        code: CipDataTypeCode.LREAL,
        name: 'LREAL',
        size: 8,
        signed: true,
        read: (buf, offset = 0) => buf.readDoubleLE(offset),
        write: (buf, val, offset = 0) => { buf.writeDoubleLE(val, offset); return 8; }
    },
    [CipDataTypeCode.BYTE]: {
        code: CipDataTypeCode.BYTE,
        name: 'BYTE',
        size: 1,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt8(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt8(val, offset); return 1; }
    },
    [CipDataTypeCode.WORD]: {
        code: CipDataTypeCode.WORD,
        name: 'WORD',
        size: 2,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt16LE(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt16LE(val, offset); return 2; }
    },
    [CipDataTypeCode.DWORD]: {
        code: CipDataTypeCode.DWORD,
        name: 'DWORD',
        size: 4,
        signed: false,
        read: (buf, offset = 0) => buf.readUInt32LE(offset),
        write: (buf, val, offset = 0) => { buf.writeUInt32LE(val, offset); return 4; }
    },
    [CipDataTypeCode.LWORD]: {
        code: CipDataTypeCode.LWORD,
        name: 'LWORD',
        size: 8,
        signed: false,
        read: (buf, offset = 0) => buf.readBigUInt64LE(offset),
        write: (buf, val, offset = 0) => { buf.writeBigUInt64LE(BigInt(val), offset); return 8; }
    }
});

// ==================== Encoded Type Helpers ====================

/**
 * Encodes a value into a newly allocated Buffer of the corresponding CIP type size.
 */
function encodeType(typeCode, value) {
    if (typeCode === CipDataTypeCode.SHORT_STRING) {
        return encodeShortString(String(value));
    }
    if (typeCode === CipDataTypeCode.STRING) {
        return encodeCipString(String(value));
    }
    const meta = CIP_DATA_TYPES[typeCode];
    if (!meta) {
        throw new TypeError(`encodeType: unsupported CIP type code 0x${typeCode.toString(16)}`);
    }
    const buf = Buffer.alloc(meta.size);
    meta.write(buf, value, 0);
    return buf;
}

/**
 * Decodes a value from buffer according to the given CIP type code.
 * @returns {{ value: any, bytesRead: number }}
 */
function decodeType(typeCode, buf, offset = 0) {
    if (typeCode === CipDataTypeCode.SHORT_STRING) {
        return decodeShortString(buf, offset);
    }
    if (typeCode === CipDataTypeCode.STRING) {
        return decodeCipString(buf, offset);
    }
    const meta = CIP_DATA_TYPES[typeCode];
    if (!meta) {
        throw new TypeError(`decodeType: unsupported CIP type code 0x${typeCode.toString(16)}`);
    }
    if (offset + meta.size > buf.length) {
        throw new RangeError(`decodeType: buffer truncated, need ${meta.size} bytes for ${meta.name} at offset ${offset}, have ${buf.length - offset}`);
    }
    return {
        value: meta.read(buf, offset),
        bytesRead: meta.size
    };
}

// ==================== Bit-Level / Packed Boolean Access (§30) ====================

/**
 * Reads a single bit from a buffer at the specified byte offset and bit index (0-7).
 */
function readBit(buf, byteOffset, bitOffset) {
    if (bitOffset < 0 || bitOffset > 7) {
        throw new RangeError(`readBit: bitOffset must be between 0 and 7, got ${bitOffset}`);
    }
    if (byteOffset >= buf.length) {
        throw new RangeError(`readBit: byteOffset ${byteOffset} out of range (buffer length ${buf.length})`);
    }
    return ((buf[byteOffset] >> bitOffset) & 0x01) === 1;
}

/**
 * Writes a single bit to a buffer at the specified byte offset and bit index (0-7).
 */
function writeBit(buf, byteOffset, bitOffset, value) {
    if (bitOffset < 0 || bitOffset > 7) {
        throw new RangeError(`writeBit: bitOffset must be between 0 and 7, got ${bitOffset}`);
    }
    if (byteOffset >= buf.length) {
        throw new RangeError(`writeBit: byteOffset ${byteOffset} out of range (buffer length ${buf.length})`);
    }
    if (value) {
        buf[byteOffset] |= (1 << bitOffset);
    } else {
        buf[byteOffset] &= ~(1 << bitOffset);
    }
}

/**
 * Resolves a packed bit member from a buffer given byte offset, bit offset, or mask.
 * E.g., resolving `MyStructure.Enable` from an attribute buffer.
 */
function resolveBitMember(buf, { byteOffset = 0, bitOffset = 0, mask } = {}) {
    if (mask !== undefined) {
        return (buf[byteOffset] & mask) === mask;
    }
    return readBit(buf, byteOffset, bitOffset);
}

// ==================== String Handling (§31) ====================

/**
 * Encodes a SHORT_STRING: 1-byte length count followed by ASCII character bytes.
 */
function encodeShortString(str) {
    const s = String(str);
    const len = Math.min(s.length, 255);
    const buf = Buffer.alloc(1 + len);
    buf.writeUInt8(len, 0);
    buf.write(s.slice(0, len), 1, len, 'ascii');
    return buf;
}

/**
 * Decodes a SHORT_STRING: 1-byte length count followed by ASCII character bytes.
 */
function decodeShortString(buf, offset = 0) {
    if (offset >= buf.length) {
        return { value: '', bytesRead: 0 };
    }
    const len = buf.readUInt8(offset);
    if (offset + 1 + len > buf.length) {
        throw new RangeError(`decodeShortString: truncated string, expected ${len} chars at offset ${offset + 1}`);
    }
    const value = buf.subarray(offset + 1, offset + 1 + len).toString('ascii');
    return { value, bytesRead: 1 + len };
}

/**
 * Encodes a standard CIP STRING: UINT16 length followed by ASCII characters.
 */
function encodeCipString(str) {
    const s = String(str);
    const len = Math.min(s.length, 65535);
    const buf = Buffer.alloc(2 + len);
    buf.writeUInt16LE(len, 0);
    buf.write(s.slice(0, len), 2, len, 'ascii');
    return buf;
}

/**
 * Decodes a standard CIP STRING: UINT16 length followed by ASCII characters.
 */
function decodeCipString(buf, offset = 0) {
    if (offset + 2 > buf.length) {
        return { value: '', bytesRead: 0 };
    }
    const len = buf.readUInt16LE(offset);
    if (offset + 2 + len > buf.length) {
        throw new RangeError(`decodeCipString: truncated string, expected ${len} chars at offset ${offset + 2}`);
    }
    const value = buf.subarray(offset + 2, offset + 2 + len).toString('ascii');
    return { value, bytesRead: 2 + len };
}

module.exports = {
    CipDataTypeCode,
    CIP_DATA_TYPES,
    encodeType,
    decodeType,
    readBit,
    writeBit,
    resolveBitMember,
    encodeShortString,
    decodeShortString,
    encodeCipString,
    decodeCipString
};
