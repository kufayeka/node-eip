'use strict';

/**
 * Example: Building a Custom EtherNet/IP Virtual Device & Generating EDS
 *
 * Demonstrates:
 * 1. Declaratively defining a custom EtherNet/IP device (Identity, Parameters, Tags, Assemblies).
 * 2. Exporting an official, ODVA-compliant Electronic Data Sheet (.eds) for SCADA/MES import.
 * 3. Starting a live EtherNet/IP server (TCP 44818) right from the builder.
 * 4. Interacting with the virtual device using standard Device and Scanner clients.
 */

const fs = require('fs');
const path = require('path');
const { DeviceBuilder } = require('../src/device/builder');
const { Device } = require('../src/device/device');
const { Scanner } = require('../src/scanner');

async function main() {
    console.log('=== Kufayeka EtherNet/IP Device Builder & EDS Generator ===\n');

    // [1] Construct the Virtual Device
    console.log('[1] Building Virtual Device: "Kufayeka MES Gateway & Storage"...');
    const builder = new DeviceBuilder({
        vendorId: 0x1337,
        vendorName: 'Kufayeka Automation',
        productCode: 100,
        productName: 'MES Edge Gateway',
        deviceType: 'Generic Device',
        description: 'Multi-purpose EtherNet/IP Virtual Node for SCADA & MES'
    });

    // Add Inverter / Machine Parameters (CIP Class 0x0F Parameter Object)
    builder.addParam({
        code: '01-00',
        name: 'TargetMixerSpeed',
        dataType: 'REAL',
        units: 'RPM',
        min: 0,
        max: 3000,
        default: 1200.0,
        access: 'rw',
        help: 'Target mixer speed in RPM'
    });

    builder.addParam({
        code: '01-01',
        name: 'ActualChamberTemp',
        dataType: 'REAL',
        units: '°C',
        min: -50,
        max: 200,
        default: 24.5,
        access: 'r', // Read-only sensor
        help: 'Current chamber temperature'
    });

    builder.addParam({
        code: '02-00',
        name: 'MotorRatedPower',
        dataType: 'UDINT',
        units: 'W',
        min: 100,
        max: 500000,
        default: 7500,
        access: 'rw',
        linkPath: '20 28 24 01 30 01' // Link path to Motor Data Object
    });

    // Add ControlLogix-style Symbolic Tags (Key-Value buffer for MES / SCADA)
    builder.addTag('LotNumber', 'STRING', 'LOT-2026-ALPHA');
    builder.addTag('TotalProduced', 'DINT', 500);
    builder.addTag('MachineState', 'INT', 1); // 1 = Running

    // Add Class 1 Cyclic I/O Assemblies (UDP 2222)
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

    // [2] Generate and Save Official ODVA EDS File
    console.log('\n[2] Generating ODVA EDS File...');
    const edsText = builder.generateEds();
    const edsPath = path.join(__dirname, 'Kufayeka_MES_Gateway.eds');
    fs.writeFileSync(edsPath, edsText, 'utf8');
    console.log(`EDS File saved successfully to: ${edsPath}`);
    console.log('Sample EDS excerpt:');
    console.log(edsText.split('\n').slice(0, 28).join('\n'));

    // [3] Start the Live EtherNet/IP Server
    console.log('\n[3] Starting Live EtherNet/IP Server on port 44818 (localhost)...');
    const TEST_PORT = 44818;
    const adapter = builder.createAdapter({
        port: TEST_PORT,
        address: '127.0.0.1'
    });

    // Hook change events on server
    builder.on('paramChange', (code, newVal, oldVal) => {
        console.log(`  -> [SERVER EVENT] Param ${code} changed: ${oldVal} -> ${newVal}`);
    });
    builder.on('tagChange', (name, newVal, oldVal) => {
        console.log(`  -> [SERVER EVENT] Tag ${name} changed: ${oldVal} -> ${newVal}`);
    });

    await adapter.start();
    console.log('Server is running and listening on TCP 44818 and UDP 44818/2222.');

    // [4] Client Interaction (Testing SCADA/PLC Connection)
    console.log('\n[4] Connecting Client Device to Virtual Server...');
    const clientProfile = builder.toProfile();
    const client = new Device('127.0.0.1', clientProfile, { port: TEST_PORT });
    await client.connect();

    // Probe Identity
    const identity = await Scanner.probe('127.0.0.1', { port: TEST_PORT });
    console.log('Discovered Device Identity:', {
        vendorName: identity.productName,
        vendorId: identity.vendorId,
        productCode: identity.productCode
    });

    // Read and Write Parameters
    console.log('\nReading initial parameters:');
    console.log('  Target Speed (01-00):', await client.readParam('01-00'), 'RPM');
    console.log('  Chamber Temp (01-01):', await client.readParam('01-01'), '°C');

    console.log('\nWriting new parameter values from client:');
    await client.writeParam('01-00', 1750.5);
    console.log('  Target Speed (01-00) updated to:', await client.readParam('01-00'), 'RPM');

    // Read and Write Symbolic Tags
    console.log('\nReading symbolic tags (MES buffer):');
    const lot = await client.scanner.readTag('LotNumber', { dataType: 'STRING' });
    const count = await client.scanner.readTag('TotalProduced', { dataType: 'DINT' });
    console.log('  LotNumber:', lot.value);
    console.log('  TotalProduced:', count.value);

    console.log('\nUpdating symbolic tags:');
    await client.scanner.writeTag('TotalProduced', 501);
    const updatedCount = await client.scanner.readTag('TotalProduced', { dataType: 'DINT' });
    console.log('  TotalProduced updated to:', updatedCount.value);

    // Batch Read / Write
    console.log('\nExecuting CIP Multiple Service Packet batch:');
    const batchResults = await client.batch(b => {
        b.writeParam('01-00', 2000.0);
        b.readParam('01-00');
        b.readParam('01-01');
    });
    console.log('Batch results:', {
        writeSuccess: batchResults[0],
        newSpeed: batchResults[1],
        temp: batchResults[2]
    });

    // Clean up
    console.log('\nStopping client and server...');
    await client.disconnect();
    await adapter.stop();
    if (fs.existsSync(edsPath)) fs.unlinkSync(edsPath);

    console.log('=== Virtual Device Demo Completed Successfully ===');
}

if (require.main === module) {
    main().catch(console.error);
}
