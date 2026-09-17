'use strict';

/**
 * ListServices Encapsulation Command (0x0004) — CIP Vol 2, Section 2-4.2.
 *
 * Discovers encapsulation services and communications capabilities of an
 * EtherNet/IP target node over TCP (port 44818) or UDP.
 */

const { encodeHeader, decodeMessage } = require('./header');
const { encodeCpf, decodeCpf, CpfItemType } = require('./cpf');
const { EncapsulationCommands, EncapsulationStatus } = require('../constants');

// Default Capability Flags:
// Bit 5 (0x0020): Supports CIP encapsulation over TCP
// Bit 8 (0x0100): Supports Class 0/1 connected messaging (UDP)
const DEFAULT_CAPABILITY_FLAGS = 0x0120;
const DEFAULT_SERVICE_NAME = 'Communications';

/** Builds a ListServices request encapsulation message. */
function buildListServicesRequest({ senderContext = Buffer.alloc(8) } = {}) {
    return encodeHeader({
        command: EncapsulationCommands.ListServices,
        length: 0,
        sessionHandle: 0,
        status: EncapsulationStatus.Success,
        senderContext,
        options: 0
    });
}

/** Builds the 20-byte item payload for ListServicesResponse (CPF type 0x0100). */
function buildListServicesItemBuffer({
    version = 1,
    capabilityFlags = DEFAULT_CAPABILITY_FLAGS,
    serviceName = DEFAULT_SERVICE_NAME
} = {}) {
    const buf = Buffer.alloc(20);
    buf.writeUInt16LE(version, 0);
    buf.writeUInt16LE(capabilityFlags, 2);

    // Name of service: 16 bytes, null-padded ASCII
    const nameBuf = Buffer.from(serviceName, 'ascii');
    nameBuf.copy(buf, 4, 0, Math.min(nameBuf.length, 16));
    return buf;
}

/** Builds a complete ListServices response encapsulation message. */
function buildListServicesResponse({
    senderContext = Buffer.alloc(8),
    version = 1,
    capabilityFlags = DEFAULT_CAPABILITY_FLAGS,
    serviceName = DEFAULT_SERVICE_NAME
} = {}) {
    const itemData = buildListServicesItemBuffer({ version, capabilityFlags, serviceName });
    const cpf = encodeCpf([{ typeId: CpfItemType.ListServicesResponse, data: itemData }]);
    const header = encodeHeader({
        command: EncapsulationCommands.ListServices,
        length: cpf.length,
        sessionHandle: 0,
        status: EncapsulationStatus.Success,
        senderContext,
        options: 0
    });
    return Buffer.concat([header, cpf]);
}

/** Parses a ListServices response message into a JavaScript object. */
function parseListServicesResponse(msg) {
    if (!msg || !msg.header || !msg.data) {
        throw new TypeError('parseListServicesResponse: expected decoded encapsulation message');
    }
    if (msg.header.command !== EncapsulationCommands.ListServices) {
        throw new Error(`parseListServicesResponse: unexpected command 0x${msg.header.command.toString(16)}`);
    }
    if (msg.header.status !== EncapsulationStatus.Success) {
        throw new Error(`parseListServicesResponse: encapsulation status 0x${msg.header.status.toString(16)}`);
    }

    const { items } = decodeCpf(msg.data);
    const serviceItem = items.find((item) => item.typeId === CpfItemType.ListServicesResponse);
    if (!serviceItem || serviceItem.data.length < 4) {
        throw new Error('parseListServicesResponse: missing or truncated ListServicesResponse CPF item (0x0100)');
    }

    const version = serviceItem.data.readUInt16LE(0);
    const capabilityFlags = serviceItem.data.readUInt16LE(2);

    // Read 16-byte null-terminated name
    let nameEnd = 20;
    for (let i = 4; i < 20 && i < serviceItem.data.length; i++) {
        if (serviceItem.data[i] === 0) {
            nameEnd = i;
            break;
        }
    }
    const serviceName = serviceItem.data.subarray(4, nameEnd).toString('ascii').trim();

    return {
        version,
        capabilityFlags,
        serviceName,
        supportsTcp: (capabilityFlags & 0x0020) !== 0,
        supportsUdp: (capabilityFlags & 0x0100) !== 0
    };
}

/**
 * Builds a NOP (0x0000) Encapsulation Request per CIP Vol 2 Section 2-3.1.
 * Used for connection keepalive/heartbeat and round-trip ping.
 */
function buildNopRequest({ sessionHandle = 0, senderContext = Buffer.alloc(8), data = Buffer.alloc(0) } = {}) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = encodeHeader({
        command: EncapsulationCommands.NOP,
        length: payload.length,
        sessionHandle,
        status: EncapsulationStatus.Success,
        senderContext,
        options: 0
    });
    return Buffer.concat([header, payload]);
}

/** Builds a NOP (0x0000) Encapsulation Response echoing data and context. */
function buildNopResponse({ sessionHandle = 0, senderContext = Buffer.alloc(8), data = Buffer.alloc(0) } = {}) {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = encodeHeader({
        command: EncapsulationCommands.NOP,
        length: payload.length,
        sessionHandle,
        status: EncapsulationStatus.Success,
        senderContext,
        options: 0
    });
    return Buffer.concat([header, payload]);
}

module.exports = {
    DEFAULT_CAPABILITY_FLAGS,
    DEFAULT_SERVICE_NAME,
    buildListServicesRequest,
    buildListServicesItemBuffer,
    buildListServicesResponse,
    parseListServicesResponse,
    buildNopRequest,
    buildNopResponse
};
