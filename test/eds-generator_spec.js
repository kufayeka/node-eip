'use strict';

const assert = require('assert');
const { DeviceProfile } = require('../src/device/profile');
const { Device } = require('../src/device/device');
const { BatchBuilder } = require('../src/device/batch-builder');
const { createProfileFromEds, generateProfileCodeFromEds } = require('../src/device/eds-generator');
const { EdsFile } = require('../src/cip/eds');
const { makeMirrorSession } = require('./helpers/mirror-session');

const sampleInverterEds = `
[File]
    DescText = "Test VFD Inverter EDS";
    CreateDate = 01-01-2025;
    CreateTime = 12:00:00;
    Revision = 1.0;

[Device]
    VendCode = 319;
    VendName = "Delta";
    ProdType = 2;
    ProdTypeStr = "AC Drive";
    ProdCode = 100;
    MajRev = 1;
    MinRev = 1;
    ProdName = "VFD-C2000";

[Params]
    Param1 =
        0,                      $ reserved
        ,,                      $ link path
        0x0002,                 $ descriptor (read/write)
        0x00C7,                 $ UINT 16-bit
        2,                      $ size
        "01-00 Output Frequency", $ name
        "Hz",                   $ units
        "Output speed in 0.01 Hz", $ help
        0, 6000, 5000;          $ min, max, default

    Param2 =
        0,
        ,,
        0x0001,                 $ descriptor (read-only)
        0x00C7,                 $ UINT 16-bit
        2,
        "01-01 Output Current",
        "A",
        "Motor current in 0.1 A",
        0, 500, 0;

    Param3 =
        0,
        "20 28 24 01 30 01",     $ link path: Class 0x28 (Motor Data), Inst 1, Attr 1
        0x0002,
        0x00C8,                 $ UDINT 32-bit
        4,
        "02-00 Rated Power",
        "W",
        "Motor rated power in Watts",
        0, 100000, 7500;

[Assembly]
    Assem70 =
        "Drive Output Status",
        ,
        4,
        0x0000;

    Assem20 =
        "Drive Input Control",
        ,
        4,
        0x0000;

[Connection Manager]
    Connection1 =
        0x04010002,
        0x44640405,
        20000, 4,
        20000, 4,
        ,,
        ,,
        "Basic Speed Control",
        "",
        "20 04 24 01 2C 46 2C 14";
`;

