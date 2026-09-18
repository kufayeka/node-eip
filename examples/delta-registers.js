'use strict';

/**
 * Phase 2 smoke test: Modbus-like direct register access against a real
 * Delta AS300/AH-series-compatible PLC (SX3), using the vendor-specific
 * Register Objects from Delta's own EtherNet/IP Operation Manual
 * (docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf, Ch. 8.12) — no tag
 * database, no byte-offset config, just readD(session, 100) etc.
 *
 * Usage: node examples/delta-registers.js <host>
 */

const { Device } = require('../src/device');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/delta-registers.js <host>');
        process.exit(1);
    }

    const device = new Device(host, 'delta:sx3');
    await device.connect();
    console.log(`Device connected to ${host} using profile ${device.profile.name}`);

    try {
        for (let n = 0; n < 5; n++) {
            console.log(`D${n} = ${await device.readD(n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`X${n} (word) = ${await device.readX(n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`Y${n} (word) = ${await device.readY(n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`M${n} = ${await device.readM(n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`SR${n} = ${await device.readSR(n)}`);
        }
    } finally {
        await device.close();
        console.log('\nSession closed.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
