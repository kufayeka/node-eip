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

    describe('Symbolic Produced/Consumed Tag Connection export (SYMBOL_ANSI)', () => {
        it('adds a "Tag Connection" entry with Path = "SYMBOL_ANSI" once any tag is defined', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Tagged Node' });
            b.addTag('Heartbeat', 'DINT', 0);
            b.defineAssembly({ instance: 100, name: 'Out', type: 'output', sizeBytes: 4 });
            b.defineAssembly({ instance: 101, name: 'In', type: 'input', sizeBytes: 4 });
            b.defineConnection({ name: 'Exclusive Owner', outputAssembly: 100, inputAssembly: 101 });

            const eds = b.generateEds();
            const cm = eds.split('[Connection Manager]')[1].split('[Capacity]')[0];

            assert.ok(cm.includes('"Tag Connection"'));
            assert.ok(cm.includes('"SYMBOL_ANSI"'));
            // 1 Exclusive-Owner + 1 Listen-Only + 1 Input-Only (all on by default per
            // PUB00070 §5.2.2) + 1 Tag Connection = 4.
            assert.ok(cm.includes('MaxInst = 4'));
            assert.ok(cm.includes('Connection4 ='));
        });

        it('adds a Tag Connection entry even for a device with ONLY tags and no Assembly-based connection at all', () => {
            // Previously, the [Connection Manager] section was only emitted when
            // `connections.length > 0` -- a device with just addTag() calls and no
            // defineAssembly()/defineConnection() at all got NO Connection Manager section
            // whatsoever, so its tags were reachable by explicit messaging but could never be
            // selected as a Produced/Consumed Tag Class 1 connection in a Scanner's config tool.
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Tags-Only Node' });
            b.addTag('Tag1', 'BOOL', false);
            b.addTag('Tag2', 'INT', 0);

            const eds = b.generateEds();
            assert.ok(eds.includes('[Connection Manager]'), 'must still emit a Connection Manager section');
            const cm = eds.split('[Connection Manager]')[1].split('[Capacity]')[0];

            assert.ok(cm.includes('"Tag Connection"'));
            assert.ok(cm.includes('"SYMBOL_ANSI"'));
            assert.ok(cm.includes('MaxInst = 1'), 'only the Tag Connection itself -- no Exclusive-Owner/Listen-Only/Input-Only variants without an Assembly');
            assert.ok(cm.includes('Connection1 ='));
        });

        it('does NOT add a Tag Connection entry when no tags are defined', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'No Tags Node' });
            b.defineAssembly({ instance: 100, name: 'Out', type: 'output', sizeBytes: 4 });
            b.defineAssembly({ instance: 101, name: 'In', type: 'input', sizeBytes: 4 });
            b.defineConnection({ name: 'Exclusive Owner', outputAssembly: 100, inputAssembly: 101 });

            const eds = b.generateEds();
            const cm = eds.split('[Connection Manager]')[1].split('[Capacity]')[0];

            assert.ok(!cm.includes('SYMBOL_ANSI'));
            // 1 Exclusive-Owner + 1 Listen-Only + 1 Input-Only, no Tag Connection.
            assert.ok(cm.includes('MaxInst = 3'));
        });

        // Confirmed necessary against a real Delta EIP Builder test: with the
        // Tag Connection's Format field left blank, the Data Exchange grid's
        // "Length" column got stuck at an uneditable default (2 bytes) no
        // matter which tag name was typed in — so numeric tags now also get
        // a synthetic Param entry plus a synthetic Assembly (referenced from
        // the Tag Connection's Format field) the config tool can look their
        // size up against, matching how this project's own real Delta SX3
        // EDS's Tag Connection references an Assembly of Params instead of
        // leaving Format blank.
        it('gives every numeric tag its own synthetic Param and wires a TAG_SYMBOL_TABLE Assembly into the Tag Connection\'s Format fields', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Tagged Node' });
            b.addTag('Heartbeat', 'DINT', 0); // 4 bytes
            b.addTag('CommandCode', 'INT', 10); // 2 bytes
            b.defineAssembly({ instance: 100, name: 'Out', type: 'output', sizeBytes: 4 });
            b.defineAssembly({ instance: 101, name: 'In', type: 'input', sizeBytes: 4 });
            b.defineConnection({ name: 'Exclusive Owner', outputAssembly: 100, inputAssembly: 101 });

            const eds = b.generateEds();

            // Each tag became its own Param, sized to its real CIP type.
            assert.ok(/Param1\s*=[\s\S]*?"Heartbeat"/.test(eds));
            assert.ok(/Param2\s*=[\s\S]*?"CommandCode"/.test(eds));

            // A synthetic Assembly lists both as members...
            const assemblySection = eds.split('[Assembly]')[1].split('[Connection Manager]')[0];
            assert.ok(assemblySection.includes('"TAG_SYMBOL_TABLE"'));
            assert.ok(assemblySection.includes('Param1'));
            assert.ok(assemblySection.includes('Param2'));

            // ...and the Tag Connection's O->T and T->O Format fields both reference it.
            const cm = eds.split('[Connection Manager]')[1].split('[Capacity]')[0];
            const tagConnBlock = cm.split('"Tag Connection"')[0].split(/Connection\d+ =/).pop();
            const tagSymbolAssemMatch = assemblySection.match(/Assem(\d+) =\s*\n\s*"TAG_SYMBOL_TABLE"/);
            assert.ok(tagSymbolAssemMatch);
            const tagSymbolAssemRef = `Assem${tagSymbolAssemMatch[1]}`;
            const formatOccurrences = tagConnBlock.split(tagSymbolAssemRef).length - 1;
            assert.strictEqual(formatOccurrences, 2); // once for O->T, once for T->O
        });

        it('skips STRING-type tags entirely (no synthetic Param/Assembly, Format stays blank)', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'String Tag Node' });
            b.addTag('MES_BatchId', 'STRING', 'BATCH-1');
            b.defineAssembly({ instance: 100, name: 'Out', type: 'output', sizeBytes: 4 });
            b.defineAssembly({ instance: 101, name: 'In', type: 'input', sizeBytes: 4 });
            b.defineConnection({ name: 'Exclusive Owner', outputAssembly: 100, inputAssembly: 101 });

            const eds = b.generateEds();

            assert.ok(!eds.includes('TAG_SYMBOL_TABLE'));
            assert.ok(!eds.includes('MES_BatchId')); // no synthetic Param either
            assert.ok(eds.includes('"SYMBOL_ANSI"')); // the Tag Connection entry itself is still exported
        });
    });

    describe('Fallback param<->Assembly auto-mapping scope (regression)', () => {
        // Found via a real Delta PLC test session: a second, deliberately member-less,
        // bit-packed boolean Assembly (102/103) got silently corrupted because
        // _buildAssemblyMapping()'s convenience fallback for the legacy single-profile
        // convention (Assembly 100 = Output, 101 = Input, no explicit `members`) used to
        // match ANY assembly instance below 110, not just 100/101 -- so it ALSO auto-mapped
        // the first Param that happened to fit into Assembly 102's raw byte, fighting the
        // application's own intentional manual bit pack/unpack of that same byte.
        it('does NOT auto-map params into a member-less Assembly other than 100/101', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Fallback Scope Test', syncIoParams: true });
            b.addParam({ code: '01-00', name: 'Param1', dataType: 'DINT', default: 0, access: 'rw' });
            b.addParam({ code: '02-00', name: 'BoolFlag1', dataType: 'BOOL', default: false, access: 'rw' });

            // Assembly 100/101 use the legacy no-`members` convenience convention on purpose.
            b.defineAssembly({ instance: 100, name: 'Out100', sizeBytes: 4, type: 'output' });
            b.defineAssembly({ instance: 101, name: 'In101', sizeBytes: 4, type: 'input' });
            // Assembly 102/103: deliberately member-less too, but NOT 100/101 -- e.g. a
            // hand-packed bit buffer the application manages itself.
            b.defineAssembly({ instance: 102, name: 'BitOut102', sizeBytes: 1, type: 'output' });
            b.defineAssembly({ instance: 103, name: 'BitIn103', sizeBytes: 1, type: 'input' });

            const adapter = b.createAdapter({ port: 0, address: '127.0.0.1', quiet: true });

            // Writing a nonzero byte to 102 (e.g. some OTHER bit set, bit1) must NOT flip
            // BoolFlag1 -- unlike Param1/100, which the legacy fallback SHOULD still cover.
            adapter.assembly.setData(102, Buffer.from([0b00000010]));
            assert.strictEqual(b.getParamValue('02-00'), false, 'BoolFlag1 must be untouched by writes to the unrelated member-less Assembly 102');

            // The legacy 100/101 convenience mapping must still work (not a regression on its own).
            const buf100 = Buffer.alloc(4);
            buf100.writeInt32LE(4242, 0);
            adapter.assembly.setData(100, buf100);
            assert.strictEqual(b.getParamValue('01-00'), 4242, 'Assembly 100/101 fallback mapping must still work');
        });
    });

    describe('Bit-level member packing (`bitLength: 1`) -- regression: documented but never actually implemented', () => {
        // defineAssembly()'s own JSDoc has always advertised `{ paramId, bitOffset, bitLength }`
        // members, but _buildAssemblyMapping() only ever rounded bitLength up to a whole byte
        // (Math.ceil(bitLength / 8)) and placed every member at its own byte-aligned offset -- so
        // e.g. 5 BOOL members with bitLength:1 silently needed 5 separate bytes, not 1 shared byte,
        // and anything past the Assembly's actual (correctly-sized, 1-byte) buffer was dropped
        // outright. This is exactly why eip_device.js had to hand-roll packBits()/unpackBits() and
        // bypass DeviceBuilder's member system entirely for its own boolean connection -- found
        // when a user's own from-scratch device script, written the way defineAssembly()'s JSDoc
        // says it should work, didn't.
        it('packs multiple bitLength:1 members into the same byte, consume direction (PLC writes)', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Bit Pack Test', syncIoParams: true });
            for (let i = 1; i <= 5; i++) b.addParam({ code: `02-0${i - 1}`, name: `Bit${i}`, dataType: 'BOOL', min: 0, max: 1, default: 0 });

            const members = [
                { paramId: '02-00', bitLength: 1 },
                { paramId: '02-01', bitLength: 1 },
                { paramId: '02-02', bitLength: 1 },
                { paramId: '02-03', bitLength: 1 },
                { paramId: '02-04', bitLength: 1 },
                { bitLength: 3 } // padding, no paramId -- must consume bits without emitting a mapping entry
            ];
            b.defineAssembly({ instance: 102, name: 'BitOut', sizeBytes: 1, type: 'output', members });
            b.defineAssembly({ instance: 103, name: 'BitIn', sizeBytes: 1, type: 'input', members });
            const adapter = b.createAdapter({ port: 0, address: '127.0.0.1', quiet: true });

            adapter.assembly.setData(102, Buffer.from([0b00010101])); // bits 0, 2, 4 set
            assert.strictEqual(b.getParamValue('02-00'), true);
            assert.strictEqual(b.getParamValue('02-01'), false);
            assert.strictEqual(b.getParamValue('02-02'), true);
            assert.strictEqual(b.getParamValue('02-03'), false);
            assert.strictEqual(b.getParamValue('02-04'), true);
        });

        it('packs multiple bitLength:1 members into the same byte, produce direction (application writes)', () => {
            const b = new DeviceBuilder({ vendorId: 799, productName: 'Bit Pack Test 2', syncIoParams: true });
            for (let i = 1; i <= 5; i++) b.addParam({ code: `02-0${i - 1}`, name: `Bit${i}`, dataType: 'BOOL', min: 0, max: 1, default: 0 });

            const members = [
                { paramId: '02-00', bitLength: 1 },
                { paramId: '02-01', bitLength: 1 },
                { paramId: '02-02', bitLength: 1 },
                { paramId: '02-03', bitLength: 1 },
                { paramId: '02-04', bitLength: 1 },
                { bitLength: 3 }
            ];
            b.defineAssembly({ instance: 102, name: 'BitOut', sizeBytes: 1, type: 'output', members });
            b.defineAssembly({ instance: 103, name: 'BitIn', sizeBytes: 1, type: 'input', members });
            const adapter = b.createAdapter({ port: 0, address: '127.0.0.1', quiet: true });

            b.setParam('02-01', true);
            b.setParam('02-04', true);
            b._syncParamsToAssembly(103);
            assert.deepStrictEqual(adapter.assembly.getData(103), Buffer.from([0b00010010])); // bits 1, 4 set
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

            builder.defineAssembly({
                instance: 101,
                name: 'Consume Command',
                sizeBytes: 4,
                type: 'output'
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

        it('watches incoming parameter, tag, and assembly writes in real-time', async () => {
            const events = [];
            builder.watch((event) => {
                events.push(event);
            });

            // 1. Write parameter
            await device.writeParam('01-00', 250);

            // 2. Write tag
            await device.scanner.writeTag('Counter', 999);

            // 3. Write assembly (Instance 101)
            const buf = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
            await device.scanner.setAttribute({ classId: 0x04, instance: 101, attribute: 3, data: buf });

            assert.strictEqual(events.length, 3);
            assert.strictEqual(events[0].type, 'param');
            assert.strictEqual(events[0].code, '01-00');
            assert.strictEqual(events[0].value, 250);

            assert.strictEqual(events[1].type, 'tag');
            assert.strictEqual(events[1].name, 'Counter');
            assert.strictEqual(events[1].value, 999);

            assert.strictEqual(events[2].type, 'assembly');
            assert.strictEqual(events[2].instance, 101);
            assert.strictEqual(events[2].hex, 'aabbccdd');
        });

        it('syncs output assembly writes into mapped parameters and updates input assembly when syncIoParams is enabled', async () => {
            builder.syncIoParams(true);

            // 1. Scanner writes into Output Assembly 101: bytes 0..1 (Param1 TargetFrequency INT)
            // Value 4200 (0x1068 in LE = 0x68, 0x10)
            const outBuf = Buffer.from([0x68, 0x10, 0x00, 0x00]);
            await device.scanner.setAttribute({ classId: 0x04, instance: 101, attribute: 3, data: outBuf });

            // Verify parameter 01-00 was unpacked and updated!
            assert.strictEqual(builder.getParamValue('01-00'), 4200);

            // 2. Virtual device updates parameter 01-00 to 5500 (0x157C)
            builder.setParam('01-00', 5500);

            // Verify Input Assembly 100 was automatically packed with new value
            const inAssemBuf = builder.adapter.assembly.getData(100);
            assert.strictEqual(inAssemBuf.readInt16LE(0), 5500);
        });

        it('accepts Class 3 Connected Explicit Messaging Forward_Open (Path 20 02 24 01)', () => {
            const path20022401 = Buffer.from([0x20, 0x02, 0x24, 0x01]);
            const res = builder.adapter.connectionHandler.openConnection({
                connectionPath: path20022401,
                toNetworkConnectionId: 0x12345678,
                connectionSerialNumber: 0x9999,
                originatorVendorId: 799,
                originatorSerialNumber: 0xABCDEF,
                otRpiUs: 20000,
                toRpiUs: 20000,
                otSize: 0,
                toSize: 0
            }, { remoteAddress: '192.168.68.250' });

            assert.strictEqual(res.ok, true);
            assert(res.response.otNetworkConnectionId > 0);
            assert.strictEqual(res.response.toNetworkConnectionId, 0x12345678);
        });
    });
});

