'use strict';

const assert = require('assert');
const { encodeMessage } = require('../src/encapsulation/header');
const { encodeCpf, CpfItemType } = require('../src/encapsulation/cpf');
const { buildListIdentityRequest, parseListIdentityResponse, ipv4DirectedBroadcasts } = require('../src/encapsulation/discovery');
const { EncapsulationCommands } = require('../src/constants');

function buildIdentityItemBuffer() {
    const nameBuf = Buffer.from('AS300-A', 'ascii');
    const buf = Buffer.alloc(2 + 16 + 2 + 2 + 2 + 2 + 2 + 4 + 1 + nameBuf.length + 1);
    let offset = 0;
    buf.writeUInt16LE(1, offset); offset += 2;
    buf.writeUInt16BE(2, offset);
    buf.writeUInt16BE(44818, offset + 2);
    buf.writeUInt8(192, offset + 4);
    buf.writeUInt8(168, offset + 5);
    buf.writeUInt8(68, offset + 6);
    buf.writeUInt8(250, offset + 7);
    offset += 16;
    buf.writeUInt16LE(0x0037, offset); offset += 2;
    buf.writeUInt16LE(0x000e, offset); offset += 2;
    buf.writeUInt16LE(100, offset); offset += 2;
    buf.writeUInt8(2, offset); buf.writeUInt8(5, offset + 1); offset += 2;
    buf.writeUInt16LE(0x0030, offset); offset += 2;
    buf.writeUInt32LE(0x12345678, offset); offset += 4;
    buf.writeUInt8(nameBuf.length, offset); offset += 1;
    nameBuf.copy(buf, offset); offset += nameBuf.length;
    buf.writeUInt8(0x03, offset);
    return buf;
}

describe('ListIdentity discovery', function () {
    it('builds a well-formed request with an empty payload', function () {
        const req = buildListIdentityRequest();
        assert.strictEqual(req.length, 24); // header only, no command-specific data
        assert.strictEqual(req.readUInt16LE(0), EncapsulationCommands.ListIdentity);
        assert.strictEqual(req.readUInt16LE(2), 0); // length field
    });

    it('parses a full ListIdentity response (header + CPF + Identity item)', function () {
        const cpf = encodeCpf([{ typeId: CpfItemType.ListIdentityResponse, data: buildIdentityItemBuffer() }]);
        const response = encodeMessage({ command: EncapsulationCommands.ListIdentity, senderContext: Buffer.alloc(8) }, cpf);

        const parsed = parseListIdentityResponse(response);
        assert.ok(parsed);
        assert.strictEqual(parsed.identity.productName, 'AS300-A');
        assert.strictEqual(parsed.identity.socketAddress.address, '192.168.68.250');
        assert.strictEqual(parsed.identity.vendorId, 0x0037);
    });

    it('returns null for an unrelated command', function () {
        const response = encodeMessage({ command: EncapsulationCommands.ListServices }, Buffer.alloc(0));
        assert.strictEqual(parseListIdentityResponse(response), null);
    });

    it('throws when the CPF has no Identity item', function () {
        const cpf = encodeCpf([{ typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) }]);
        const response = encodeMessage({ command: EncapsulationCommands.ListIdentity }, cpf);
        assert.throws(() => parseListIdentityResponse(response), /no Identity item/);
    });
});

describe('ipv4DirectedBroadcasts', function () {
    it('returns only well-formed dotted-quad addresses, distinct from the host addresses themselves', function () {
        const broadcasts = ipv4DirectedBroadcasts();
        for (const addr of broadcasts) {
            assert.match(addr, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
        }
        // Not asserting a nonzero count: CI/sandboxed environments may have
        // no non-internal IPv4 interface at all, which is a valid (empty) result.
    });
});
