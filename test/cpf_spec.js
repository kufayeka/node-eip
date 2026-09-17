'use strict';

const assert = require('assert');
const { encodeCpf, decodeCpf, CpfItemType } = require('../src/encapsulation/cpf');

describe('Common Packet Format', function () {
    it('round-trips a multi-item list', function () {
        const items = [
            { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
            { typeId: CpfItemType.UnconnectedData, data: Buffer.from([0xaa, 0xbb, 0xcc]) }
        ];

        const encoded = encodeCpf(items);
        const decoded = decodeCpf(encoded);

        assert.strictEqual(decoded.items.length, 2);
        assert.strictEqual(decoded.items[0].typeId, CpfItemType.NullAddress);
        assert.strictEqual(decoded.items[0].data.length, 0);
        assert.strictEqual(decoded.items[1].typeId, CpfItemType.UnconnectedData);
        assert.deepStrictEqual(decoded.items[1].data, Buffer.from([0xaa, 0xbb, 0xcc]));
        assert.strictEqual(decoded.bytesConsumed, encoded.length);
    });

    it('throws on a truncated item header', function () {
        const buf = Buffer.from([0x01, 0x00, 0x0c, 0x00]); // count=1, typeId=0x0c, then nothing
        assert.throws(() => decodeCpf(buf), RangeError);
    });

    it('throws on truncated item data', function () {
        const buf = Buffer.concat([
            Buffer.from([0x01, 0x00]), // count = 1
            Buffer.from([0x0c, 0x00, 0x05, 0x00]), // typeId=0x0c, length=5
            Buffer.from([0x01, 0x02]) // only 2 of 5 promised bytes
        ]);
        assert.throws(() => decodeCpf(buf), RangeError);
    });
});
