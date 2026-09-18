'use strict';

const assert = require('assert');
const { ConnectionHandler } = require('../src/adapter/connection-handler');
const { AssemblyObject } = require('../src/cip/objects/assembly');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-connection');
const { encodeAssemblyConnectionPath, encodeSymbolicPath, encodeElectronicKeySegment, LogicalType, encodeLogicalSegment } = require('../src/cip/path');
const { TransportTrigger } = require('../src/cip/connection-manager');
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
            // Connected data payload carries 2-byte sequence count (0x0001) + 4-byte assembly data
            assert.deepStrictEqual(parsed.data, Buffer.from([1, 0, 1, 2, 3, 4]));
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

    it('strips 2-byte sequence count and 4-byte Run/Idle header from incoming O->T datagram', function () {
        const result = handler.openConnection(baseRequest({ otSize: 4 }), { remoteAddress: '10.0.0.5' });
        // 2-byte sequence count (0x1234) + 4-byte Run header (0x00000001) + 4-byte data ([10, 20, 30, 40])
        const rawPayload = Buffer.concat([
            Buffer.from([0x34, 0x12]),
            Buffer.from([0x01, 0x00, 0x00, 0x00]),
            Buffer.from([10, 20, 30, 40])
        ]);
        const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: rawPayload });

        handler.handleIncomingDatagram(datagram);

        assert.deepStrictEqual(assembly.getData(100), Buffer.from([10, 20, 30, 40]));
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

    describe('Electronic Key Segment (CIP Vol 1, C-1.4.5.2)', function () {
        function pathWithKey(key) {
            return Buffer.concat([
                encodeElectronicKeySegment(key),
                encodeLogicalSegment(LogicalType.ClassId, 0x04),
                encodeLogicalSegment(LogicalType.InstanceId, 0x80),
                encodeLogicalSegment(LogicalType.ConnectionPoint, 100),
                encodeLogicalSegment(LogicalType.ConnectionPoint, 101)
            ]);
        }

        it('a real Forward_Open with an Electronic Key segment prepended no longer desyncs the path (the original bug)', function () {
            // Before the fix, decodeEPath mis-parsed the 10-byte key as a
            // 2-byte segment, corrupting every segment after it and
            // causing a spurious Path Segment Error on every real PLC's
            // Forward_Open (every conformant Scanner sends one of these).
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = handler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
        });

        it('accepts any key when the ConnectionHandler has no identity configured (back-compat)', function () {
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 1, deviceType: 99, productCode: 1, majorRevision: 9, minorRevision: 9 }) });
            const result = handler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
        });

        it('rejects a Vendor ID mismatch with extended status 0x0114 when an identity is configured', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 1, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 1, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0114);
            keyedHandler.closeAll();
        });

        it('accepts a Vendor ID of 0 as a wildcard even with an identity configured', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 1, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 0, deviceType: 0, productCode: 0, majorRevision: 0, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            keyedHandler.closeAll();
        });

        it('rejects a strict Revision mismatch with extended status 0x0116', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 2, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0116);
            keyedHandler.closeAll();
        });

        // The exact rules below are ported from OpENer's CheckElectronicKeyData()
        // (the ODVA-conformance-tested reference implementation), not re-derived
        // from the spec text — Compatible keying is narrower than it sounds.
        describe('Compatible keying (ported from OpENer CheckElectronicKeyData)', function () {
            function keyedHandler(ourRevision) {
                const h = new ConnectionHandler({
                    assemblyObject: assembly,
                    identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: ourRevision },
                    sendDatagram: () => {}
                });
                return h;
            }

            it('accepts when Major matches exactly and 0 < Minor <= our own Minor', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 3, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, true);
                h.closeAll();
            });

            it('rejects a DIFFERENT Major even if ours is higher — Major must match exactly, not just be >=', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.extendedStatus, 0x0116);
                h.closeAll();
            });

            it('rejects Minor Revision 0 in Compatible mode — unlike strict mode, 0 is NOT a wildcard here', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 0, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.extendedStatus, 0x0116);
                h.closeAll();
            });

            it('rejects a Minor Revision higher than our own', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 6, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.extendedStatus, 0x0116);
                h.closeAll();
            });
        });

        describe('Strict keying — Major/Minor 0 are wildcards (ported from OpENer)', function () {
            it('accepts Major Revision 0 regardless of our own revision', function () {
                const h = new ConnectionHandler({
                    assemblyObject: assembly,
                    identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 7, minor: 3 } },
                    sendDatagram: () => {}
                });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 0, minorRevision: 0 }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, true);
                h.closeAll();
            });

            it('accepts Minor Revision 0 once Major matches, even if our own Minor is not 0', function () {
                const h = new ConnectionHandler({
                    assemblyObject: assembly,
                    identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 2, minor: 9 } },
                    sendDatagram: () => {}
                });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 0 }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, true);
                h.closeAll();
            });
        });

        it('triggers onProduceData hook and builds T->O datagram with exact toSize and without Run/Idle header', function () {
            const captured = [];
            let hookCalledWith = null;
            const h = new ConnectionHandler({
                assemblyObject: assembly,
                sendDatagram: (buf) => captured.push(buf)
            });
            h.onProduceData = (inst) => {
                hookCalledWith = inst;
                // update assembly data inside hook
                assembly.setData(inst, Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]));
            };
            const req = baseRequest({ toSize: 4, useRunIdleHeader: true }); // even if request requested Run/Idle for O->T
            const openRes = h.openConnection(req, { remoteAddress: '127.0.0.1' });
            assert.strictEqual(openRes.ok, true);
            assert.strictEqual(hookCalledWith, 101);
            assert.strictEqual(captured.length >= 1, true);

            // Verify the wire format of the produced T->O datagram
            // [Item 1: Null Address (4B)] [Item 2: Connected Data Item (2B item ID + 2B length + payload)]
            // Payload should be: 2B sequence count (0x0001) + 4B data = 6B total (NO 4B Run/Idle header!)
            const parsed = parseIoDatagram(captured[0]);
            assert.strictEqual(parsed.sequenceNumber, 1);
            assert.deepStrictEqual(parsed.data, Buffer.from([0x01, 0x00, 0xAA, 0xBB, 0xCC, 0xDD]));
            h.closeAll();
        });
    });

    describe('strictDuplicateConnections option (CIP Vol 1 3-5.5.3, ODVA-strict vs. the lenient default)', function () {
        it('default (false): a repeat Forward_Open from the same originator silently supersedes the old connection', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {} });
            const first = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(first.ok, true);
            const second = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(second.ok, true);
            assert.notStrictEqual(second.response.otNetworkConnectionId, first.response.otNetworkConnectionId);
            assert.strictEqual(h.connections.size, 1); // old one was replaced, not left dangling
            h.closeAll();
        });

        it('strict (true): a matching Forward_Open (same Connection Serial Number + Originator) is rejected with 0x0100', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {}, strictDuplicateConnections: true });
            const first = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(first.ok, true);

            const second = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(second.ok, false);
            assert.strictEqual(second.generalStatus, CipGeneralStatus.ConnectionFailure);
            assert.strictEqual(second.extendedStatus, 0x0100);
            assert.strictEqual(h.connections.size, 1); // original connection untouched
            h.closeAll();
        });

        it('strict (true): a Forward_Open with a DIFFERENT triple is still accepted normally', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {}, strictDuplicateConnections: true });
            const first = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(first.ok, true);

            const second = h.openConnection(baseRequest({ connectionSerialNumber: 0x9999 }), { remoteAddress: '10.0.0.6' });
            assert.strictEqual(second.ok, true);
            assert.strictEqual(h.connections.size, 2);
            h.closeAll();
        });

        it('strict (true): closing the original connection first frees it up for a matching Forward_Open again', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {}, strictDuplicateConnections: true });
            const first = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            h.closeConnection({ connectionSerialNumber: 0x1234, originatorVendorId: 0xaaaa, originatorSerialNumber: 0x11223344 });

            const second = h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(second.ok, true);
            h.closeAll();
        });
    });

    describe('Production Trigger (Cyclic vs Change-of-State, CIP Vol 1 Table 3-4.5)', function () {
        it('cyclic (default, no transportTypeTrigger given): keeps sending unconditionally at every RPI tick, even with unchanged data', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 5000 }), { remoteAddress: '10.0.0.5' }); // rpiMs = 5
            setTimeout(() => {
                assert.ok(sentDatagrams.length >= 4, `expected several cyclic packets, got ${sentDatagrams.length}`);
                h.closeAll();
                done();
            }, 30);
        });

        it('change-of-state: after the initial packet, sends nothing more while the data stays unchanged (well under one RPI)', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 300000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' }); // rpiMs = 300, pollMs = 50
            setTimeout(() => {
                assert.strictEqual(sentDatagrams.length, 1); // only the mandatory initial packet
                h.closeAll();
                done();
            }, 120);
        });

        it('change-of-state: sends promptly (within one poll interval) as soon as the produced data actually changes', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 300000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' });
            setTimeout(() => {
                assert.strictEqual(sentDatagrams.length, 1);
                assembly.setData(101, Buffer.from([9, 9, 9, 9]));
                setTimeout(() => {
                    assert.ok(sentDatagrams.length >= 2, `expected a change-triggered packet, got ${sentDatagrams.length}`);
                    const last = parseIoDatagram(sentDatagrams[sentDatagrams.length - 1].buf);
                    assert.deepStrictEqual(last.data.subarray(2), Buffer.from([9, 9, 9, 9]));
                    h.closeAll();
                    done();
                }, 60);
            }, 10);
        });

        it('change-of-state: still sends a heartbeat at the RPI even when nothing changed, so the Originator watchdog never times out', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 40000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' }); // rpiMs = 40, pollMs = 40
            setTimeout(() => {
                assert.ok(sentDatagrams.length >= 2, `expected an unconditional heartbeat resend, got ${sentDatagrams.length}`);
                h.closeAll();
                done();
            }, 90);
        });
    });

    describe('Symbolic Produced/Consumed Tag Class 1 I/O Connections (path.tagPath — runtime counterpart of eds-exporter.js\'s SYMBOL_ANSI "Tag Connection")', function () {
        function tagRequest(overrides = {}) {
            return {
                connectionPath: encodeSymbolicPath('TotalCount'),
                otSize: 0,
                toSize: 0,
                otRpiUs: 5000,
                toRpiUs: 5000,
                toNetworkConnectionId: 0xdeadbeef,
                connectionSerialNumber: 0x1234,
                originatorVendorId: 0xaaaa,
                originatorSerialNumber: 0x11223344,
                ...overrides
            };
        }

        let tagStore;
        beforeEach(function () {
            tagStore = new Map([['TotalCount', { type: 'DINT', buffer: Buffer.from([7, 0, 0, 0]), value: 7 }]]);
        });

        it('is NOT misclassified as an explicit (Class 3) connection — a Produced tag actually drives cyclic I/O', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            const result = h.openConnection(tagRequest({ toSize: 4, toRpiUs: 2000 }), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            setTimeout(() => {
                assert.ok(sentDatagrams.length >= 1);
                const parsed = parseIoDatagram(sentDatagrams[0].buf);
                assert.deepStrictEqual(parsed.data, Buffer.from([1, 0, 7, 0, 0, 0])); // seq 1 + tag's current buffer
                h.closeAll();
                done();
            }, 20);
        });

        it('consumes an incoming O->T datagram into the tag buffer directly when no onTagWrite hook is given', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: () => {} });
            const result = h.openConnection(tagRequest({ otSize: 4 }), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: Buffer.from([42, 0, 0, 0]) });
            h.handleIncomingDatagram(datagram);
            assert.deepStrictEqual(tagStore.get('TotalCount').buffer, Buffer.from([42, 0, 0, 0]));
            h.closeAll();
        });

        it('routes incoming O->T tag data through the onTagWrite hook when given, instead of mutating the buffer directly', function () {
            const writes = [];
            const h = new ConnectionHandler({
                assemblyObject: assembly,
                tagStore,
                onTagWrite: (name, buf) => writes.push({ name, buf }),
                sendDatagram: () => {}
            });
            const result = h.openConnection(tagRequest({ otSize: 4 }), { remoteAddress: '10.0.0.5' });
            const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: Buffer.from([42, 0, 0, 0]) });
            h.handleIncomingDatagram(datagram);
            assert.strictEqual(writes.length, 1);
            assert.strictEqual(writes[0].name, 'TotalCount');
            assert.deepStrictEqual(writes[0].buf, Buffer.from([42, 0, 0, 0]));
            assert.deepStrictEqual(tagStore.get('TotalCount').buffer, Buffer.from([7, 0, 0, 0])); // untouched — the hook owns the mutation
            h.closeAll();
        });

        it('binds both directions to the SAME tag when both otSize and toSize are nonzero (bidirectional read/write)', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: (buf) => sentDatagrams.push({ buf }) });
            const result = h.openConnection(tagRequest({ otSize: 4, toSize: 4, toRpiUs: 2000 }), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: Buffer.from([99, 0, 0, 0]) });
            h.handleIncomingDatagram(datagram);
            assert.deepStrictEqual(tagStore.get('TotalCount').buffer, Buffer.from([99, 0, 0, 0]));
            setTimeout(() => {
                const last = parseIoDatagram(sentDatagrams[sentDatagrams.length - 1].buf);
                assert.deepStrictEqual(last.data.subarray(2), Buffer.from([99, 0, 0, 0])); // produces the just-written value back
                h.closeAll();
                done();
            }, 20);
        });

        it('rejects a tag path referencing an undefined tag with extended status 0x0107 (connection not found at target)', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: () => {} });
            const request = { ...tagRequest({ toSize: 4 }), connectionPath: encodeSymbolicPath('NoSuchTag') };
            const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0107);
        });

        it('rejects a size mismatch between the requested connection size and the tag\'s actual byte size with 0x0109', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: () => {} });
            const result = h.openConnection(tagRequest({ toSize: 2 }), { remoteAddress: '10.0.0.5' }); // TotalCount is a 4-byte DINT
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0109);
        });

        it('rejects a Forward_Open with neither direction populated (otSize and toSize both 0)', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: () => {} });
            const result = h.openConnection(tagRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0120);
        });
    });
});
