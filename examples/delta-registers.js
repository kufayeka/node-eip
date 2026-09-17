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

const { EIPSession } = require('../src/client');
const { readD, readX, readY, readM, readSR } = require('../src/delta/registers');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/delta-registers.js <host>');
        process.exit(1);
    }

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

    try {
        for (let n = 0; n < 5; n++) {
            console.log(`D${n} = ${await readD(session, n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`X${n} (word) = ${await readX(session, n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`Y${n} (word) = ${await readY(session, n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`M${n} = ${await readM(session, n)}`);
        }
        for (let n = 0; n < 3; n++) {
            console.log(`SR${n} = ${await readSR(session, n)}`);
        }
    } finally {
        await session.close();
        console.log('\nSession closed.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
