'use strict';

/**
 * Prints an EDS file's [Assembly] and [Connection Manager] contents — a
 * starting point when defining a new device-type profile
 * (src/delta/device-types/) for a PLC we don't have a profile for yet.
 * Does not auto-generate a profile; confirm live before trusting anything
 * printed here (README Domain J).
 *
 * Usage: node examples/inspect-eds.js <path-to-eds-file>
 */

const { EdsFile } = require('../src/cip/eds');

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: node examples/inspect-eds.js <path-to-eds-file>');
    process.exit(1);
}

const eds = EdsFile.fromFile(filePath);

console.log('Assemblies:');
for (const a of eds.assemblies) {
    console.log(`  Assem${a.id}: "${a.name}" — ${a.size} bytes`);
}

console.log('\nConnections:');
for (const c of eds.connections) {
    console.log(`  Connection${c.id}: "${c.name}" — type=${c.trigger}`);
}

