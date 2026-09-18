'use strict';

/**
 * Example: Universal EDS-Driven Inverter & Drive Profile Control
 *
 * Demonstrates:
 * 1. Automatically generating a DeviceProfile from an ODVA EDS file (e.g. VFD-C2000, PowerFlex).
 * 2. Reading & writing parameters using simple codes:
 *      await vfd.writeParam('01-00', 50.0);
 *      const freq = await vfd.readParam('01-00');
 * 3. Inspecting parameter specifications (engineering units, min/max, access mode).
 * 4. Decoding high-speed Class 1 I/O Assembly streams (UDP 2222) into meaningful structured objects:
 *      io.on('data', (buf) => {
 *          const status = vfd.decodeInputAssembly(buf);
 *          console.log(status.runningFwd, status.actualSpeed);
 *      });
 */

const { DeviceProfile } = require('../src/device/profile');
const { Device } = require('../src/device/device');
const { BatchBuilder } = require('../src/device/batch-builder');

// Sample ODVA AC Drive EDS (representative of Inverters like Delta VFD-C2000 / Rockwell PowerFlex)
const sampleInverterEds = `
[File]
    DescText = "Delta VFD-C2000 AC Drive EDS";
    CreateDate = 01-15-2025;
    CreateTime = 10:00:00;
    Revision = 1.0;

[Device]
    VendCode = 319;
    VendName = "Delta Electronics";
    ProdType = 2;
    ProdTypeStr = "AC Drive";
    ProdCode = 100;
    MajRev = 1;
    MinRev = 1;
    ProdName = "VFD-C2000";

[Params]
    Param1 =
        0,
        ,,
        0x0002,                 $ descriptor (read/write)
        0x00C7,                 $ UINT 16-bit
        2,                      $ size
        "01-00 Max Operation Frequency",
        "Hz",
        "Max output frequency (0.01 Hz resolution)",
        0, 60000, 6000;

    Param2 =
        0,
        ,,
        0x0002,
        0x00C7,
        2,
        "01-09 Acceleration Time 1",
        "s",
        "Acceleration time in 0.1 s",
        1, 6000, 100;

    Param3 =
        0,
        ,,
        0x0001,                 $ descriptor (read-only)
        0x00C7,
        2,
        "01-01 Output Current",
        "A",
        "Measured output current in 0.1 A",
        0, 1000, 0;

    Param4 =
        0,
        "20 28 24 01 30 01",     $ Link Path to CIP Class 0x28 (Motor Data), Inst 1, Attr 1
        0x0002,
        0x00C8,                 $ UDINT 32-bit
        4,
        "02-00 Motor Rated Power",
        "W",
        "Motor rated power in Watts",
        100, 500000, 7500;

[Assembly]
    Assem70 =
        "Basic Speed Status (Drive Output)",
        ,
        4,
        0x0000;

    Assem20 =
        "Basic Speed Control (Drive Input)",
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

async function main() {
    console.log('=== Universal EDS Device Profile & Inverter Demo ===\n');

    // 1. Create a DeviceProfile directly from EDS content or file path
    console.log('[1] Generating DeviceProfile from Inverter EDS...');
    const vfdProfile = DeviceProfile.fromEds(sampleInverterEds);

    console.log(`Device:      ${vfdProfile.vendor} - ${vfdProfile.model}`);
    console.log(`Class 1 I/O: ${vfdProfile.capabilities.class1IO ? 'Supported (UDP 2222)' : 'Not Supported'}`);

    // 2. Query parameter catalog & metadata
    console.log('\n[2] Inspecting Parameter Catalog:');
    const paramList = vfdProfile.customMethods.listParams();
    console.table(paramList);

    // Inspect individual parameter
    const pInfo = vfdProfile.customMethods.getParamInfo(null, '01-00');
    console.log(`\nParameter 01-00 Specs:`, {
        name: pInfo.name,
        units: pInfo.units,
        dataType: pInfo.dataType,
        access: pInfo.access,
        range: `[${pInfo.min} .. ${pInfo.max}]`
    });

    // 3. Connect to Drive and read/write parameters via Explicit Messaging (TCP 44818)
    console.log('\n[3] Inverter Parameter Read/Write API:');
    const vfd = new Device('192.168.68.50', vfdProfile);

    console.log(`API Usage:`);
    console.log(`  await vfd.writeParam('01-00', 5000);  // Sets Output Freq to 50.00 Hz`);
    console.log(`  const current = await vfd.readParam('01-01'); // Reads Measured Current`);
    console.log(`  await vfd.writeParam('01-09', 150);   // Sets Accel Time to 15.0 s`);
    console.log(`  const power = await vfd.readParam('02-00');   // Routed to CIP Class 0x28`);

    // 4. Batch parameter reads using BatchBuilder (CIP 0x0A Multiple Service Packet)
    console.log('\n[4] Multiple Parameter Batch Read:');
    const batch = new BatchBuilder(vfdProfile);
    batch.readParam('01-00');
    batch.readParam('01-01');
    batch.readParam('02-00');
    console.log(`Batch queued ${batch.operations.length} explicit parameter requests.`);

    // 5. High-Speed Class 1 Cyclic I/O Assembly (UDP 2222)
    console.log('\n[5] Real-Time I/O Assembly Streaming (UDP 2222):');
    console.log('When high-speed cyclic I/O is running, raw buffers from io.on("data") are');
    console.log('automatically decoded into structured drive status objects:');

    // Simulate an incoming 4-byte raw buffer from Input Assembly 70:
    // Byte 0: status bits (Bit 0 = Faulted, Bit 2 = RunningFwd, Bit 3 = Ready)
    // Byte 2-3: Actual Speed (INT16 = 1750 RPM)
    const rawInputBuffer = Buffer.from([0x0C, 0x00, 0xD6, 0x06]); // Ready + RunningFwd, 1750 RPM

    const status = vfdProfile.customMethods.decodeInputAssembly(null, rawInputBuffer);
    console.log('\nRaw buffer received:', rawInputBuffer);
    console.log('Decoded structured status:', status);

    // Encode command buffer for Output Assembly 20:
    const command = {
        runFwd: true,
        faultReset: false,
        speedReference: 1800 // 1800 RPM
    };
    const rawOutputBuffer = vfdProfile.customMethods.encodeOutputAssembly(null, command);
    console.log('\nCommand object:', command);
    console.log('Encoded output buffer sent to drive:', rawOutputBuffer);

    console.log('\n=== Demo Completed Successfully ===');
}

if (require.main === module) {
    main().catch(console.error);
}
