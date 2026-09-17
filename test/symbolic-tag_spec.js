'use strict';

const assert = require('assert');
const {
    encodeAnsiSymbolSegment,
    decodeAnsiSymbolSegment,
    encodeSymbolicPath,
    decodeSymbolicPath,
    encodeTagConnectionPath,
    encodeEPath,
    decodeEPath
} = require('../src/cip/path');
const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');

describe('ANSI Extended Symbol Segment & Symbolic Tag Addressing (§26, §27)', function () {
    describe('encodeAnsiSymbolSegment & decodeAnsiSymbolSegment', function () {
        it('encodes even-length symbol without pad byte', function () {
            // "Pump10" has length 6 (even) -> 2 bytes header + 6 bytes ASCII = 8 bytes (4 words)
            const buf = encodeAnsiSymbolSegment('Pump10');
            assert.strictEqual(buf.length, 8);
            assert.strictEqual(buf[0], 0x91);
            assert.strictEqual(buf[1], 6);
            assert.strictEqual(buf.subarray(2).toString('ascii'), 'Pump10');

            const decoded = decodeAnsiSymbolSegment(buf);
            assert.strictEqual(decoded.symbol, 'Pump10');
            assert.strictEqual(decoded.bytesConsumed, 8);
        });

        it('encodes odd-length symbol with 1 pad byte for 16-bit word alignment', function () {
            // "Motor" has length 5 (odd) -> 2 bytes header + 5 bytes ASCII + 1 pad byte = 8 bytes
            const buf = encodeAnsiSymbolSegment('Motor');
            assert.strictEqual(buf.length, 8);
            assert.strictEqual(buf[0], 0x91);
            assert.strictEqual(buf[1], 5);
            assert.strictEqual(buf.subarray(2, 7).toString('ascii'), 'Motor');
            assert.strictEqual(buf[7], 0x00); // Pad byte

            const decoded = decodeAnsiSymbolSegment(buf);
            assert.strictEqual(decoded.symbol, 'Motor');
            assert.strictEqual(decoded.bytesConsumed, 8);
        });

        it('validates symbol name type and length boundaries', function () {
            assert.throws(() => encodeAnsiSymbolSegment(''), /non-empty string/);
            assert.throws(() => encodeAnsiSymbolSegment(null), /non-empty string/);
            assert.throws(() => encodeAnsiSymbolSegment('A'.repeat(256)), /exceeds 255 bytes/);

            assert.throws(() => decodeAnsiSymbolSegment(Buffer.from([0x20, 0x01])), /not an ANSI Extended Symbol/);
            assert.throws(() => decodeAnsiSymbolSegment(Buffer.from([0x91])), /truncated symbol segment header/);
            assert.throws(() => decodeAnsiSymbolSegment(Buffer.from([0x91, 0x05, 0x41, 0x42])), /truncated symbol data/);
        });
    });

    describe('encodeSymbolicPath & decodeSymbolicPath', function () {
        it('encodes and decodes a simple tag name', function () {
            const buf = encodeSymbolicPath('TotalCount');
            const res = decodeSymbolicPath(buf);
            assert.strictEqual(res.tagPath, 'TotalCount');
            assert.strictEqual(res.tokens.length, 1);
            assert.strictEqual(res.tokens[0].type, 'symbol');
            assert.strictEqual(res.tokens[0].value, 'TotalCount');
        });

        it('encodes and decodes struct member dot navigation', function () {
            const buf = encodeSymbolicPath('Motor.Speed');
            const res = decodeSymbolicPath(buf);
            assert.strictEqual(res.tagPath, 'Motor.Speed');
            assert.strictEqual(res.tokens.length, 2);
            assert.strictEqual(res.tokens[0].value, 'Motor');
            assert.strictEqual(res.tokens[1].value, 'Speed');
        });

        it('encodes and decodes array subscript indexing', function () {
            const buf = encodeSymbolicPath('Tanks[3]');
            const res = decodeSymbolicPath(buf);
            assert.strictEqual(res.tagPath, 'Tanks[3]');
            assert.strictEqual(res.tokens.length, 2);
            assert.strictEqual(res.tokens[0].type, 'symbol');
            assert.strictEqual(res.tokens[0].value, 'Tanks');
            assert.strictEqual(res.tokens[1].type, 'member');
            assert.strictEqual(res.tokens[1].value, 3);
        });

        it('encodes and decodes complex nested paths (arrays and struct members)', function () {
            const pathStr = 'Lines[0].Motors[2].TargetSpeed';
            const buf = encodeSymbolicPath(pathStr);
            const res = decodeSymbolicPath(buf);
            assert.strictEqual(res.tagPath, pathStr);
            assert.strictEqual(res.tokens.length, 5);
            assert.deepStrictEqual(res.tokens, [
                { type: 'symbol', value: 'Lines' },
                { type: 'member', value: 0 },
                { type: 'symbol', value: 'Motors' },
                { type: 'member', value: 2 },
                { type: 'symbol', value: 'TargetSpeed' }
            ]);
        });
    });

    describe('encodeEPath & decodeEPath symbolic integration', function () {
        it('accepts string directly in encodeEPath', function () {
            const buf = encodeEPath('ProductionCount');
            const decoded = decodeEPath(buf);
            assert.strictEqual(decoded.tagPath, 'ProductionCount');
            assert.deepStrictEqual(decoded.symbols, ['ProductionCount']);
        });

        it('supports combining Port Segments and Symbolic Segments (routed tag access)', function () {
            // Route through Port 1 (Backplane), Slot 0, to tag "TankLevel"
            const buf = encodeEPath({
                port: 1,
                linkAddress: 0,
                tag: 'TankLevel'
            });
            const decoded = decodeEPath(buf);
            assert.strictEqual(decoded.portSegments.length, 1);
            assert.strictEqual(decoded.portSegments[0].port, 1);
            assert.strictEqual(decoded.portSegments[0].linkAddress, 0);
            assert.strictEqual(decoded.tagPath, 'TankLevel');
        });

        it('encodes Tag Connection Path for Produced/Consumed Tag I/O Connections', function () {
            const connPath = encodeTagConnectionPath({
                configTag: 'CfgParams',
                o2tTag: 'ConsumedTag',
                t2oTag: 'ProducedTag'
            });
            // Total length must be an even number of bytes (word-aligned)
            assert.strictEqual(connPath.length % 2, 0);
            assert.ok(connPath.length >= 24);
        });
    });

    describe('EIPAdapter & Scanner Symbolic Tag Loopback', function () {
        let adapter;
        let scanner;
        const testPort = 46000 + Math.floor(Math.random() * 1000);

        before(async function () {
            adapter = new EIPAdapter({
                port: testPort,
                ioPort: testPort + 1
            });

            // Define symbolic tags on the adapter
            adapter.defineTag('MotorSpeed', 'INT', 1750);
            adapter.defineTag('TankLevel', 'REAL', 88.5);
            adapter.defineTag('SystemReady', 'BOOL', true);
            adapter.defineTag('PartName', 'STRING', 'Turbine_A1');

            await adapter.start();

            scanner = new Scanner({ host: '127.0.0.1', port: testPort });
            await scanner.connect();
        });

        after(async function () {
            if (scanner) await scanner.disconnect();
            if (adapter) await adapter.stop();
        });

        it('reads symbolic tag MotorSpeed (INT) and decodes value', async function () {
            const res = await scanner.readTag('MotorSpeed', { dataType: 'INT' });
            assert.strictEqual(res.value, 1750);
            assert.strictEqual(res.data.readInt16LE(0), 1750);
        });

        it('reads symbolic tag TankLevel (REAL / float32)', async function () {
            const res = await scanner.readTag('TankLevel', { dataType: 'REAL' });
            assert.strictEqual(Math.abs(res.value - 88.5) < 0.001, true);
        });

        it('reads symbolic tag SystemReady (BOOL)', async function () {
            const res = await scanner.readTag('SystemReady', { dataType: 'BOOL' });
            assert.strictEqual(res.value, true);
        });

        it('reads symbolic tag PartName (STRING)', async function () {
            const res = await scanner.readTag('PartName', { dataType: 'STRING' });
            assert.strictEqual(res.value, 'Turbine_A1');
        });

        it('writes symbolic tag MotorSpeed and verifies update', async function () {
            await scanner.writeTag('MotorSpeed', 2450, { dataType: 'INT' });
            assert.strictEqual(adapter.getTag('MotorSpeed').value, 2450);

            // Read back to ensure roundtrip
            const res = await scanner.readTag('MotorSpeed', { dataType: 'INT' });
            assert.strictEqual(res.value, 2450);
        });

        it('writes symbolic tag with inferred data type', async function () {
            await scanner.writeTag('SystemReady', false);
            assert.strictEqual(adapter.getTag('SystemReady').value, false);

            const res = await scanner.readTag('SystemReady', { dataType: 'BOOL' });
            assert.strictEqual(res.value, false);
        });

        it('returns PathDestinationUnknown (0x05) on non-existent symbolic tag', async function () {
            await assert.rejects(
                () => scanner.readTag('UnknownTagXYZ'),
                /general status 0x5/
            );
        });
    });
});
