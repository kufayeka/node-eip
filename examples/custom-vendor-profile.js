'use strict';

/**
 * Custom 3rd-Party Vendor Profile Registration Demo
 *
 * Demonstrates how developers can define and register a custom DeviceProfile
 * for ANY PLC vendor/model (e.g. Omron, Panasonic, Mitsubishi, or custom hardware)
 * without touching core ODVA CIP protocol files.
 *
 * Usage: node examples/custom-vendor-profile.js
 */

const {
    DeviceProfile,
    registerProfile,
    getProfile,
    Device,
    BatchBuilder
} = require('../src/device');
const { CipCommonServices } = require('../src/constants');

function main() {
    console.log('=== Custom Vendor Profile Registration Demo ===\n');

    // 1. Define custom vendor profile declaratively
    console.log('[1] Defining custom device profile for "Omron NX1P2"...');
    const omronProfile = new DeviceProfile({
        vendor: 'Omron',
        model: 'NX1P2',
        description: 'Omron NX1P2 Machine Automation Controller (CIP Modbus/IO gateway)',
        capabilities: {
            multipleServicePacket: true,
            symbolicTags: true
        },
        registers: {
            // Holding Registers (16-bit INT word)
            HR: {
                classId: 0x64,
                instance: 1,
                dataType: 'INT',
                access: 'rw',
                range: [0, 999]
            },
            // Work Bits (1-bit BOOL)
            WR: {
                classId: 0x65,
                instance: 1,
                dataType: 'BOOL',
                access: 'rw',
                isBit: true,
                range: [0, 999]
            },
            // Double Word Registers (32-bit DINT)
            DM: {
                classId: 0x66,
                instance: 1,
                dataType: 'DINT',
                access: 'rw',
                range: [0, 499]
            }
        },
        customMethods: {
            sayHello: (target) => {
                return `Hello from ${target.profile.name} at ${target.host}!`;
            }
        }
    });

    // 2. Register profile in the global registry
    registerProfile(omronProfile, ['omron', 'nx1p2']);
    console.log('Profile registered under keys: "omron:nx1p2", "omron", "nx1p2"');

    // 3. Resolve addresses from profile schema
    console.log('\n[2] Resolving register addresses via schema:');
    const hr10 = omronProfile.resolveAddress('HR', 10);
    console.log('HR10 ->', {
        classId: `0x${hr10.classId.toString(16)}`,
        instance: hr10.instance,
        attribute: hr10.attribute,
        dataType: hr10.dataType,
        byteWidth: hr10.byteWidth
    });

    const wr5 = omronProfile.resolveAddress('WR', 5);
    console.log('WR5  ->', {
        classId: `0x${wr5.classId.toString(16)}`,
        instance: wr5.instance,
        attribute: wr5.attribute,
        dataType: wr5.dataType,
        isBit: wr5.isBit
    });

    const dm2 = omronProfile.resolveAddress('DM', 2);
    console.log('DM2  ->', {
        classId: `0x${dm2.classId.toString(16)}`,
        instance: dm2.instance,
        attribute: dm2.attribute,
        dataType: dm2.dataType,
        byteWidth: dm2.byteWidth
    });

    // 4. Test Schema-Driven BatchBuilder
    console.log('\n[3] Building batch requests using BatchBuilder:');
    const builder = new BatchBuilder(omronProfile);
    builder.writeHR(10, 1234);
    builder.writeWRBit(5, true);
    builder.writeDM(2, 500000);
    builder.readHR(10);
    builder.readWRBit(5);

    console.log(`Batched ${builder.length} operations:`);
    builder.operations.forEach((op, i) => {
        const serviceName = op.service === CipCommonServices.SetAttributeSingle ? 'Set_Attribute_Single (0x10)' : 'Get_Attribute_Single (0x0E)';
        console.log(`  [${i + 1}] ${op.label}: ${serviceName} | Path: 0x${op.path.toString('hex')}`);
    });

    // 5. Test Device Proxy & Custom Methods
    console.log('\n[4] Instantiating Device client with registered profile key:');
    const plc = new Device('192.168.1.100', 'omron:nx1p2');
    console.log('device.profile.name =', plc.profile.name);
    console.log('device.sayHello()   =', plc.sayHello());
    console.log('Dynamic methods available on device: readHR, writeHR, readWRBit, writeWRBit, readDM, writeDM');

    console.log('\nCustom Vendor Profile Demo finished successfully!');
}

main();
