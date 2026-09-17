'use strict';

/**
 * ODVA Standard EDS File Parser Demonstration (§43, §44, §45).
 *
 * Demonstrates:
 * 1. Ingesting an official vendor EDS file per ODVA CIP Vol 1 Ch 7.
 * 2. Extracting device identity metadata, assemblies, and connection profiles.
 * 3. Connecting to the target PLC (192.168.68.250).
 * 4. Verifying device identity matches the EDS specification.
 * 5. Automatically opening a Class 1 connection using parameters built by the EDS profile.
 * 6. Clean Forward_Close and session unregistration.
 *
 * Usage: node examples/eds-discovery.js [host] [edsPath]
 */

const path = require('path');
const { Scanner } = require('../src/scanner');
const { EdsFile } = require('../src/cip/eds');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const defaultEdsPath = path.join(__dirname, '..', 'eds', 'DELTA_IA-PLC_DVPES3-V01-08_EIP_EP_20240401', '031F000E0F0300010001.eds');
    const edsPath = process.argv[3] || defaultEdsPath;

    console.log(`Loading EDS file from: ${edsPath}`);
    const eds = EdsFile.fromFile(edsPath);

    console.log(`\n=== Parsed Device Specification ===`);
    console.log(`  Product Name:   ${eds.device.productName}`);
    console.log(`  Vendor ID:      0x${eds.device.vendorId.toString(16).padStart(4, '0')} (${eds.device.vendorName})`);
    console.log(`  Device Type:    0x${eds.device.deviceType.toString(16).padStart(4, '0')} (${eds.device.deviceTypeStr})`);
    console.log(`  Product Code:   0x${eds.device.productCode.toString(16).padStart(4, '0')} (${eds.device.productCode})`);
    console.log(`  Revision:       v${eds.device.revision}`);
    console.log(`  Assemblies:     ${eds.assemblies.size} defined`);
    console.log(`  Connections:    ${eds.connections.length} profiles defined`);

    const defaultConn = eds.getDefaultConnection();
    console.log(`\n=== Primary Connection Profile (${defaultConn.name}) ===`);
    console.log(`  Trigger:        ${defaultConn.triggerAndTransport.isCyclic ? 'Cyclic' : 'Other'}`);
    console.log(`  Default RPI:    ${defaultConn.toRpi.default / 1000} ms (Min: ${defaultConn.toRpi.min / 1000}ms, Max: ${defaultConn.toRpi.max / 1000}ms)`);
    console.log(`  Config Inst:    0x${defaultConn.parsedPath.configInstance.toString(16)}`);
    console.log(`  O->T Inst:      0x${defaultConn.parsedPath.o2tInstance.toString(16)} (Instance ${defaultConn.parsedPath.o2tInstance})`);
    console.log(`  T->O Inst:      0x${defaultConn.parsedPath.t2oInstance.toString(16)} (Instance ${defaultConn.parsedPath.t2oInstance})`);

    console.log(`\nConnecting to target PLC at ${host}...`);
    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`Session established.`);

    // Read identity from target
    const liveIdentity = await scanner.getIdentity();
    console.log(`\nLive Device Identity:`);
    console.log(`  Vendor ID:    0x${liveIdentity.vendorId.toString(16).padStart(4, '0')}`);
    console.log(`  Product Code: 0x${liveIdentity.productCode.toString(16).padStart(4, '0')}`);
    console.log(`  Product Name: "${liveIdentity.productName}"`);

    const isMatch = eds.matchesDevice(liveIdentity);
    console.log(`  Matches EDS?  ${isMatch ? 'YES (Verified)' : 'NO (Different device)'}`);

    console.log(`\nOpening Class 1 connection directly from EDS profile...`);
    const conn = await scanner.openConnectionFromEds(eds, 1, {
        otSize: 200,
        toSize: 200,
        rpiUs: 20000
    });

    console.log(`Connection opened successfully via EDS profile:`);
    console.log(`  O->T Connection ID: 0x${conn.otNetworkConnectionId.toString(16)}`);
    console.log(`  T->O Connection ID: 0x${conn.toNetworkConnectionId.toString(16)}`);
    console.log(`  T->O Actual API:    ${conn.toApiUs / 1000} ms`);

    console.log(`\nClosing connection via Forward_Close...`);
    await scanner.closeConnection(conn);
    console.log(`Connection closed successfully.`);

    await scanner.disconnect();
    console.log(`Session closed cleanly.`);
}

main().catch((err) => {
    console.error(`Error:`, err.message);
    process.exit(1);
});
