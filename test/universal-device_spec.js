'use strict';

const assert = require('assert');
require('../src/vendors');
const { Device, DeviceProfile, BatchBuilder, registerProfile, getProfile } = require('../src/device');
const { es2Profile } = require('../src/vendors/delta/profiles/es2');
const { sx3Profile } = require('../src/vendors/delta/profiles/sx3');
const { dvp12seProfile } = require('../src/vendors/delta/profiles/dvp12se');
const { CipGeneralStatus } = require('../src/constants');

describe('Universal Device & Vendor Profile Architecture', () => {
    describe('Profile Registry & Profiles', () => {
        it('resolves registered Delta profiles by primary key and alias', () => {
            const p1 = getProfile('delta:es2');
            const p2 = getProfile('es2');
            assert.strictEqual(p1, es2Profile);
            assert.strictEqual(p2, es2Profile);

            const sx = getProfile('delta:sx3');
            assert.strictEqual(sx, sx3Profile);

            const se = getProfile('delta:12se');
            assert.strictEqual(se, dvp12seProfile);
        });

        it('allows registering a custom third-party vendor profile', () => {
            const customProfile = new DeviceProfile({
                vendor: 'Omron',
                model: 'NX1P2',
                capabilities: { multipleServicePacket: true },
                registers: {
                    HR: { classId: 0x64, instance: 1, dataType: 'INT', access: 'rw' }
                }
            });

            registerProfile(customProfile);
            const found = getProfile('omron:nx1p2');
            assert.strictEqual(found.vendor, 'Omron');
            assert.strictEqual(found.hasRegister('HR'), true);
        });
    });

    describe('Schema-Driven Address Resolution', () => {
        it('ES2: D register resolves to Instance 1, INT 16-bit', () => {
            const resolved = es2Profile.resolveAddress('D', 10);
            assert.strictEqual(resolved.classId, 0x352);
            assert.strictEqual(resolved.instance, 1);
            assert.strictEqual(resolved.attribute, 10);
            assert.strictEqual(resolved.dataType, 'INT');
            assert.strictEqual(resolved.byteWidth, 2);
        });

        it('SX3: D register resolves to Instance 2, INT 16-bit', () => {
            const resolved = sx3Profile.resolveAddress('D', 10);
            assert.strictEqual(resolved.classId, 0x352);
            assert.strictEqual(resolved.instance, 2);
            assert.strictEqual(resolved.attribute, 10);
            assert.strictEqual(resolved.dataType, 'INT');
        });

        it('ES2: C counter < 200 is 16-bit INT, >= 200 is 32-bit DINT', () => {
            const c10 = es2Profile.resolveAddress('C', 10);
            assert.strictEqual(c10.dataType, 'INT');
            assert.strictEqual(c10.byteWidth, 2);

            const c220 = es2Profile.resolveAddress('C', 220);
            assert.strictEqual(c220.dataType, 'DINT');
            assert.strictEqual(c220.byteWidth, 4);
        });

        it('DVP12SE: Maps point index to Instance (index + 1) with fixed attribute 0x64', () => {
            const d0 = dvp12seProfile.resolveAddress('D', 0);
            assert.strictEqual(d0.classId, 0x69);
            assert.strictEqual(d0.instance, 1);
            assert.strictEqual(d0.attribute, 0x64);

            const d50 = dvp12seProfile.resolveAddress('D', 50);
            assert.strictEqual(d50.instance, 51);
        });

        it('Parses octal labels correctly for octal-enabled registers', () => {
            const y10 = es2Profile.resolveAddress('Y', 'Y10');
            assert.strictEqual(y10.attribute, 8); // 10 octal = 8 decimal

            const y377 = es2Profile.resolveAddress('Y', '377');
            assert.strictEqual(y377.attribute, 255);
        });

        it('Rejects unsupported registers with a clear descriptive message', () => {
            assert.throws(
                () => es2Profile.resolveAddress('HC', 0),
                /Register "HC" is not supported on Delta ES2/
            );
        });
    });

    describe('BatchBuilder (Schema-Driven, Zero Hacks)', () => {
        it('queues operations according to active profile schema', () => {
            const builder = new BatchBuilder(es2Profile);
            builder.writeYBit(0, true);
            builder.writeD(5, 500);
            builder.readD(5);

            assert.strictEqual(builder.length, 3);
            assert.strictEqual(builder.operations[0].service, 0x10); // Set_Attribute_Single
            assert.deepStrictEqual(builder.operations[0].data, Buffer.from([1]));

            assert.strictEqual(builder.operations[1].service, 0x10);
            assert.strictEqual(builder.operations[1].data.readInt16LE(0), 500);

            assert.strictEqual(builder.operations[2].service, 0x0E); // Get_Attribute_Single
        });

        it('correctly uses Instance 1 for ES2 D and Instance 2 for SX3 D in batch', () => {
            const es2Builder = new BatchBuilder(es2Profile);
            es2Builder.writeD(0, 100);
            const { encodeEPath } = require('../src/cip/path');
            const expectedEs2Path = encodeEPath({ classId: 0x352, instance: 1, attribute: 0 });
            assert.deepStrictEqual(es2Builder.operations[0].path, expectedEs2Path);

            const sx3Builder = new BatchBuilder(sx3Profile);
            sx3Builder.writeD(0, 100);
            const expectedSx3Path = encodeEPath({ classId: 0x352, instance: 2, attribute: 0 });
            assert.deepStrictEqual(sx3Builder.operations[0].path, expectedSx3Path);
        });
    });

    describe('Universal Device Client', () => {
        const { makeMirrorSession } = require('./helpers/mirror-session');

        it('executes batch operations using Device client', async () => {
            const plc = new Device('127.0.0.1', es2Profile);
            let capturedRequests;

            // Mock scanner.sendMultipleRequests
            plc.scanner.sendMultipleRequests = async (reqs) => {
                capturedRequests = reqs;
                return [
                    { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) },
                    { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0x64, 0x00]) } // 100
                ];
            };

            const results = await plc.batch(b => {
                b.writeYBit(0, true);
                b.readD(0);
            });

            assert.strictEqual(capturedRequests.length, 2);
            assert.deepStrictEqual(results, [true, 100]);
        });

        it('supports full roundtrip read/write on SX3 profile using mirror session', async () => {
            const plc = new Device('127.0.0.1', 'delta:sx3');
            const session = makeMirrorSession();
            plc.scanner.session = session;

            // Word mode D
            await plc.writeD(10, 1234);
            assert.strictEqual(await plc.readD(10), 1234);

            // Word mode Y
            await plc.writeY(0, 500);
            assert.strictEqual(await plc.readY(0), 500);

            // Bit mode M
            await plc.writeM(5, true);
            assert.strictEqual(await plc.readM(5), true);
            await plc.writeM(5, false);
            assert.strictEqual(await plc.readM(5), false);

            // 32-bit HC
            await plc.writeHC(2, 70000);
            assert.strictEqual(await plc.readHC(2), 70000);
        });

        it('supports full roundtrip read/write on ES2 profile using mirror session', async () => {
            const plc = new Device('127.0.0.1', 'delta:es2');
            const session = makeMirrorSession();
            plc.scanner.session = session;

            // D register (Instance 1)
            await plc.writeD(0, 321);
            assert.strictEqual(await plc.readD(0), 321);

            // Y bit mode
            await plc.writeYBit(0, true);
            assert.strictEqual(await plc.readYBit(0), true);

            // C 16-bit vs 32-bit
            await plc.writeC(10, 55);
            assert.strictEqual(await plc.readC(10), 55);
            await plc.writeC(210, 100000);
            assert.strictEqual(await plc.readC(210), 100000);
        });

        it('DeltaDevice works seamlessly as a convenience wrapper around Device', async () => {
            const { DeltaDevice } = require('../src');
            const plc = new DeltaDevice('127.0.0.1', 'sx3');
            assert.strictEqual(plc.profile.vendor, 'Delta');
            assert.strictEqual(plc.profile.model, 'SX3');

            const session = makeMirrorSession();
            plc.scanner.session = session;

            await plc.writeD(1, 999);
            assert.strictEqual(await plc.readD(1), 999);
        });
    });
});

