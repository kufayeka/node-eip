'use strict';

const assert = require('assert');
const { DeviceBuilder } = require('../src/device/builder');
const { EdsFile } = require('../src/cip/eds');
const { Device } = require('../src/device/device');
const { Scanner } = require('../src/scanner');
const { BatchBuilder } = require('../src/device/batch-builder');

describe('Universal EtherNet/IP Device Builder & EDS Exporter', () => {
    describe('Declarative Device Model Construction', () => {
        it('configures device identity, parameters, tags, and assemblies', () => {
            const builder = new DeviceBuilder({
                vendorId: 0x1337,
                vendorName: 'Kufayeka Automation',
                productCode: 50,
                productName: 'MES Smart Gateway',
                deviceType: 'AC Drive',
                description: 'Kufayeka MES Edge Gateway and Inverter Controller'
            });

            // Add Parameters (Class 0x0F)
            builder.addParam({
                code: '01-00',
                name: 'TargetSpeed',
                dataType: 'REAL',
                units: 'RPM',
                min: 0,
                max: 3000,
                default: 1500,
                access: 'rw',
                help: 'Target mixer speed in RPM'
            });

            builder.addParam({
                code: '01-01',
                name: 'ActualTemperature',
                dataType: 'REAL',
                units: '°C',
                min: -50,
                max: 200,
                default: 25.5,
                access: 'r',
                help: 'Chamber temperature'
            });

            // Add Symbolic Tags
            builder.addTag('BatchId', 'STRING', 'BATCH-2026-001');
            builder.addTag('TotalProduced', 'DINT', 100);

            // Add Assemblies
            builder.defineAssembly({
                instance: 100,
                name: 'ProduceToPLC',
                sizeBytes: 8,
                type: 'input'
            });
            builder.defineAssembly({
                instance: 101,
                name: 'ConsumeFromPLC',
                sizeBytes: 4,
                type: 'output'
            });

            assert.strictEqual(builder.identity.vendorId, 0x1337);
            assert.strictEqual(builder.identity.vendorName, 'Kufayeka Automation');
            assert.strictEqual(builder.identity.deviceType, 0x0002); // AC Drive resolved
            assert.strictEqual(builder.params.length, 2);
            assert.strictEqual(builder.tags.size, 2);
            assert.strictEqual(builder.assemblies.length, 2);
        });
    });

    describe('ODVA EDS File Exporter & Conformance Roundtrip', () => {
        let builder;
        let edsText;
        let parsedEds;

        before(() => {
            builder = new DeviceBuilder({
                vendorId: 0x1337,
                vendorName: 'Kufayeka Automation',
                productCode: 77,
                productName: 'Virtual SCADA Node',
                deviceType: 'Generic Device'
            });

            builder.addParam({
                code: '01-00',
                name: 'OperatingFrequency',
                dataType: 'UINT',
                units: 'Hz',
                min: 0,
                max: 6000,
                default: 5000,
                access: 'rw',
                help: 'Max output frequency'
            });

            builder.addParam({
                code: '02-00',
                name: 'MotorPower',
                dataType: 'UDINT',
                units: 'W',
                min: 0,
                max: 100000,
                default: 7500,
                access: 'rw',
                linkPath: '20 28 24 01 30 01'
            });

            builder.defineAssembly({
                instance: 100,
                name: 'Status Assembly',
                sizeBytes: 8,
                type: 'input'
            });

            edsText = builder.generateEds();
            parsedEds = EdsFile.parse(edsText);
        });

        it('generates standard compliant EDS header and device sections', () => {
            assert.ok(edsText.includes('[File]'));
            assert.ok(edsText.includes('[Device]'));
            assert.ok(edsText.includes('VendName = "Kufayeka Automation"'));
            assert.ok(edsText.includes('ProdName = "Virtual SCADA Node"'));
            assert.ok(edsText.includes('VendCode = 4919')); // 0x1337 = 4919

            assert.strictEqual(parsedEds.device.vendorName, 'Kufayeka Automation');
            assert.strictEqual(parsedEds.device.productName, 'Virtual SCADA Node');
            assert.strictEqual(parsedEds.device.productCode, 77);
        });

        it('exports and roundtrips parameters correctly', () => {
            assert.strictEqual(parsedEds.params.size, 2);

            const p1 = parsedEds.params.get(1);
            assert.ok(p1);
            assert.strictEqual(p1.dataType, 0x00C7); // UINT
            assert.strictEqual(p1.dataSize, 2);
            assert.strictEqual(p1.units, 'Hz');
            assert.strictEqual(p1.min, 0);
            assert.strictEqual(p1.max, 6000);
            assert.strictEqual(p1.default, 5000);

            const p2 = parsedEds.params.get(2);
            assert.ok(p2);
            assert.strictEqual(p2.dataType, 0x00C8); // UDINT
            assert.strictEqual(p2.dataSize, 4);
            assert.strictEqual(p2.linkPath, '20 28 24 01 30 01');
        });

        it('exports assemblies and Connection Manager EPATH', () => {
            assert.ok(edsText.includes('[Assembly]'));
            assert.ok(edsText.includes('Assem100'));
            assert.ok(edsText.includes('[Connection Manager]'));
            assert.ok(edsText.includes('Connection1'));

            assert.strictEqual(parsedEds.assemblies.size, 1);
            const assem100 = parsedEds.assemblies.get(100);
            assert.strictEqual(assem100.size, 8);
        });

        it('converts builder directly into client DeviceProfile (toProfile)', () => {
            const profile = builder.toProfile();
            assert.ok(profile);
            assert.strictEqual(profile.vendor, 'Kufayeka Automation');
            assert.strictEqual(profile.model, 'Virtual SCADA Node');

            const p1 = profile.customMethods.getParamInfo(null, '01-00');
            assert.ok(p1);
            assert.strictEqual(p1.dataType, 'UINT');
            assert.strictEqual(p1.units, 'Hz');

            const p2 = profile.customMethods.getParamInfo(null, '02-00');
            assert.ok(p2);
            assert.strictEqual(p2.classId, 0x28); // Resolved via link path
        });
    });

    describe('Live Server (EIPAdapter) & Client Control Loopback', () => {
        let builder;
        let adapter;
        let device;
        const TEST_PORT = 44830;
        const TEST_IO_PORT = 2235;

        before(async () => {
            builder = new DeviceBuilder({
                vendorId: 0x1337,
                vendorName: 'Kufayeka Automation',
                productCode: 99,
                productName: 'Live Test Gateway',
                deviceType: 'Generic Device'
            });

            builder.addParam({
                code: '01-00',
                name: 'ConveyorSpeed',
                dataType: 'INT',
                units: 'm/min',
                default: 50,
                access: 'rw'
            });

            builder.addParam({
                code: '01-01',
                name: 'MotorCurrent',
                dataType: 'REAL',
                units: 'A',
                default: 12.5,
                access: 'r' // Read-only
            });

            builder.addTag('LotId', 'STRING', 'LOT-TEST-999');
            builder.addTag('Counter', 'DINT', 42);

            builder.defineAssembly({
                instance: 100,
                name: 'Produce Status',
                sizeBytes: 4,
                type: 'input'
            });

            // Start live adapter
            adapter = builder.createAdapter({
                port: TEST_PORT,
                ioPort: TEST_IO_PORT,
                address: '127.0.0.1'
            });
            await adapter.start();

            // Connect client Device using builder's generated profile
            const profile = builder.toProfile();
            device = new Device('127.0.0.1', profile, { port: TEST_PORT });
            await device.connect();
        });

        after(async () => {
            if (device) await device.disconnect();
            if (adapter) await adapter.stop();
        });

        it('discovers device identity via ListIdentity', async () => {
            const identity = await Scanner.probe('127.0.0.1', { port: TEST_PORT });
            assert.strictEqual(identity.vendorId, 0x1337);
            assert.strictEqual(identity.productCode, 99);
            assert.strictEqual(identity.productName, 'Live Test Gateway');
        });

        it('reads and writes parameters via Explicit Messaging (Class 0x0F)', async () => {
            // Read default value
            const speed = await device.readParam('01-00');
            assert.strictEqual(speed, 50);

            // Track change event on builder
            let eventFired = false;
            builder.once('paramChange', (code, val) => {
                if (code === '01-00' && val === 120) eventFired = true;
            });

            // Write new parameter value
            await device.writeParam('01-00', 120);
            const speedUpdated = await device.readParam('01-00');
            assert.strictEqual(speedUpdated, 120);
            assert.strictEqual(eventFired, true);

            // Verify builder internal state updated
            assert.strictEqual(builder.getParamValue('01-00'), 120);
        });

        it('enforces read-only permissions on parameters', async () => {
            const current = await device.readParam('01-01');
            assert.ok(Math.abs(current - 12.5) < 0.001);

            // Write to read-only parameter should reject
            await assert.rejects(
                async () => device.writeParam('01-01', 20.0),
                /is read-only/
            );
        });

        it('reads and writes symbolic tags (MES Key-Value storage)', async () => {
            // Read symbolic tags with dataType
            const lotRes = await device.scanner.readTag('LotId', { dataType: 'STRING' });
            assert.strictEqual(lotRes.value, 'LOT-TEST-999');

            const countRes = await device.scanner.readTag('Counter', { dataType: 'DINT' });
            assert.strictEqual(countRes.value, 42);

            // Update symbolic tag from scanner
            await device.scanner.writeTag('Counter', 105);
            const newCountRes = await device.scanner.readTag('Counter', { dataType: 'DINT' });
            assert.strictEqual(newCountRes.value, 105);
        });

        it('supports batch parameter operations on the virtual device', async () => {
            const results = await device.batch(b => {
                b.writeParam('01-00', 180);
                b.readParam('01-00');
                b.readParam('01-01');
            });

            assert.strictEqual(results.length, 3);
            assert.strictEqual(results[0], true); // write success
            assert.strictEqual(results[1], 180);  // read 01-00
            assert.ok(Math.abs(results[2] - 12.5) < 0.001); // read 01-01
        });
    });
});
