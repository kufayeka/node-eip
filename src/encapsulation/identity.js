'use strict';

/**
 * Identity Item payload carried inside a ListIdentity response's CPF item
 * (type 0x000C) — CIP Vol 2, section 2-4.3, fields sourced from the
 * Identity Object (Vol 1, Ch 5-2).
 *
 * Documented byte-order exception: everything in this payload is
 * little-endian EXCEPT the embedded Socket Address structure, which mirrors
 * a native BSD `sockaddr_in` and is therefore big-endian (network byte
 * order) for sin_port/sin_addr — Wireshark's packet-enip.c dissector and
 * the CIP spec both call this out explicitly, and it's a common
 * from-scratch-implementer trap.
 *
 * Layout:
 *   Encapsulation Protocol Version   UINT   (2 bytes, LE)
 *   Socket Address                   16 bytes (BE fields, see decodeSocketAddress)
 *   Vendor ID                        UINT   (2 bytes, LE)
 *   Device Type                      UINT   (2 bytes, LE)
 *   Product Code                     UINT   (2 bytes, LE)
 *   Revision                         USINT major, USINT minor (2 bytes)
 *   Status                           WORD   (2 bytes, LE)
 *   Serial Number                    UDINT  (4 bytes, LE)
 *   Product Name                     SHORT_STRING (1 length byte + ASCII, no NUL)
 *   State                            USINT  (1 byte)
 */

function decodeSocketAddress(buf) {
    if (buf.length !== 16) {
        throw new RangeError('decodeSocketAddress: expected exactly 16 bytes');
    }
    const family = buf.readUInt16BE(0);
    const port = buf.readUInt16BE(2);
    const address = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    return { family, port, address };
}

function decodeIdentityItem(buf) {
    let offset = 0;

    const encapsulationProtocolVersion = buf.readUInt16LE(offset);
    offset += 2;

    const socketAddress = decodeSocketAddress(buf.subarray(offset, offset + 16));
    offset += 16;

    const vendorId = buf.readUInt16LE(offset);
    offset += 2;

    const deviceType = buf.readUInt16LE(offset);
    offset += 2;

    const productCode = buf.readUInt16LE(offset);
    offset += 2;

    const revisionMajor = buf.readUInt8(offset);
    const revisionMinor = buf.readUInt8(offset + 1);
    offset += 2;

    const status = buf.readUInt16LE(offset);
    offset += 2;

    const serialNumber = buf.readUInt32LE(offset);
    offset += 4;

    const productNameLength = buf.readUInt8(offset);
    offset += 1;

    const productName = buf.subarray(offset, offset + productNameLength).toString('ascii');
    offset += productNameLength;

    const state = buf.readUInt8(offset);
    offset += 1;

    return {
        encapsulationProtocolVersion,
        socketAddress,
        vendorId,
        deviceType,
        productCode,
        revision: { major: revisionMajor, minor: revisionMinor },
        status,
        serialNumber: serialNumber.toString(16).padStart(8, '0').toUpperCase(),
        productName,
        state,
        bytesConsumed: offset
    };
}

module.exports = {
    decodeSocketAddress,
    decodeIdentityItem
};
