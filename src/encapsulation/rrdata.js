'use strict';

/**
 * SendRRData — CIP Vol 2, section 2-4.8. Carries a single unconnected
 * request/reply CIP message (Message Router service call) inside an
 * encapsulation message. This is the vendor-neutral path for one-shot
 * "explicit messaging" (Get_Attribute_Single, Set_Attribute_Single, etc.)
 * once a session is registered — no Forward Open/connection required.
 *
 * Command-specific data:
 *   Interface Handle   UDINT (4 bytes, must be 0 for CIP)
 *   Timeout            UINT  (2 bytes, seconds; 0 = use encapsulation inactivity timeout)
 *   CPF                Common Packet Format items — for SendRRData this is
 *                       always exactly two items: a Null Address Item
 *                       (0x0000, empty — unconnected messages carry no
 *                       connection identifier) and an Unconnected Data Item
 *                       (0x00B2) whose data is the raw CIP request/response.
 */

const { encodeMessage, decodeMessage } = require('./header');
const { encodeCpf, decodeCpf, CpfItemType } = require('./cpf');
const { EncapsulationCommands, EncapsulationStatus } = require('../constants');

function buildSendRRData(sessionHandle, cipRequest, { timeoutSec = 0, senderContext = Buffer.alloc(8) } = {}) {
    const cpf = encodeCpf([
        { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
        { typeId: CpfItemType.UnconnectedData, data: cipRequest }
    ]);

    const prefix = Buffer.alloc(6);
    prefix.writeUInt32LE(0, 0); // Interface Handle — always 0 for CIP
    prefix.writeUInt16LE(timeoutSec, 4);

    const data = Buffer.concat([prefix, cpf]);
    return encodeMessage({ command: EncapsulationCommands.SendRRData, sessionHandle, senderContext }, data);
}

/**
 * Extracts the raw CIP response bytes from an already-decoded { header,
 * data } message (as produced by header.decodeMessage) — used by callers,
 * like client.js, that manage their own TCP buffering/dispatch and only
 * need the SendRRData-specific unwrapping.
 */
function readSendRRDataResponse({ header, data }) {
    if (header.command !== EncapsulationCommands.SendRRData) {
        throw new Error(`readSendRRDataResponse: unexpected command 0x${header.command.toString(16)}`);
    }
    if (header.status !== EncapsulationStatus.Success) {
        throw new Error(`readSendRRDataResponse: encapsulation status 0x${header.status.toString(16)}`);
    }
    if (data.length < 6) {
        throw new RangeError('readSendRRDataResponse: command-specific data shorter than the 6-byte prefix');
    }

    const { items } = decodeCpf(data.subarray(6));
    const unconnectedItem = items.find((item) => item.typeId === CpfItemType.UnconnectedData);
    if (!unconnectedItem) {
        throw new Error('readSendRRDataResponse: no Unconnected Data item (0x00B2) found in CPF');
    }

    return { header, cipResponse: unconnectedItem.data };
}

/**
 * Parses a full SendRRData response buffer (header + data) straight off
 * the wire. Returns null if the buffer is a response to a different
 * command, or doesn't yet contain a complete encapsulation message.
 */
function parseSendRRDataResponse(buf) {
    const msg = decodeMessage(buf);
    if (!msg) {
        return null;
    }
    if (msg.header.command !== EncapsulationCommands.SendRRData) {
        return null;
    }
    return readSendRRDataResponse(msg);
}

module.exports = {
    buildSendRRData,
    readSendRRDataResponse,
    parseSendRRDataResponse
};
