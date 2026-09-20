'use strict';

const assert = require('assert');
const { ConnectionHandler } = require('../src/adapter/connection-handler');
const { AssemblyObject } = require('../src/cip/objects/assembly');
const { buildIoDatagram, parseIoDatagram } = require('../src/cip/io-connection');
const { encodeAssemblyConnectionPath, encodeSymbolicPath, encodeElectronicKeySegment, LogicalType, encodeLogicalSegment } = require('../src/cip/path');
const { TransportTrigger, ConnectionType } = require('../src/cip/connection-manager');
const { TcpIpInterfaceObject, calculateMulticastIp } = require('../src/cip/objects/tcp-ip');
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

    it('regression (eip_device.js live incident): a Scanner negotiating otSize = Assembly size + transport overhead (Delta convention) must NOT resize the Assembly, and must still land only the real data at the real offsets', function () {
        // Reproduces the exact production scenario that caused this: a 10-byte Assembly (5 INT
        // params, 2 bytes each, at offsets 0,2,4,6,8 — matching DeviceBuilder's own Param<->
        // Assembly member offset convention), and a real Scanner that negotiates otSize=16
        // (10 real bytes + 2-byte Sequence Count + 4-byte Run/Idle header, confirmed live via
        // EIP_DEBUG_RAW against a real Delta PLC). Previously, openConnection() RESIZED the
        // Assembly to 16 bytes to match, which then made every future payload.length equal the
        // Assembly's own (now 16-byte) length, so no header could ever be detected/stripped again
        // — the header landed unstripped at offset 0, so what should have been the first param's
        // value was actually the raw wire Sequence Count (incrementing every packet) and the
        // second/third were the raw Run/Idle header (reading a constant 1, then 0).
        const bigAssembly = new AssemblyObject().define(200, 10).define(201, 10);
        const bigHandler = new ConnectionHandler({ assemblyObject: bigAssembly, sendDatagram: () => {} });
        const req = {
            connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 200, t2oInstance: 201 }),
            otSize: 16, // 10 real bytes + 2-byte Sequence Count + 4-byte Run/Idle header
            toSize: 12, // 10 real bytes + 2-byte Sequence Count (T->O never carries Run/Idle)
            otRpiUs: 20000,
            toRpiUs: 20000,
            toNetworkConnectionId: 0xdeadbeef,
            connectionSerialNumber: 0x1234,
            originatorVendorId: 0xaaaa,
            originatorSerialNumber: 0x11223344
        };
        const result = bigHandler.openConnection(req, { remoteAddress: '10.0.0.5' });
        assert.strictEqual(result.ok, true);
        // The Assembly must stay at its own real, declared size -- NOT get resized to 16.
        assert.strictEqual(bigAssembly.getData(200).length, 10, 'Assembly must NOT be resized to the negotiated wire size');

        // Real param values a PLC would write: 5 INT16 values at their real byte offsets.
        const realParamBytes = Buffer.from(new Int16Array([111, -222, 333, -444, 555]).buffer);
        const wirePayload = Buffer.concat([
            Buffer.from([0x01, 0x00]),       // 2-byte Sequence Count (e.g. seq=1)
            Buffer.from([0x01, 0x00, 0x00, 0x00]), // 4-byte Run/Idle header, Run=1
            realParamBytes                   // 10 bytes of real application data
        ]);
        assert.strictEqual(wirePayload.length, 16);

        const datagram = buildIoDatagram({ connectionId: result.response.otNetworkConnectionId, sequenceNumber: 1, data: wirePayload });
        bigHandler.handleIncomingDatagram(datagram);

        assert.deepStrictEqual(bigAssembly.getData(200), realParamBytes, 'only the real 10 bytes of param data must land in the Assembly -- the header must be stripped, not stored as param values');
        bigHandler.closeAll();
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

        it('rejects a Vendor ID mismatch with extended status 0x0116 when an identity is configured', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 1, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 1, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0116); // per ForwardOpenExtendedStatus: Vendor ID or Product Code mismatch
            keyedHandler.closeAll();
        });

        it('rejects a Device Type mismatch with extended status 0x0117 (regression: previously used 0x0115, which the project\'s own status table assigns to a different meaning entirely)', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 1, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 99, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0117); // per ForwardOpenExtendedStatus: Product Type mismatch
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

        it('rejects a strict Revision mismatch with extended status 0x0118', function () {
            const keyedHandler = new ConnectionHandler({
                assemblyObject: assembly,
                identity: { vendorId: 799, deviceType: 14, productCode: 771, revision: { major: 2, minor: 0 } },
                sendDatagram: () => {}
            });
            const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 1, minorRevision: 0 }) });
            const result = keyedHandler.openConnection(request, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.extendedStatus, 0x0118); // per ForwardOpenExtendedStatus: Revision mismatch
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
                assert.strictEqual(result.extendedStatus, 0x0118); // per ForwardOpenExtendedStatus: Revision mismatch
                h.closeAll();
            });

            it('rejects Minor Revision 0 in Compatible mode — unlike strict mode, 0 is NOT a wildcard here', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 0, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.extendedStatus, 0x0118); // per ForwardOpenExtendedStatus: Revision mismatch
                h.closeAll();
            });

            it('rejects a Minor Revision higher than our own', function () {
                const h = keyedHandler({ major: 2, minor: 5 });
                const request = baseRequest({ connectionPath: pathWithKey({ vendorId: 799, deviceType: 14, productCode: 771, majorRevision: 2, minorRevision: 6, compatibility: true }) });
                const result = h.openConnection(request, { remoteAddress: '10.0.0.5' });
                assert.strictEqual(result.ok, false);
                assert.strictEqual(result.extendedStatus, 0x0118); // per ForwardOpenExtendedStatus: Revision mismatch
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
        // Polls for a COUNT threshold (rather than a single fixed-delay check) so a slow tick
        // under heavy full-suite system load — Node's timers are a lower bound, not a
        // guarantee — reads as "still waiting", not a false failure. Ceiling is generous
        // (1s) relative to the ~5-40ms RPIs these tests actually use.
        function waitForCount(getLength, threshold, done, onDone) {
            const deadline = Date.now() + 1000;
            const poll = () => {
                if (getLength() >= threshold) {
                    onDone();
                    done();
                } else if (Date.now() > deadline) {
                    onDone();
                    done(new Error(`Expected at least ${threshold} datagram(s) within 1s, got ${getLength()}`));
                } else {
                    setTimeout(poll, 10);
                }
            };
            poll();
        }

        it('cyclic (default, no transportTypeTrigger given): keeps sending unconditionally at every RPI tick, even with unchanged data', function (done) {
            // Local array — see the comment on the "sends promptly" test below for why: a shared
            // array can pick up a stray packet from another test's not-yet-torn-down timer.
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 5000 }), { remoteAddress: '10.0.0.5' }); // rpiMs = 5
            waitForCount(() => localDatagrams.length, 4, done, () => h.closeAll());
        });

        it('change-of-state: after the initial packet, sends nothing more while the data stays unchanged (well under one RPI)', function (done) {
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 300000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' }); // rpiMs = 300, pollMs = 50
            setTimeout(() => {
                assert.strictEqual(localDatagrams.length, 1); // only the mandatory initial packet
                h.closeAll();
                done();
            }, 120);
        });

        it('change-of-state: sends promptly (within one poll interval) as soon as the produced data actually changes', function (done) {
            // Uses a local array (not the shared outer `sentDatagrams`) and asserts growth-from-a-
            // snapshot rather than an exact intermediate count, so this can't be confused by any
            // stray packet from another test's not-yet-fully-torn-down timer landing in a shared
            // array under heavy full-suite load — a real, if rare, hazard with real setInterval-
            // based tests sharing mutable state across `it()` blocks.
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 300000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' });
            setTimeout(() => {
                const countBeforeChange = localDatagrams.length;
                assembly.setData(101, Buffer.from([9, 9, 9, 9]));
                const deadline = Date.now() + 500;
                const poll = () => {
                    const grew = localDatagrams.length > countBeforeChange;
                    const last = grew ? parseIoDatagram(localDatagrams[localDatagrams.length - 1].buf) : null;
                    const matches = last && last.data.subarray(2).equals(Buffer.from([9, 9, 9, 9]));
                    if (matches) {
                        h.closeAll();
                        done();
                    } else if (Date.now() > deadline) {
                        h.closeAll();
                        done(new Error(`Expected a change-triggered packet carrying [9,9,9,9]; last seen: ${last ? last.data.subarray(2).toString('hex') : 'none'}`));
                    } else {
                        setTimeout(poll, 10);
                    }
                };
                poll();
            }, 10);
        });

        it('change-of-state: still sends a heartbeat at the RPI even when nothing changed, so the Originator watchdog never times out', function (done) {
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 40000, transportTypeTrigger: TransportTrigger.Class1ChangeOfState }), { remoteAddress: '10.0.0.5' }); // rpiMs = 40, pollMs = 40
            waitForCount(() => localDatagrams.length, 2, done, () => h.closeAll());
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
            // Poll instead of a single fixed-delay check — under heavy system/CI load a lone
            // setTimeout(60ms) can still land before the 2ms-RPI cyclic timer has actually
            // ticked (Node's timers are a lower bound, not a guarantee), which isn't a real
            // bug, just an unlucky scheduling race. Poll up to a generous ceiling instead.
            const deadline = Date.now() + 500;
            const poll = () => {
                const last = sentDatagrams.length > 0 ? parseIoDatagram(sentDatagrams[sentDatagrams.length - 1].buf) : null;
                if (last && last.data.subarray(2).equals(Buffer.from([99, 0, 0, 0]))) {
                    h.closeAll();
                    done();
                } else if (Date.now() > deadline) {
                    h.closeAll();
                    done(new Error(`Expected a produced datagram carrying [99,0,0,0]; last seen: ${last ? last.data.subarray(2).toString('hex') : 'none'}`));
                } else {
                    setTimeout(poll, 10);
                }
            };
            poll();
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

    // Ported from OpENer's appcontype.c — the ODVA-conformance-tested reference stack's own
    // Exclusive-Owner/Input-Only/Listen-Only classification algorithm (GetIoConnectionForConnectionData()
    // and its Get{ExclusiveOwner,InputOnly,ListenOnly}Connection() helpers). Real devices classify a
    // Forward_Open purely by which pre-registered (O->T, T->O) slot pair its path matches — NOT by
    // whether O->T size is zero — see connection-handler.js's registerConnectionPoint() doc comment.
    describe('Connection-type classification (Exclusive-Owner / Input-Only / Listen-Only, ported from OpENer appcontype.c)', function () {
        const OWNER_O2T = 100;
        const TO_INST = 101;
        const LISTEN_O2T = 0xC0;
        const INPUT_O2T = 0xC1;

        function ownerRequest(overrides = {}) {
            return baseRequest({
                connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: OWNER_O2T, t2oInstance: TO_INST }),
                ...overrides
            });
        }
        function listenOnlyRequest(overrides = {}) {
            return baseRequest({
                connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: LISTEN_O2T, t2oInstance: TO_INST }),
                otSize: 0,
                ...overrides
            });
        }
        function inputOnlyRequest(overrides = {}) {
            return baseRequest({
                connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: INPUT_O2T, t2oInstance: TO_INST }),
                otSize: 0,
                ...overrides
            });
        }

        function registeredHandler() {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf, addr) => sentDatagrams.push({ buf, addr }) });
            h.registerConnectionPoint('exclusiveOwner', { outputAssembly: OWNER_O2T, inputAssembly: TO_INST });
            h.registerConnectionPoint('inputOnly', { outputAssembly: INPUT_O2T, inputAssembly: TO_INST });
            h.registerConnectionPoint('listenOnly', { outputAssembly: LISTEN_O2T, inputAssembly: TO_INST });
            return h;
        }

        it('a numeric connection with NO registered slots keeps the legacy generic behavior (backward compatibility)', function () {
            // handler (from the outer beforeEach) never calls registerConnectionPoint — every
            // pre-existing test in this file relies on exactly this fallback still working.
            const result = handler.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            const state = [...handler.connections.values()][0];
            assert.strictEqual(state.connType, null);
            assert.strictEqual(state.consumesO2T, true);
        });

        it('classifies a registered (O->T, T->O) pair matching the Exclusive-Owner slot', function () {
            const h = registeredHandler();
            const result = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            const state = [...h.connections.values()][0];
            assert.strictEqual(state.connType, 'exclusiveOwner');
            h.closeAll();
        });

        it('rejects a Listen-Only Forward_Open with extended status 0x0119 when no master (Exclusive-Owner/Input-Only) connection exists yet', function () {
            const h = registeredHandler();
            const result = h.openConnection(listenOnlyRequest(), { remoteAddress: '10.0.0.6' });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.generalStatus, CipGeneralStatus.ConnectionFailure);
            assert.strictEqual(result.extendedStatus, 0x0119);
            h.closeAll();
        });

        it('accepts a Listen-Only Forward_Open once an Exclusive-Owner connection is established, without requiring a real Assembly at the placeholder O->T instance', function () {
            const h = registeredHandler();
            assert.strictEqual(assembly.has(LISTEN_O2T), false); // no real Assembly at the placeholder — by design
            const owner = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(owner.ok, true);

            const listener = h.openConnection(listenOnlyRequest(), { remoteAddress: '10.0.0.6' });
            assert.strictEqual(listener.ok, true);
            const listenerState = [...h.connections.values()].find((c) => c.remoteAddress === '10.0.0.6');
            assert.strictEqual(listenerState.connType, 'listenOnly');
            assert.strictEqual(listenerState.consumesO2T, false);
            h.closeAll();
        });

        it('accepts an Input-Only Forward_Open independently, with no master required', function () {
            const h = registeredHandler();
            const result = h.openConnection(inputOnlyRequest(), { remoteAddress: '10.0.0.7' });
            assert.strictEqual(result.ok, true);
            const state = [...h.connections.values()][0];
            assert.strictEqual(state.connType, 'inputOnly');
            assert.strictEqual(state.consumesO2T, false);
            h.closeAll();
        });

        it('rejects a second Exclusive-Owner Forward_Open for the same T->O instance from a DIFFERENT originator with 0x0106 (Ownership Conflict)', function () {
            const h = registeredHandler();
            const first = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(first.ok, true);

            const second = h.openConnection(
                ownerRequest({ connectionSerialNumber: 0x9999, originatorSerialNumber: 0x55667788 }),
                { remoteAddress: '10.0.0.9' }
            );
            assert.strictEqual(second.ok, false);
            assert.strictEqual(second.extendedStatus, 0x0106);
            assert.strictEqual(h.connections.size, 1);
            h.closeAll();
        });

        it('allows the SAME originator to reconnect its own Exclusive-Owner connection without an Ownership Conflict', function () {
            const h = registeredHandler();
            const first = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(first.ok, true);

            const second = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(second.ok, true);
            assert.strictEqual(h.connections.size, 1); // superseded, not conflicting
            h.closeAll();
        });

        it('supports multiple simultaneous Listen-Only connections (from different originators) to the same T->O instance', function () {
            const h = registeredHandler();
            const owner = h.openConnection(ownerRequest(), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(owner.ok, true);

            const listenerA = h.openConnection(listenOnlyRequest({ connectionSerialNumber: 0xaaaa, originatorSerialNumber: 0x1 }), { remoteAddress: '10.0.0.6' });
            const listenerB = h.openConnection(listenOnlyRequest({ connectionSerialNumber: 0xbbbb, originatorSerialNumber: 0x2 }), { remoteAddress: '10.0.0.7' });
            assert.strictEqual(listenerA.ok, true);
            assert.strictEqual(listenerB.ok, true);
            assert.strictEqual(h.connections.size, 3); // owner + 2 listeners, none evicted the others
            h.closeAll();
        });
    });

    // Ported from OpENer's ciptcpipinterface.c (CipTcpIpCalculateMulticastIp(), CIP Vol 2 §3-5.3)
    // and cipioconnection.c (OpenProducingMulticastConnection()/GetExistingProducerIoConnection()).
    describe('Multicast Class 1 I/O production (CIP Vol 2 §3-5.3)', function () {
        const DEVICE_IP = '192.168.1.10';
        const NETMASK = '255.255.255.0';
        const SAME_SUBNET_ORIGINATOR = '192.168.1.50';
        const OFF_SUBNET_ORIGINATOR = '10.0.0.50';

        function multicastHandler() {
            const tcpIpObject = new TcpIpInterfaceObject({ ip: DEVICE_IP, netmask: NETMASK });
            return new ConnectionHandler({
                assemblyObject: assembly,
                tcpIpObject,
                sendDatagram: (buf, addr, port, opts) => sentDatagrams.push({ buf, addr, opts })
            });
        }

        function multicastRequest(overrides = {}) {
            return baseRequest({ toConnectionType: ConnectionType.Multicast, ...overrides });
        }

        it('computes the device multicast address per CIP Vol 2 §3-5.3 (matches OpENer\'s own formula)', function () {
            // host portion of 192.168.1.10 under /24 is 10 -> hostId = 10-1 = 9 -> base + 9*32 = 239.192.1.0 + 288
            assert.strictEqual(calculateMulticastIp('192.168.1.10', '255.255.255.0'), '239.192.2.32');
        });

        it('rejects a multicast Forward_Open from an Originator outside this device\'s own subnet with extended status 0x0813', function () {
            const h = multicastHandler();
            const result = h.openConnection(multicastRequest(), { remoteAddress: OFF_SUBNET_ORIGINATOR });
            assert.strictEqual(result.ok, false);
            assert.strictEqual(result.generalStatus, CipGeneralStatus.ConnectionFailure);
            assert.strictEqual(result.extendedStatus, 0x0813);
            h.closeAll();
        });

        it('accepts a same-subnet multicast Forward_Open and marks it as the multicast owner', function () {
            const h = multicastHandler();
            const result = h.openConnection(multicastRequest(), { remoteAddress: SAME_SUBNET_ORIGINATOR });
            assert.strictEqual(result.ok, true);
            const state = [...h.connections.values()][0];
            assert.strictEqual(state.multicast, true);
            assert.strictEqual(state.isMulticastFollower, false);
            assert.ok(sentDatagrams.some((d) => d.opts && d.opts.multicast === true));
            h.closeAll();
        });

        it('a second multicast Forward_Open to the SAME T->O instance becomes a follower sharing the owner\'s toNetworkConnectionId, without starting its own producer', function () {
            const h = multicastHandler();
            const owner = h.openConnection(multicastRequest(), { remoteAddress: SAME_SUBNET_ORIGINATOR });
            assert.strictEqual(owner.ok, true);

            const countAfterOwnerOpen = sentDatagrams.length;
            const follower = h.openConnection(
                multicastRequest({ connectionSerialNumber: 0x9999, originatorSerialNumber: 0x77889900, toNetworkConnectionId: 0xbadbadba }),
                { remoteAddress: '192.168.1.51' }
            );
            assert.strictEqual(follower.ok, true);

            // The follower's response must carry the OWNER's toNetworkConnectionId, not its own
            // Scanner's proposed 0xbadbadba — every listener has to agree on one connection ID
            // for the shared multicast stream.
            assert.strictEqual(follower.response.toNetworkConnectionId, owner.response.toNetworkConnectionId);
            assert.notStrictEqual(follower.response.toNetworkConnectionId, 0xbadbadba);

            const followerState = [...h.connections.values()].find((c) => c.remoteAddress === '192.168.1.51');
            assert.strictEqual(followerState.isMulticastFollower, true);
            assert.strictEqual(followerState.timer, null); // no producer of its own

            // Opening the follower must NOT have sent an extra datagram — it has nothing to
            // produce, it shares the owner's already-running stream.
            assert.strictEqual(sentDatagrams.length, countAfterOwnerOpen);
            h.closeAll();
        });

        it('closing the multicast owner also closes any followers sharing its stream', function () {
            const h = multicastHandler();
            const owner = h.openConnection(multicastRequest(), { remoteAddress: SAME_SUBNET_ORIGINATOR });
            h.openConnection(
                multicastRequest({ connectionSerialNumber: 0x9999, originatorSerialNumber: 0x77889900 }),
                { remoteAddress: '192.168.1.51' }
            );
            assert.strictEqual(h.connections.size, 2);

            h.closeConnection({
                connectionSerialNumber: owner.response.connectionSerialNumber,
                originatorVendorId: owner.response.originatorVendorId,
                originatorSerialNumber: owner.response.originatorSerialNumber
            });
            assert.strictEqual(h.connections.size, 0); // owner AND its follower both gone
            h.closeAll();
        });
    });

    // CIP Vol 1 Table 3-4.5's third Production Trigger: unlike Cyclic (fixed RPI timer) or
    // Change-of-State (automatic value comparison), the APPLICATION decides exactly when to
    // produce. Ported from OpENer's own public API for this (cipconnectionmanager.c's
    // TriggerConnections()), which an OpENer-based device's application code calls directly the
    // same way this project's triggerProduction() is meant to be called.
    describe('Connection (Inactivity) Watchdog (CIP Vol 1 §3-4.5.3 / §5-4.4) — regression: connectionTimeoutMultiplier was parsed and then never used', function () {
        it('closes a connection that receives no O->T datagram within otRpiUs * connectionTimeoutMultiplier', function (done) {
            let timeoutsRecorded = 0;
            const connectionManagerObject = { recordOpenRequest() {}, recordCloseRequest() {}, recordTimeout() { timeoutsRecorded++; } };
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {}, connectionManagerObject });
            const result = h.openConnection(baseRequest({ otRpiUs: 5000, connectionTimeoutMultiplier: 2 }), { remoteAddress: '10.0.0.5' }); // 5ms * 2 = 10ms
            assert.strictEqual(result.ok, true);
            assert.strictEqual(h.connections.size, 1);

            // Never call handleIncomingDatagram -- simulates the Originator going silent
            // (network drop, crash, cable pull with no Forward_Close). The watchdog tick runs
            // every 100ms; 250ms gives it two chances to catch a 10ms-old timeout comfortably.
            setTimeout(() => {
                assert.strictEqual(h.connections.size, 0, 'timed-out connection must be closed/removed');
                assert.strictEqual(timeoutsRecorded, 1, 'ConnectionManagerObject.recordTimeout() must be called');
                h.closeAll();
                done();
            }, 250);
        });

        it('does NOT close a connection that keeps receiving O->T datagrams within the timeout window', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {} });
            // A generous 100ms timeout (otRpiUs=25000 * multiplier=4) fed every 10ms leaves wide
            // margin against setInterval jitter under full-suite load -- a tighter margin here
            // (an earlier version used 5ms feed / 10ms timeout) was itself flaky under load,
            // not a bug in the watchdog: a single delayed tick could exceed a too-tight timeout.
            const result = h.openConnection(baseRequest({ otRpiUs: 25000, connectionTimeoutMultiplier: 4 }), { remoteAddress: '10.0.0.5' }); // 100ms timeout
            assert.strictEqual(result.ok, true);
            const connId = result.response.otNetworkConnectionId;

            const feeder = setInterval(() => {
                h.handleIncomingDatagram(buildIoDatagram({ connectionId: connId, sequenceNumber: 1, data: Buffer.from([1, 2, 3, 4]) }));
            }, 10);

            setTimeout(() => {
                clearInterval(feeder);
                assert.strictEqual(h.connections.size, 1, 'a connection with ongoing O->T traffic must NOT be watchdog-closed');
                h.closeAll();
                done();
            }, 250);
        });

        it('does not watchdog a Listen-Only/Input-Only connection (it never consumes O->T in the first place)', function (done) {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {} });
            h.registerConnectionPoint('exclusiveOwner', { outputAssembly: 100, inputAssembly: 101 });
            h.registerConnectionPoint('listenOnly', { outputAssembly: 0xC0, inputAssembly: 101 });
            const owner = h.openConnection(baseRequest({ otRpiUs: 5000, connectionTimeoutMultiplier: 2 }), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(owner.ok, true);
            const listenPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0xC0, t2oInstance: 101 });
            const listener = h.openConnection(baseRequest({
                connectionPath: listenPath, otSize: 0, otRpiUs: 5000, connectionTimeoutMultiplier: 2,
                connectionSerialNumber: 0x5555, originatorSerialNumber: 0x99887766
            }), { remoteAddress: '10.0.0.6' });
            assert.strictEqual(listener.ok, true);
            assert.strictEqual(h.connections.size, 2);

            setTimeout(() => {
                // The owner (consumes O->T, never fed one) IS watchdog-closed; the Listen-Only
                // (never consumes O->T at all) must survive regardless.
                assert.strictEqual(h.connections.size, 1);
                const [remaining] = [...h.connections.values()];
                assert.strictEqual(remaining.connType, 'listenOnly');
                h.closeAll();
                done();
            }, 250);
        });
    });

    describe('Application Object production trigger (CIP Vol 1 Table 3-4.5, ported from OpENer TriggerConnections())', function () {
        it('sends only the mandatory initial packet — no automatic timer at all', function (done) {
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            h.openConnection(baseRequest({ toRpiUs: 5000, transportTypeTrigger: TransportTrigger.Class1ApplicationObject }), { remoteAddress: '10.0.0.5' });
            setTimeout(() => {
                assert.strictEqual(localDatagrams.length, 1); // no polling, no cyclic timer — just the initial send
                h.closeAll();
                done();
            }, 60);
        });

        it('triggerProduction() sends the connection\'s current data on demand', function () {
            const localDatagrams = [];
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            const result = h.openConnection(baseRequest({ transportTypeTrigger: TransportTrigger.Class1ApplicationObject }), { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);
            assert.strictEqual(localDatagrams.length, 1);

            assembly.setData(101, Buffer.from([7, 7, 7, 7]));
            const triggeredCount = h.triggerProduction(101);
            assert.strictEqual(triggeredCount, 1);
            assert.strictEqual(localDatagrams.length, 2);
            const last = parseIoDatagram(localDatagrams[1].buf);
            assert.deepStrictEqual(last.data.subarray(2), Buffer.from([7, 7, 7, 7]));
            h.closeAll();
        });

        it('triggerProduction() is a no-op (returns 0) for a Cyclic or Change-of-State connection', function () {
            const h = new ConnectionHandler({ assemblyObject: assembly, sendDatagram: () => {} });
            h.openConnection(baseRequest(), { remoteAddress: '10.0.0.5' }); // default Cyclic
            assert.strictEqual(h.triggerProduction(101), 0);
            h.closeAll();
        });

        it('works for symbolic Tag connections too, matched by tag name', function () {
            const localDatagrams = [];
            const tagStore = new Map([['TotalCount', { type: 'DINT', buffer: Buffer.from([1, 0, 0, 0]), value: 1 }]]);
            const h = new ConnectionHandler({ assemblyObject: assembly, tagStore, sendDatagram: (buf) => localDatagrams.push({ buf }) });
            const result = h.openConnection({
                connectionPath: encodeSymbolicPath('TotalCount'),
                otSize: 0,
                toSize: 4,
                otRpiUs: 5000,
                toRpiUs: 5000,
                toNetworkConnectionId: 0xdeadbeef,
                connectionSerialNumber: 0x1234,
                originatorVendorId: 0xaaaa,
                originatorSerialNumber: 0x11223344,
                transportTypeTrigger: TransportTrigger.Class1ApplicationObject
            }, { remoteAddress: '10.0.0.5' });
            assert.strictEqual(result.ok, true);

            tagStore.get('TotalCount').buffer = Buffer.from([42, 0, 0, 0]);
            const triggeredCount = h.triggerProduction('TotalCount');
            assert.strictEqual(triggeredCount, 1);
            const last = parseIoDatagram(localDatagrams[localDatagrams.length - 1].buf);
            assert.deepStrictEqual(last.data.subarray(2), Buffer.from([42, 0, 0, 0]));
            h.closeAll();
        });
    });
});
