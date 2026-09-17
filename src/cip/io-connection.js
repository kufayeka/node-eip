'use strict';

/**
 * Class 0/1 (implicit/I-O) cyclic data datagram — CIP Vol 2, section 3-4.
 * Once Forward_Open establishes a connection, the Target starts producing
 * this data itself, unprompted, every RPI, as a raw UDP datagram to port
 * 2222 (`EIP_IO_UDP_PORT`) — NOT wrapped in the 24-byte TCP encapsulation
 * header used everywhere else in this driver (RegisterSession, SendRRData,
 * ...). The Originator sends its own O->T data the same way, to the same
 * port, on the Target's IP.
 *
 * Wire format is a 2-item Common Packet Format payload (reusing
 * encapsulation/cpf.js — the item list mechanics are identical, only the
 * item types differ from what SendRRData/ListIdentity use):
 *   Sequenced Address Item (type 0x8002, 8 bytes):
 *     Connection ID    UDINT (4 bytes) — the id the receiver assigned/chose
 *                       for this direction (see connection-manager.js)
 *     Sequence Number   UDINT (4 bytes) — incremented by the sender each
 *                       datagram, used to detect loss/reordering
 *   Connected Data Item (type 0x00B1, N bytes):
 *     the application I/O data itself — this driver only implements the
 *     "Modeless" real-time transfer format (no embedded 32-bit Run/Idle
 *     header), which is what this driver's own Forward_Open requests
 *     negotiate by leaving the Real Time Format bits at 0 (see
 *     connection-manager.js's encodeNetworkConnectionParams) — sufficient
 *     for reading a Target's produced (T->O) data. Sending O->T data that a
 *     Target requires a Run/Idle header for is a separate, not-yet-implemented
 *     concern.
 */

const { encodeCpf, decodeCpf, CpfItemType } = require('../encapsulation/cpf');

function buildIoDatagram({ connectionId, sequenceNumber, data }) {
    const address = Buffer.alloc(8);
    address.writeUInt32LE(connectionId >>> 0, 0);
    address.writeUInt32LE(sequenceNumber >>> 0, 4);

    return encodeCpf([
        { typeId: CpfItemType.SequencedAddress, data: address },
        { typeId: CpfItemType.ConnectedTransportData, data }
    ]);
}

function parseIoDatagram(buf) {
    const { items } = decodeCpf(buf);
    const addressItem = items.find((item) => item.typeId === CpfItemType.SequencedAddress);
    const dataItem = items.find((item) => item.typeId === CpfItemType.ConnectedTransportData);

    if (!addressItem || !dataItem) {
        throw new Error('parseIoDatagram: expected a Sequenced Address item (0x8002) and a Connected Data item (0x00B1)');
    }
    if (addressItem.data.length !== 8) {
        throw new RangeError('parseIoDatagram: Sequenced Address item must be exactly 8 bytes');
    }

    return {
        connectionId: addressItem.data.readUInt32LE(0),
        sequenceNumber: addressItem.data.readUInt32LE(4),
        data: dataItem.data
    };
}

module.exports = {
    buildIoDatagram,
    parseIoDatagram
};
