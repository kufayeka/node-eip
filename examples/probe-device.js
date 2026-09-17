'use strict';

/**
 * Phase 1 smoke test against a real device: TCP ListIdentity probe +
 * RegisterSession/UnRegisterSession handshake, vendor-neutral (no
 * Rockwell/Logix assumptions).
 *
 * Usage: node examples/probe-device.js <host> [port]
 */

const { probeTcp } = require('../src/encapsulation/discovery');
const { EIPSession } = require('../src/client');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const port = process.argv[3] ? Number(process.argv[3]) : undefined;

    console.log(`--- ListIdentity probe: ${host} ---`);
    const identity = await probeTcp(host, port ? { port } : undefined);
    console.log(JSON.stringify(identity, null, 2));

    console.log(`\n--- RegisterSession / UnRegisterSession handshake: ${host} ---`);
    const session = new EIPSession(host, port ? { port } : undefined);
    const registered = await session.connect();
    console.log(`Session registered: handle=0x${registered.sessionHandle.toString(16)}, protocolVersion=${registered.protocolVersion}`);
    await session.close();
    console.log('Session closed cleanly.');
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
