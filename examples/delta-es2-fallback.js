'use strict';

/**
 * Demonstrates the Assembly-window fallback (src/delta/assembly-window.js,
 * src/delta/es2-fallback-profile.js) for Delta devices that don't
 * implement the vendor-specific Register Objects from registers.js —
 * confirmed against a real DVP32ES2-E. Read-only: Instance 101's write was
 * confirmed rejected (ServiceNotSupported), so only readD() exists here so
 * far — see README Domain J for the unconfirmed write-side investigation.
 *
 * Usage: node examples/delta-es2-fallback.js <host> [count]
 */

const { EIPSession } = require('../src/client');
const { readD } = require('../src/delta/es2-fallback-profile');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/delta-es2-fallback.js <host> [count]');
        process.exit(1);
    }
    const count = process.argv[3] ? Number(process.argv[3]) : 10;

    const session = new EIPSession(host);
    await session.connect();
    try {
        for (let n = 0; n < count; n++) {
            console.log(`D${n} = ${await readD(session, n)}`);
        }
    } finally {
        await session.close();
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
