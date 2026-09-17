'use strict';

/**
 * Session Robustness, State Machine, Keepalive & Auto-Reconnect Example (§2.2, §38).
 *
 * Demonstrates:
 * 1. Session State Machine (DISCONNECTED -> CONNECTING -> REGISTERED -> DESTROYED).
 * 2. Connection Liveness Ping (lightweight CIP Identity probe).
 * 3. Encapsulation NOP (0x0000) keepalive.
 * 4. Auto-Reconnect Engine resilience configuration.
 *
 * Defaults to live Delta PLC at 192.168.68.250.
 */

const { Scanner } = require('../src/scanner');

const host = process.argv[2] || '192.168.68.250';
const port = parseInt(process.argv[3], 10) || 44818;

async function main() {
    console.log(`=== ODVA Session Robustness & Lifecycle with ${host}:${port} ===\n`);

    const scanner = new Scanner(host, {
        port,
        autoReconnect: true,
        reconnectDelayMs: 1000,
        maxReconnectAttempts: 5,
        heartbeatIntervalMs: 5000 // periodic keepalive probe every 5 seconds
    });

    console.log(`Initial State: ${scanner.state} (connected: ${scanner.connected})`);

    // Track lifecycle events
    scanner.session.on('stateChange', ({ oldState, newState }) => {
        console.log(`[Event] Session state changed: ${oldState} -> ${newState}`);
    });
    scanner.session.on('reconnecting', ({ attempt, maxAttempts, delay }) => {
        console.log(`[Event] Auto-reconnecting attempt ${attempt}/${maxAttempts} in ${delay}ms...`);
    });

    console.log('\n[1] Connecting to device...');
    await scanner.connect();
    console.log(`Connected! Current State: ${scanner.state} (handle: 0x${scanner.session.sessionHandle.toString(16)})`);

    console.log('\n[2] Testing liveness ping (fast CIP Identity probe)...');
    const t0 = Date.now();
    const pingOk = await scanner.ping();
    console.log(`Ping resolved in ${Date.now() - t0}ms: ${pingOk ? 'SUCCESS (Alive)' : 'FAILED'}`);

    console.log('\n[3] Reading device Identity attribute during active session...');
    const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
    console.log(`Vendor ID read back: ${vendorId.readUInt16LE(0)}`);

    console.log('\n[4] Gracefully closing session...');
    await scanner.disconnect();
    console.log(`Final State: ${scanner.state} (connected: ${scanner.connected})`);
    console.log('\nSession lifecycle demonstration complete.');
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
