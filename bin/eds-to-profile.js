#!/usr/bin/env node
'use strict';

/**
 * CLI Tool: Convert ODVA Standard EDS File into DeviceProfile JavaScript Module
 *
 * Usage:
 *   node bin/eds-to-profile.js <path-to-eds> [options]
 *
 * Options:
 *   -o, --output <path>    Output .js file path (default: ./<model>-profile.js)
 *   --vendor <name>        Override vendor name
 *   --model <name>         Override model name
 *   --stdout               Print generated code to stdout instead of writing file
 *   -h, --help             Display help
 */

const fs = require('fs');
const path = require('path');
const { EdsFile } = require('../src/cip/eds');
const { generateProfileCodeFromEds, createProfileFromEds } = require('../src/device/eds-generator');

function printHelp() {
    console.log(`
CIP EDS to DeviceProfile Generator CLI
======================================

Usage:
  node bin/eds-to-profile.js <path-to-eds> [options]
  npx eip-profile-gen <path-to-eds> [options]

Options:
  -o, --output <path>    Target .js output path (default: ./<model-slug>-profile.js)
  --vendor <name>        Override vendor name
  --model <name>         Override model name
  --stdout               Print generated code to console
  -h, --help             Show this help screen

Examples:
  node bin/eds-to-profile.js eds/031F000E0F0600010001.eds -o src/vendors/delta/profiles/es3-sample.js
  node bin/eds-to-profile.js path/to/vfd-c2000.eds -o ./vfd-c2000.js --model "VFD-C2000"
`);
}

function parseArgs(args) {
    const opts = {
        input: null,
        output: null,
        vendor: null,
        model: null,
        stdout: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') {
            printHelp();
            process.exit(0);
        } else if (arg === '-o' || arg === '--output') {
            opts.output = args[++i];
        } else if (arg === '--vendor') {
            opts.vendor = args[++i];
        } else if (arg === '--model') {
            opts.model = args[++i];
        } else if (arg === '--stdout') {
            opts.stdout = true;
        } else if (!arg.startsWith('-') && !opts.input) {
            opts.input = arg;
        }
    }

    return opts;
}

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        printHelp();
        process.exit(1);
    }

    const opts = parseArgs(args);
    if (!opts.input) {
        console.error('Error: Please provide a path to an .eds file.');
        process.exit(1);
    }

    const edsPath = path.resolve(process.cwd(), opts.input);
    if (!fs.existsSync(edsPath)) {
        console.error(`Error: EDS file not found at "${edsPath}".`);
        process.exit(1);
    }

    console.log(`\nParsing EDS file: ${opts.input}...`);
    const eds = EdsFile.fromFile(edsPath);

    // Profile metadata inspection
    const vendor = opts.vendor || eds.device.vendorName || eds.device.vendName || `Vendor_${eds.device.vendorId || eds.device.vendCode || 'Unknown'}`;
    const model = opts.model || eds.device.productName || eds.device.prodName || `Model_${eds.device.productCode || eds.device.prodCode || 'Device'}`;
    const paramCount = eds.params.size;
    const assemCount = eds.assemblies.size;

    console.log(`Discovered Device:`);
    console.log(`  Vendor:      ${vendor}`);
    console.log(`  Model:       ${model}`);
    console.log(`  Parameters:  ${paramCount} items in [Params]`);
    console.log(`  Assemblies:  ${assemCount} instances in [Assembly]`);

    const code = generateProfileCodeFromEds(eds, {
        vendor: opts.vendor,
        model: opts.model
    });

    if (opts.stdout) {
        console.log('\n--- Generated DeviceProfile Code ---\n');
        console.log(code);
        return;
    }

    const safeName = model.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();
    const outputPath = opts.output
        ? path.resolve(process.cwd(), opts.output)
        : path.resolve(process.cwd(), `./${safeName}-profile.js`);

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(outputPath, code, 'utf8');
    console.log(`\nSuccessfully generated profile:`);
    console.log(`  -> ${outputPath}`);
    console.log(`\nYou can now import and use it in your code:`);
    console.log(`  const { Device } = require('@kufayeka/ethernet-ip');`);
    console.log(`  const { ${safeName}Profile } = require('${outputPath.replace(/\\/g, '/')}');`);
    console.log(`  const vfd = new Device('192.168.1.50', ${safeName}Profile);`);
    console.log(`  await vfd.readParam('01-00');\n`);
}

main();
