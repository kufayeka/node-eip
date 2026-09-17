'use strict';

const assert = require('assert');
const path = require('path');
const { EdsFile, stripComments, parseLiteral } = require('../src/cip/eds');

const ES3_EDS_PATH = path.join(__dirname, '..', 'eds', 'DELTA_IA-PLC_DVPES3-V01-08_EIP_EP_20240401', '031F000E0F0300010001.eds');
const ES2_EDS_PATH = path.join(__dirname, '..', 'eds', 'DELTA_IA-PLC_DVPES2E-V01-08_EIP_EP_20240401', '031F000E030000010001.eds');

describe('ODVA Standard EDS File Parser (§43, §44, §45)', function () {
    describe('Lexer & Comment Stripping', function () {
        it('strips inline $ comments but preserves $ inside quoted strings', function () {
            const raw = `
                $ Comment line 1
                Key1 = "Value $ with dollar"; $ trailing comment
                Key2 = 123;
            `;
            const clean = stripComments(raw);
            assert(!clean.includes('Comment line 1'));
            assert(!clean.includes('trailing comment'));
            assert(clean.includes('"Value $ with dollar"'));
            assert(clean.includes('Key2 = 123;'));
        });

        it('parses numeric literals in decimal, 0x hex, and 16# hex', function () {
            assert.strictEqual(parseLiteral('123'), 123);
            assert.strictEqual(parseLiteral('-45'), -45);
            assert.strictEqual(parseLiteral('0x1A'), 0x1A);
            assert.strictEqual(parseLiteral('16#031F'), 0x031F);
            assert.strictEqual(parseLiteral('2#1011'), 11);
            assert.strictEqual(parseLiteral('"hello"'), 'hello');
        });
    });

    describe('Delta DVP-ES3 EDS File Parsing', function () {
        let eds;

        before(function () {
            eds = EdsFile.fromFile(ES3_EDS_PATH);
        });

        it('extracts Device identity metadata correctly (§44)', function () {
            assert.strictEqual(eds.device.vendorId, 799); // 0x031F
            assert.strictEqual(eds.device.vendorName, 'Delta electronics, inc.');
            assert.strictEqual(eds.device.deviceType, 14); // PLC
            assert.strictEqual(eds.device.productCode, 3843); // 0x0F03
            assert.strictEqual(eds.device.majorRevision, 1);
            assert.strictEqual(eds.device.minorRevision, 1);
            assert.strictEqual(eds.device.productName, 'DVP-ES3');
        });

        it('matches against discovered device identity (§44, §45)', function () {
            const discovered = {
                vendorId: 799,
                deviceType: 14,
                productCode: 3843,
                majorRevision: 1
            };
            assert.strictEqual(eds.matchesDevice(discovered), true);

            const wrongProduct = { ...discovered, productCode: 9999 };
            assert.strictEqual(eds.matchesDevice(wrongProduct), false);
        });

        it('extracts Assemblies and declared maximum sizes', function () {
            assert(eds.assemblies.size > 0);
            const assem1 = eds.assemblies.get(1);
            assert(assem1);
            assert.strictEqual(assem1.name, 'Output(O->T) Data');
            assert.strictEqual(assem1.size, 500);

            const assem2 = eds.assemblies.get(2);
            assert(assem2);
            assert.strictEqual(assem2.name, 'Input(T->O) Data');
            assert.strictEqual(assem2.size, 500);
        });

        it('extracts Connection Manager profiles and decodes EPATH paths', function () {
            assert(eds.connections.length > 0);
            const conn1 = eds.getDefaultConnection();
            assert(conn1);
            assert.strictEqual(conn1.name, 'Connection1');
            assert.strictEqual(conn1.triggerAndTransport.isCyclic, true);

            // EPATH: 20 04 24 80 2C 64 2C 65
            assert(conn1.parsedPath);
            assert.strictEqual(conn1.parsedPath.classId, 4); // Assembly
            assert.strictEqual(conn1.parsedPath.configInstance, 128); // 0x80
            assert.strictEqual(conn1.parsedPath.o2tInstance, 100); // 0x64
            assert.strictEqual(conn1.parsedPath.t2oInstance, 101); // 0x65

            // RPI
            assert.strictEqual(conn1.toRpi.default, 20000); // 20ms
        });

        it('builds ready-to-use Forward_Open parameters automatically', function () {
            const params = eds.buildForwardOpenParams(1);
            assert.deepStrictEqual(params.connectionPath, Buffer.from([0x20, 0x04, 0x24, 0x80, 0x2c, 0x64, 0x2c, 0x65]));
            assert.strictEqual(params.rpiUs, 20000);
            assert.strictEqual(params.otSize, 500);
            assert.strictEqual(params.toSize, 500);
        });

        it('allows overriding specific Forward_Open parameters', function () {
            const custom = eds.buildForwardOpenParams(1, {
                otSize: 200,
                toSize: 200,
                rpiUs: 10000
            });
            assert.strictEqual(custom.otSize, 200);
            assert.strictEqual(custom.toSize, 200);
            assert.strictEqual(custom.rpiUs, 10000);
            assert.deepStrictEqual(custom.connectionPath, Buffer.from([0x20, 0x04, 0x24, 0x80, 0x2c, 0x64, 0x2c, 0x65]));
        });
    });

    describe('Delta DVP-ES2-E EDS File Parsing', function () {
        it('parses DVP-ES2-E EDS correctly', function () {
            const eds = EdsFile.fromFile(ES2_EDS_PATH);
            assert.strictEqual(eds.device.vendorId, 799);
            assert.strictEqual(eds.device.productCode, 768); // 0x0300
            assert.strictEqual(eds.device.productName, 'DVP20ES2-E');

            const conn = eds.getDefaultConnection();
            assert.strictEqual(conn.parsedPath.configInstance, 128);
            assert.strictEqual(conn.parsedPath.o2tInstance, 100);
            assert.strictEqual(conn.parsedPath.t2oInstance, 101);

            const params = eds.buildForwardOpenParams();
            assert.strictEqual(params.otSize, 200);
            assert.strictEqual(params.toSize, 200);
            assert.strictEqual(params.rpiUs, 20000);
        });
    });
});