describe('Universal EDS to DeviceProfile Generator', () => {
    let profile;

    before(() => {
        profile = createProfileFromEds(sampleInverterEds);
    });

    describe('Profile Parsing & Metadata', () => {
        it('extracts vendor, model, and capabilities from EDS', () => {
            assert.strictEqual(profile.vendor, 'Delta');
            assert.strictEqual(profile.model, 'VFD-C2000');
            assert.strictEqual(profile.capabilities.class1IO, true);
            assert.strictEqual(profile.capabilities.multipleServicePacket, true);
        });

        it('extracts parameters metadata correctly via getParamInfo', () => {
            const p1 = profile.customMethods.getParamInfo(null, '01-00');
            assert.ok(p1);
            assert.strictEqual(p1.id, 1);
            assert.strictEqual(p1.code, '01-00');
            assert.strictEqual(p1.units, 'Hz');
            assert.strictEqual(p1.dataType, 'UINT');
            assert.strictEqual(p1.access, 'rw');
            assert.strictEqual(p1.min, 0);
            assert.strictEqual(p1.max, 6000);

            // Access via numeric ID
            const p1ById = profile.customMethods.getParamInfo(null, 1);
            assert.strictEqual(p1ById.name, '01-00 Output Frequency');

            // Access via sanitized name
            const p2 = profile.customMethods.getParamInfo(null, 'Output Current');
            assert.strictEqual(p2.id, 2);
            assert.strictEqual(p2.access, 'r');
        });

        it('decodes Link Path when present in EDS', () => {
            const p3 = profile.customMethods.getParamInfo(null, '02-00');
            assert.ok(p3);
            assert.strictEqual(p3.classId, 0x28); // Class 0x28 Motor Data
            assert.strictEqual(p3.instance, 1);
            assert.strictEqual(p3.attribute, 1);
            assert.strictEqual(p3.dataType, 'UDINT');
            assert.strictEqual(p3.byteWidth, 4);
        });
    });

    describe('Address Resolution & Parameter Read/Write', () => {
        it('resolves parameter by code and ID via PARAM register', () => {
            const res1 = profile.resolveAddress('PARAM', '01-00');
            assert.strictEqual(res1.classId, 0x0F);
            assert.strictEqual(res1.instance, 1);
            assert.strictEqual(res1.attribute, 1);
            assert.strictEqual(res1.dataType, 'UINT');

            const res2 = profile.resolveAddress('PARAM', 2);
            assert.strictEqual(res2.classId, 0x0F);
            assert.strictEqual(res2.instance, 2);
            assert.strictEqual(res2.attribute, 1);
            assert.strictEqual(res2.dataType, 'UINT');
        });

        it('executes readParam and writeParam round-trips with Device client', async () => {
            const vfd = new Device('127.0.0.1', profile);
            const session = makeMirrorSession();
            vfd.scanner.session = session;

            // Write and read back via parameter code
            await vfd.writeParam('01-00', 5000);
            const freq = await vfd.readParam('01-00');
            assert.strictEqual(freq, 5000);

            // Write and read back via numeric parameter ID
            await vfd.writeParam(1, 4500);
            const freq2 = await vfd.readParam(1);
            assert.strictEqual(freq2, 4500);
        });

        it('enforces read-only permissions on parameters', async () => {
            const vfd = new Device('127.0.0.1', profile);
            const session = makeMirrorSession();
            vfd.scanner.session = session;

            // Param 2 is read-only
            await assert.rejects(
                async () => vfd.writeParam('01-01', 100),
                /is read-only/
            );
        });
    });

    describe('Batch Operations on Parameters', () => {
        it('supports batching multiple parameters via BatchBuilder', () => {
            const builder = new BatchBuilder(profile);
            builder.writeParam('01-00', 6000);
            builder.readParam('01-00');
            builder.readParam('01-01');

            assert.strictEqual(builder.length, 3);
            assert.strictEqual(builder.operations[0].service, 0x10); // Set_Attribute_Single
            assert.strictEqual(builder.operations[1].service, 0x0E); // Get_Attribute_Single
            assert.strictEqual(builder.operations[2].service, 0x0E); // Get_Attribute_Single
        });
    });

    describe('Assembly Object Codecs (ODVA Drive Instances 20/70)', () => {
        it('decodes ODVA AC Drive Input Assembly 70 (Basic Speed Status)', () => {
            // Buffer: Byte 0 = 0x0C (ready=1, runningFwd=1), Byte 1 = 0, Bytes 2..3 = 1750 RPM
            const rawBuffer = Buffer.from([0x0C, 0x00, 0xD6, 0x06]);
            const decoded = profile.customMethods.decodeInputAssembly(null, rawBuffer);

            assert.strictEqual(decoded.ready, true);
            assert.strictEqual(decoded.runningFwd, true);
            assert.strictEqual(decoded.faulted, false);
            assert.strictEqual(decoded.warning, false);
            assert.strictEqual(decoded.actualSpeed, 1750);
        });

        it('encodes ODVA AC Drive Output Assembly 20 (Basic Speed Control)', () => {
            const command = {
                runFwd: true,
                faultReset: false,
                speedReference: 1800
            };
            const encoded = profile.customMethods.encodeOutputAssembly(null, command);

            assert.strictEqual(encoded.length, 4);
            assert.strictEqual(encoded[0] & 0x01, 1); // runFwd bit set
            assert.strictEqual(encoded.readInt16LE(2), 1800);
        });
    });

    describe('Static Code Generator (generateProfileCodeFromEds)', () => {
        it('generates standalone JavaScript module code', () => {
            const code = generateProfileCodeFromEds(sampleInverterEds, {
                vendor: 'Delta',
                model: 'VFD-C2000'
            });

            assert.ok(code.includes("const { DeviceProfile } = require('../../../device/profile');"));
            assert.ok(code.includes("'01-00':"));
            assert.ok(code.includes('vfd_c2000Profile'));
            assert.ok(code.includes('readParam'));
            assert.ok(code.includes('writeParam'));
        });
    });
});
