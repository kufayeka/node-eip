'use strict';

const assert = require('assert');
const { ConnectionHandler } = require('../src/adapter/connection-handler');
const { AssemblyObject } = require('../src/cip/objects/assembly');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-connection');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');
const { CipGeneralStatus } = require('../src/constants');

function baseRequest(overrides = {}) {
    return {
        connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 100, t2oInstance: 101 }),
        otSize: 4,
        toSize: 4,
        otRpiUs: 5000,
        toRpiUs: 5000,
        toNetworkConnectionId: 0xdeadbeef,
        connectionSerialNumber: 0x1234,
        originatorVendorId: 0xaaaa,
        originatorSerialNumber: 0x11223344,
        ...overrides
    };
}

describe('ConnectionHandler (Adapter-side Forward_Open/Forward_Close + cyclic I/O)', function () {
    let assembly;
    let sentDatagrams;
    let handler;

    beforeEach(function () {
        assembly = new AssemblyObject().define(100, 4).define(101, 4);
        sentDatagrams = [];
        handler = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf, addr) => sentDatagrams.push({ buf, addr }) });
    });

    afterEach(function () {
        handler.closeAll();
    });

    it('openConnection() accepts a valid request and returns connection ids/APIs', function () {
        const result = handler.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.response.toNetworkConnectionId, 0xdeadbeef);
        assert.strictEqual(result.response.otApiUs, 5000);
        assert.strictEqual(typeof result.response.otNetworkConnectionId, 'number');
    });

    it('openConnection() rejects when the connection path references undefined instances', function () {
        const request = baseRequest({ connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 200, t2oInstance: 201 }) });
        const result = handler.openConnection(request, { remoteAddress: '10.0.0.5' });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.extendedStatus, 0x0107);
    });

    it('openConnection() rejects a size mismatch against the actual Assembly instance size', function () {
        const request = baseRequest({ otSize: 999 });
        const result = handler.openConnection(request, { remoteAddress: '10.0.0.5' });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.extendedStatus, 0x0113);
    });

    it('produces a T->O datagram at the negotiated RPI, tagged with the originator-supplied connection id', function (done) {
        assembly.setData(101, Buffer.from([1, 2, 3, 4]));
        handler.openConnection(baseRequest({ toRpiUs: 2000 }), { remoteAddress: '10.0.0.5' }); // rpiMs = 2

        setTimeout(() => {
            assert.ok(sentDatagrams.length >= 1);
            const parsed = parseIoDatagram(sentDatagrams[0].buf);
            assert.strictEqual(parsed.connectionId, 0xdeadbeef);
            assert.deepStrictEqual(parsed.data, Buffer.from([1, 2, 3, 4]));
            assert.strictEqual(sentDatagrams[0].addr, '10.0.0.5');
            done();
        }, 20);
    });

    it('consumes an incoming O->T datagram into the output instance buffer', function () {
        const result = handler.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
        const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: Buffer.from([9, 9, 9, 9]) });

        handler.handleIncomingDatagram(datagram);

        assert.deepStrictEqual(assembly.getData(100), Buffer.from([9, 9, 9, 9]));
    });

    it('ignores an incoming datagram whose connection id matches no open connection', function () {
        handler.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
        const datagram = buildIoDatagram({ connectionId: 0xffffffff, sequenceNumber: 1, data: Buffer.from([9, 9, 9, 9]) });
        handler.handleIncomingDatagram(datagram); // should not throw
        assert.deepStrictEqual(assembly.getData(100), Buffer.alloc(4));
    });

    it('closeConnection() stops production and removes the connection', function (done) {
        const opened = handler.openConnection(baseRequest({ toRpiUs: 2000 }), { remoteAddress: '10.0.0.5' });
        const closeResult = handler.closeConnection({
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344
        });
        assert.strictEqual(closeResult.ok, true);
        assert.strictEqual(handler.connections.size, 0);

        const countAfterClose = sentDatagrams.length;
        setTimeout(() => {
            assert.strictEqual(sentDatagrams.length, countAfterClose); // no more datagrams after close
            done();
        }, 15);
    });

    it('closeConnection() fails clearly for an unknown connection triple', function () {
        const result = handler.closeConnection({ connectionSerialNumber: 0x9999, originatorVendorId: 0, originatorSerialNumber: 0 });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.generalStatus, CipGeneralStatus.ConnectionFailure);
    });
});
