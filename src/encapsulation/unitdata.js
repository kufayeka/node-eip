'use strict';

/**
 * SendUnitData — CIP Vol 2, section 2-4.9. Carries a single Connected
 * Explicit Message (Class 3) inside an encapsulation message, over a
 * connection already established by Forward_Open — the Originator-side
 * counterpart of adapter.js's own SendUnitData receive handling (which this
 * mirrors field-for-field so the two sides actually agree on the wire
 * format, rather than each guessing independently).
 *
 * Command-specific data:
 *   Interface Handle   UDINT (4 bytes, must be 0 for CIP)
 *   Timeout            UINT  (2 bytes, reserved for connected messages — 0)
 *   CPF                Common Packet Format items — always exactly two: a
 *                       Connected Address Item (0x00A1, 4-byte connection ID
 *                       from Forward_Open) and a Connected Data Item (0x00B1)
 *                       whose data is a 16-bit Sequence Count followed by the
 *                       raw CIP request/response — the Target echoes the
 *                       same Sequence Count back so the Originator can match
 *                       a reply to its request independent of the
 *                       encapsulation layer's own Sender Context.
 */

const { encodeMessage, decodeMessage } = require('./header');
const { encodeCpf, decodeCpf, CpfItemType } = require('./cpf');
const { EncapsulationCommands, EncapsulationStatus } = require('../constants');

function buildSendUnitData(sessionHandle, connectionId, sequenceCount, cipRequest, { senderContext = Buffer.alloc(8) } = {}) {
    const addrBuf = Buffer.alloc(4);
    addrBuf.writeUInt32LE(connectionId >>> 0, 0);

    const seqBuf = Buffer.alloc(2);
    seqBuf.writeUInt16LE(sequenceCount & 0xffff, 0);
    const dataBuf = Buffer.concat([seqBuf, cipRequest]);

    const cpf = encodeCpf([
        { typeId: CpfItemType.ConnectedAddress, data: addrBuf },
        { typeId: CpfItemType.ConnectedTransportData, data: dataBuf }
    ]);

    const prefix = Buffer.alloc(6);
    prefix.writeUInt32LE(0, 0); // Interface Handle — always 0 for CIP
    prefix.writeUInt16LE(0, 4); // Timeout — reserved for connected messages

    const data = Buffer.concat([prefix, cpf]);
    return encodeMessage({ command: EncapsulationCommands.SendUnitData, sessionHandle, senderContext }, data);
}

/**
 * Extracts { connectionId, sequenceCount, cipResponse } from an already-decoded
 * { header, data } message (as produced by header.decodeMessage).
 */
function readSendUnitDataResponse({ header, data }) {
    if (header.command !== EncapsulationCommands.SendUnitData) {
        throw new Error(`readSendUnitDataResponse: unexpected command 0x${header.command.toString(16)}`);
    }
    if (header.status !== EncapsulationStatus.Success) {
        throw new Error(`readSendUnitDataResponse: encapsulation status 0x${header.status.toString(16)}`);
    }
    if (data.length < 6) {
        throw new RangeError('readSendUnitDataResponse: command-specific data shorter than the 6-byte prefix');
    }

    const { items } = decodeCpf(data.subarray(6));
    const addrItem = items.find((item) => item.typeId === CpfItemType.ConnectedAddress);
    const dataItem = items.find((item) => item.typeId === CpfItemType.ConnectedTransportData);
    if (!dataItem) {
        throw new Error('readSendUnitDataResponse: no Connected Data item (0x00B1) found in CPF');
    }

    const connectionId = addrItem && addrItem.data.length >= 4 ? addrItem.data.readUInt32LE(0) : 0;
    let payload = dataItem.data;
    let sequenceCount;
    if (payload.length >= 2) {
        sequenceCount = payload.readUInt16LE(0);
        payload = payload.subarray(2);
    }

    return { header, connectionId, sequenceCount, cipResponse: payload };
}

/**
 * Parses a full SendUnitData response buffer (header + data) straight off
 * the wire. Returns null if the buffer is a response to a different
 * command, or doesn't yet contain a complete encapsulation message.
 */
function parseSendUnitDataResponse(buf) {
    const msg = decodeMessage(buf);
    if (!msg) {
        return null;
    }
    if (msg.header.command !== EncapsulationCommands.SendUnitData) {
        return null;
    }
    return readSendUnitDataResponse(msg);
}

module.exports = {
    buildSendUnitData,
    readSendUnitDataResponse,
    parseSendUnitDataResponse
};
