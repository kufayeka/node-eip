'use strict';

const { encodeMessage, decodeMessage } = require('./header');
const { EncapsulationCommands, EncapsulationStatus } = require('../constants');

const PROTOCOL_VERSION = 1;

/**
 * RegisterSession — CIP Vol 2, section 2-4.6. Command-specific data is a
 * fixed 4 bytes: Protocol Version (UINT) + Options Flags (UINT, must be 0).
 * Sent with Session Handle = 0; the target allocates and returns a nonzero
 * handle in the response header on success.
 */
function buildRegisterSessionRequest({ senderContext = Buffer.alloc(8), optionsFlags = 0 } = {}) {
    const data = Buffer.alloc(4);
    data.writeUInt16LE(PROTOCOL_VERSION, 0);
    data.writeUInt16LE(optionsFlags, 2);
    return encodeMessage({ command: EncapsulationCommands.RegisterSession, sessionHandle: 0, senderContext }, data);
}

/**
 * Validates and extracts fields from an already-decoded { header, data }
 * message (as produced by header.decodeMessage). Throws if the header
 * reports a nonzero encapsulation status (e.g. UnsupportedProtocolRevision)
 * or the command doesn't match RegisterSession.
 */
function readRegisterSessionResponse({ header, data }) {
    if (header.command !== EncapsulationCommands.RegisterSession) {
        throw new Error(`readRegisterSessionResponse: unexpected command 0x${header.command.toString(16)}`);
    }
    if (header.status !== EncapsulationStatus.Success) {
        throw new Error(`readRegisterSessionResponse: target rejected session, status 0x${header.status.toString(16)}`);
    }
    if (data.length < 4) {
        throw new RangeError('readRegisterSessionResponse: command-specific data shorter than 4 bytes');
    }

    return {
        sessionHandle: header.sessionHandle,
        protocolVersion: data.readUInt16LE(0),
        optionsFlags: data.readUInt16LE(2)
    };
}

/**
 * Parses a full RegisterSession response buffer (header + data) straight
 * off the wire. Returns null if the buffer doesn't yet contain a complete
 * encapsulation message.
 */
function parseRegisterSessionResponse(buf) {
    const msg = decodeMessage(buf);
    if (!msg) {
        return null;
    }
    return readRegisterSessionResponse(msg);
}

/**
 * UnRegisterSession — CIP Vol 2, section 2-4.7. No command-specific data;
 * the target closes the session and sends no reply (per spec), so callers
 * should not wait for a response after sending this.
 */
function buildUnRegisterSessionRequest(sessionHandle, { senderContext = Buffer.alloc(8) } = {}) {
    return encodeMessage({ command: EncapsulationCommands.UnRegisterSession, sessionHandle, senderContext }, Buffer.alloc(0));
}

/**
 * Reads an incoming RegisterSession request's command-specific data —
 * needed on the Adapter (Phase 3) side. The request's own header.sessionHandle
 * is always 0 (not yet assigned); the Adapter allocates the real one itself.
 */
function readRegisterSessionRequest({ data }) {
    if (data.length < 4) {
        throw new RangeError('readRegisterSessionRequest: command-specific data shorter than 4 bytes');
    }
    return {
        protocolVersion: data.readUInt16LE(0),
        optionsFlags: data.readUInt16LE(2)
    };
}

/**
 * Builds a RegisterSession response — the inverse of readRegisterSessionResponse().
 * `sessionHandle` here is the Adapter's newly allocated handle for this session.
 */
function buildRegisterSessionResponse({ sessionHandle, protocolVersion = PROTOCOL_VERSION, optionsFlags = 0, senderContext = Buffer.alloc(8) } = {}) {
    const data = Buffer.alloc(4);
    data.writeUInt16LE(protocolVersion, 0);
    data.writeUInt16LE(optionsFlags, 2);
    return encodeMessage({ command: EncapsulationCommands.RegisterSession, sessionHandle, status: EncapsulationStatus.Success, senderContext }, data);
}

module.exports = {
    buildRegisterSessionRequest,
    readRegisterSessionResponse,
    parseRegisterSessionResponse,
    buildUnRegisterSessionRequest,
    readRegisterSessionRequest,
    buildRegisterSessionResponse
};
