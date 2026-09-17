'use strict';

const assert = require('assert');
const {
    encodePortSegment,
    decodePortSegment,
    encodeRoutePath,
    encodeEPath,
    decodeEPath,
    LogicalType
} = require('../src/cip/path');

describe('CIP Port Segment & Multi-Hop Routing (§19, §20)', () => {
    describe('Port Segment Encoding & Decoding', () => {
        it('encodes standard port (<= 14) with numeric link address (2 bytes)', () => {
            // Port 1 (Backplane), Slot 0
            const buf = encodePortSegment({ port: 1, linkAddress: 0 });
            assert.deepStrictEqual(buf, Buffer.from([0x01, 0x00]));

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 1);
            assert.strictEqual(decoded.linkAddress, 0);
            assert.strictEqual(decoded.bytesConsumed, 2);
        });

        it('encodes standard port with slot > 0', () => {
            // Port 1 (Backplane), Slot 5
            const buf = encodePortSegment({ port: 1, linkAddress: 5 });
            assert.deepStrictEqual(buf, Buffer.from([0x01, 0x05]));

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 1);
            assert.strictEqual(decoded.linkAddress, 5);
            assert.strictEqual(decoded.bytesConsumed, 2);
        });

        it('encodes standard port with extended link address (even string length, no pad)', () => {
            // Port 2 (Ethernet), IP "192.168.1.10" (length 12 = even)
            const ip = '192.168.1.10';
            const buf = encodePortSegment({ port: 2, linkAddress: ip });
            assert.strictEqual(buf[0], 0x12);
            assert.strictEqual(buf[1], 12);
            assert.strictEqual(buf.subarray(2, 2 + 12).toString('ascii'), ip);
            assert.strictEqual(buf.length, 14); // 2 + 12 = 14 (even)

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 2);
            assert.strictEqual(decoded.linkAddress, ip);
            assert.strictEqual(decoded.bytesConsumed, 14);
        });

        it('encodes standard port with extended link address (odd string length + 1 pad byte)', () => {
            // Port 2 (Ethernet), IP "192.168.1.1" (length 11 = odd)
            const ip = '192.168.1.1';
            const buf = encodePortSegment({ port: 2, linkAddress: ip });
            // Total length must be even (11 chars + 2 header + 1 pad = 14 bytes)
            assert.strictEqual(buf.length, 14);
            assert.strictEqual(buf[0], 0x12);
            assert.strictEqual(buf[1], 11);
            assert.strictEqual(buf.subarray(2, 2 + 11).toString('ascii'), ip);
            assert.strictEqual(buf[13], 0x00); // Pad byte

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 2);
            assert.strictEqual(decoded.linkAddress, ip);
            assert.strictEqual(decoded.bytesConsumed, 14);
        });

        it('encodes extended port (>= 15) with numeric link address (4 bytes)', () => {
            // Port 16, Node 3
            const buf = encodePortSegment({ port: 16, linkAddress: 3 });
            assert.strictEqual(buf[0], 0x0F);
            assert.strictEqual(buf.readUInt16LE(1), 16);
            assert.strictEqual(buf[3], 3);
            assert.strictEqual(buf.length, 4);

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 16);
            assert.strictEqual(decoded.linkAddress, 3);
            assert.strictEqual(decoded.bytesConsumed, 4);
        });

        it('encodes extended port (>= 15) with extended string link address', () => {
            // Port 20, IP "10.0.0.1" (8 chars)
            const ip = '10.0.0.1';
            const buf = encodePortSegment({ port: 20, linkAddress: ip });
            assert.strictEqual(buf[0], 0x1F);
            assert.strictEqual(buf.readUInt16LE(1), 20);
            assert.strictEqual(buf[3], 8);
            assert.strictEqual(buf.subarray(4, 4 + 8).toString('ascii'), ip);
            assert.strictEqual(buf.length, 12);

            const decoded = decodePortSegment(buf, 0);
            assert.strictEqual(decoded.port, 20);
            assert.strictEqual(decoded.linkAddress, ip);
            assert.strictEqual(decoded.bytesConsumed, 12);
        });
    });

    describe('Multi-Hop Routing & EPATH Integration', () => {
        it('encodes and decodes multi-hop routing paths via encodeRoutePath', () => {
            // Hop 1: Port 2 (Ethernet) -> "192.168.68.250"
            // Hop 2: Port 1 (Backplane) -> Slot 0
            // Target: Identity Object (Class 0x01, Instance 1)
            const hops = [
                { port: 2, linkAddress: '192.168.68.250' },
                { port: 1, linkAddress: 0 }
            ];
            const target = { classId: 1, instance: 1 };

            const routeBuf = encodeRoutePath(hops, target);
            assert.strictEqual(routeBuf.length % 2, 0); // Word alignment

            const decoded = decodeEPath(routeBuf);
            assert.strictEqual(decoded.portSegments.length, 2);
            assert.deepStrictEqual(decoded.portSegments[0], { port: 2, linkAddress: '192.168.68.250' });
            assert.deepStrictEqual(decoded.portSegments[1], { port: 1, linkAddress: 0 });
            assert.strictEqual(decoded.classId, 1);
            assert.strictEqual(decoded.instance, 1);
        });

        it('supports single port routing directly in encodeEPath', () => {
            const buf = encodeEPath({
                port: 1,
                linkAddress: 2,
                classId: 0x04,
                instance: 100
            });

            const decoded = decodeEPath(buf);
            assert.strictEqual(decoded.portSegments.length, 1);
            assert.deepStrictEqual(decoded.portSegments[0], { port: 1, linkAddress: 2 });
            assert.strictEqual(decoded.classId, 0x04);
            assert.strictEqual(decoded.instance, 100);
        });
    });
});
