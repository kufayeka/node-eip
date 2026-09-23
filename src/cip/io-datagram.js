'use strict';

/**
 * Class 0/1 (implicit/I-O) cyclic data datagram — CIP Vol 1 Section 3-6.4 & Vol 2 Section 3-4.
 * Wire format encoding and decoding.
 */

const { encodeCpf, decodeCpf, CpfItemType } = require('../encapsulation/cpf');

/**
 * Builds an I/O datagram with Sequenced Address (0x8002) and Connected Data (0x00B1).
 *
 * @param {object} params
 * @param {number} params.connectionId - 32-bit network connection ID
 * @param {number} params.sequenceNumber - 32-bit sequence number
 * @param {Buffer} [params.data] - Application I/O data
 * @param {boolean} [params.useRunIdleHeader=false] - Whether to prepend 32-bit Run/Idle header
 * @param {boolean} [params.runIdle=true] - Run (true) or Idle (false) status
 * @param {boolean} [params.includeSequenceCount=false] - Whether to prepend the 16-bit Sequence Count
 * @returns {Buffer} Encoded CPF payload
 */
function buildIoDatagram({
    connectionId,
    sequenceNumber,
    data = Buffer.alloc(0),
    useRunIdleHeader = false,
    runIdle = true,
    includeSequenceCount = false
}) {
    const address = Buffer.alloc(8);
    address.writeUInt32LE(connectionId >>> 0, 0);
    address.writeUInt32LE(sequenceNumber >>> 0, 4);

    let payload = data || Buffer.alloc(0);
    if (useRunIdleHeader) {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(runIdle ? 1 : 0, 0);
        payload = Buffer.concat([header, payload]);
    }
    if (includeSequenceCount) {
        const seqBuf = Buffer.alloc(2);
        seqBuf.writeUInt16LE((sequenceNumber & 0xFFFF) || 1, 0);
        payload = Buffer.concat([seqBuf, payload]);
    }

    return encodeCpf([
        { typeId: CpfItemType.SequencedAddress, data: address },
        { typeId: CpfItemType.ConnectedTransportData, data: payload }
    ]);
}

/**
 * Parses an incoming Class 1 I/O datagram.
 *
 * @param {Buffer} buf - Raw UDP datagram buffer
 * @param {object} [options]
 * @param {boolean} [options.expectRunIdleHeader=false] - Whether to parse 32-bit Run/Idle header
 * @returns {{ connectionId: number, sequenceNumber: number, runIdle: boolean|null, data: Buffer }}
 */
function parseIoDatagram(buf, { expectRunIdleHeader = false } = {}) {
    const { items } = decodeCpf(buf);
    const addressItem = items.find((item) => item.typeId === CpfItemType.SequencedAddress);
    const dataItem = items.find((item) => item.typeId === CpfItemType.ConnectedTransportData);

    if (!addressItem || !dataItem) {
        throw new Error('parseIoDatagram: expected a Sequenced Address item (0x8002) and a Connected Data item (0x00B1)');
    }
    if (addressItem.data.length !== 8) {
        throw new RangeError('parseIoDatagram: Sequenced Address item must be exactly 8 bytes');
    }

    const connectionId = addressItem.data.readUInt32LE(0);
    const sequenceNumber = addressItem.data.readUInt32LE(4);

    let runIdle = null;
    let data = dataItem.data;

    if (expectRunIdleHeader) {
        if (data.length < 4) {
            throw new RangeError(`parseIoDatagram: expected 32-bit Run/Idle header, but data length is ${data.length} bytes`);
        }
        const headerVal = data.readUInt32LE(0);
        runIdle = Boolean(headerVal & 0x01);
        data = data.slice(4);
    }

    return {
        connectionId,
        sequenceNumber,
        runIdle,
        data
    };
}

module.exports = {
    buildIoDatagram,
    parseIoDatagram
};
