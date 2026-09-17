'use strict';

const assert = require('assert');
const { decodeSocketAddress, decodeIdentityItem } = require('../src/encapsulation/identity');

function buildIdentityBuffer({ productName = 'TestPLC' } = {}) {
    const nameBuf = Buffer.from(productName, 'ascii');
    const buf = Buffer.alloc(2 + 16 + 2 + 2 + 2 + 2 + 2 + 4 + 1 + nameBuf.length + 1);
    let offset = 0;

    buf.writeUInt16LE(1, offset); // encapsulation protocol version
    offset += 2;

    // Socket Address struct — big-endian per spec, mirrors sockaddr_in.
    buf.writeUInt16BE(2, offset); // sin_family = AF_INET
    buf.writeUInt16BE(44818, offset + 2); // sin_port
    buf.writeUInt8(192, offset + 4);
    buf.writeUInt8(168, offset + 5);
    buf.writeUInt8(68, offset + 6);
    buf.writeUInt8(250, offset + 7);
    // sin_zero (8 bytes) left as zero
    offset += 16;

    buf.writeUInt16LE(0x0037, offset); // vendor id
    offset += 2;
    buf.writeUInt16LE(0x000e, offset); // device type
    offset += 2;
    buf.writeUInt16LE(100, offset); // product code
    offset += 2;
    buf.writeUInt8(2, offset); // revision major
    buf.writeUInt8(5, offset + 1); // revision minor
    offset += 2;
    buf.writeUInt16LE(0x0030, offset); // status
    offset += 2;
    buf.writeUInt32LE(0x12345678, offset); // serial number
    offset += 4;
    buf.writeUInt8(nameBuf.length, offset); // product name length
    offset += 1;
    nameBuf.copy(buf, offset);
    offset += nameBuf.length;
    buf.writeUInt8(0x03, offset); // state
    offset += 1;

    return buf;
}

describe('Identity item decoding', function () {
    it('decodes the embedded Socket Address as big-endian', function () {
        const buf = Buffer.alloc(16);
        buf.writeUInt16BE(2, 0);
        buf.writeUInt16BE(44818, 2);
        buf.writeUInt8(192, 4);
        buf.writeUInt8(168, 5);
        buf.writeUInt8(68, 6);
        buf.writeUInt8(250, 7);

        const addr = decodeSocketAddress(buf);
        assert.strictEqual(addr.family, 2);
        assert.strictEqual(addr.port, 44818);
        assert.strictEqual(addr.address, '192.168.68.250');
    });

    it('decodes a full Identity item matching a real device reply shape (e.g. Delta SX-3)', function () {
        const buf = buildIdentityBuffer({ productName: 'AS300-A' });
        const identity = decodeIdentityItem(buf);

        assert.strictEqual(identity.encapsulationProtocolVersion, 1);
        assert.strictEqual(identity.socketAddress.address, '192.168.68.250');
        assert.strictEqual(identity.vendorId, 0x0037);
        assert.strictEqual(identity.deviceType, 0x000e);
        assert.strictEqual(identity.productCode, 100);
        assert.deepStrictEqual(identity.revision, { major: 2, minor: 5 });
        assert.strictEqual(identity.status, 0x0030);
        assert.strictEqual(identity.serialNumber, '12345678');
        assert.strictEqual(identity.productName, 'AS300-A');
        assert.strictEqual(identity.state, 0x03);
        assert.strictEqual(identity.bytesConsumed, buf.length);
    });
});
