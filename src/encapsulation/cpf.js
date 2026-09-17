'use strict';

/**
 * Common Packet Format (CPF) — CIP Vol 2, section 2-6.
 * Carries a list of address/data items inside the command-specific data of
 * SendRRData, SendUnitData, and ListIdentity/ListServices responses.
 *
 * Wire format (all fields little-endian, except each item's own payload
 * which may define its own byte order — see identity.js for the one
 * documented exception, the embedded sockaddr structure):
 *   Item Count   UINT (2 bytes)
 *   Item[0]      Type ID (UINT, 2 bytes) + Length (UINT, 2 bytes) + Data (Length bytes)
 *   Item[1..n]   ...
 */

function encodeCpf(items) {
    const parts = [Buffer.alloc(2)];
    parts[0].writeUInt16LE(items.length, 0);

    for (const item of items) {
        const data = item.data || Buffer.alloc(0);
        const head = Buffer.alloc(4);
        head.writeUInt16LE(item.typeId, 0);
        head.writeUInt16LE(data.length, 2);
        parts.push(head, data);
    }

    return Buffer.concat(parts);
}

function decodeCpf(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) {
        throw new RangeError('decodeCpf: buffer too short for item count');
    }

    const itemCount = buf.readUInt16LE(0);
    const items = [];
    let offset = 2;

    for (let i = 0; i < itemCount; i++) {
        if (offset + 4 > buf.length) {
            throw new RangeError(`decodeCpf: truncated item header at index ${i}`);
        }
        const typeId = buf.readUInt16LE(offset);
        const length = buf.readUInt16LE(offset + 2);
        offset += 4;
        if (offset + length > buf.length) {
            throw new RangeError(`decodeCpf: truncated item data at index ${i}`);
        }
        items.push({ typeId, data: buf.subarray(offset, offset + length) });
        offset += length;
    }

    return { items, bytesConsumed: offset };
}

// CIP Vol 2, Table 2-6.2 — item type IDs used across encapsulation commands.
const CpfItemType = Object.freeze({
    NullAddress: 0x0000,
    ConnectedAddress: 0x00a1,
    SequencedAddress: 0x8002,
    UnconnectedData: 0x00b2,
    ConnectedTransportData: 0x00b1,
    ListServicesResponse: 0x0100,
    ListIdentityResponse: 0x000c,
    SockaddrInfoOriginatorToTarget: 0x8000,
    SockaddrInfoTargetToOriginator: 0x8001
});

module.exports = {
    encodeCpf,
    decodeCpf,
    CpfItemType
};
