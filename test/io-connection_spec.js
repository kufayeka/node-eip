'use strict';

const assert = require('assert');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-connection');

describe('Class 0/1 I/O datagram (Sequenced Address + Connected Data)', function () {
    it('round-trips connection id, sequence number, and data', function () {
        const data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const datagram = buildIoDatagram({ connectionId: 0xcafebabe, sequenceNumber: 42, data });

        const parsed = parseIoDatagram(datagram);
        assert.strictEqual(parsed.connectionId, 0xcafebabe);
        assert.strictEqual(parsed.sequenceNumber, 42);
        assert.deepStrictEqual(parsed.data, data);
    });

    it('throws when the Sequenced Address item is missing', function () {
        const { encodeCpf, CpfItemType } = require('../src/encapsulation/cpf');
        const buf = encodeCpf([{ typeId: CpfItemType.ConnectedTransportData, data: Buffer.from([1, 2]) }]);
        assert.throws(() => parseIoDatagram(buf), /Sequenced Address/);
    });
});
