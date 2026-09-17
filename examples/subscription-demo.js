'use strict';

/**
 * Real-Time Tag Subscription & Watcher Demonstration
 *
 * Demonstrates:
 * 1. Mode: 'polling' (TCP 44818 via ODVA Multiple Service Packet 0x0A batch)
 * 2. Mode: 'udp' / 'realtime' (Class 1 Implicit I/O on UDP port 2222 with per-register buffer slicing)
 * 3. Event listeners:
 *    - 'change' (by-exception when any tag changes)
 *    - 'change:<tag>' (tag-targeted event)
 *    - 'cyclic' (emitted on every tick/datagram)
 *
 * Usage:
 *   node examples/subscription-demo.js [host] [polling|udp] [durationSeconds]
 *
 * Examples:
 *   node examples/subscription-demo.js 192.168.68.250 polling 5
 *   node examples/subscription-demo.js 192.168.68.250 udp 5
 */

const { DeltaDevice } = require('../src/delta/device');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const mode = (process.argv[3] || 'polling').toLowerCase();
    const duration = Number(process.argv[4] || 5);

    console.log(`=======================================================`);
    console.log(`Real-Time Tag Watcher / Subscription Demo`);
    console.log(`Target Host: ${host}`);
    console.log(`Mode:        ${mode.toUpperCase()} (${mode === 'udp' ? 'UDP port 2222 Class 1 I/O' : 'TCP port 44818 Explicit Multiple Service'})`);
    console.log(`Duration:    ${duration}s`);
    console.log(`=======================================================\n`);

    const plc = new DeltaDevice(host, 'sx3');
    console.log(`Connecting to Delta DVP-SX3 at ${host}...`);
    await plc.connect();
    console.log(`Connected successfully!\n`);

    // Define tags to watch
    const tagsToWatch = ['D0', 'D1', 'D10', 'Y0'];
    console.log(`Subscribing to registers: ${JSON.stringify(tagsToWatch)}`);

    const sub = plc.createSubscription({
        mode,
        interval: 100, // 100ms for polling
        rpiMs: 20,     // 20ms RPI for UDP
        tags: tagsToWatch
    });

    let changeCount = 0;
    let cyclicCount = 0;

    // 1. Global change listener (fires only on value change)
    sub.on('change', (tag, newVal, oldVal) => {
        changeCount++;
        console.log(`🔔 [CHANGE #${changeCount}] Tag ${tag} changed: ${oldVal} -> ${newVal}`);
    });

    // 2. Specific tag change listener
    sub.on('change:D0', (newVal, oldVal) => {
        console.log(`   🎯 [TAG: D0] Specific listener: was ${oldVal}, now ${newVal}`);
    });

    // 3. Cyclic listener (fires every cycle / tick)
    sub.on('cyclic', (snapshot) => {
        cyclicCount++;
        if (cyclicCount === 1 || cyclicCount % (mode === 'udp' ? 25 : 10) === 0) {
            console.log(`⏱️ [CYCLIC #${cyclicCount}] Current Values:`, JSON.stringify(snapshot));
        }
    });

    sub.on('error', (err) => {
        console.error(`❌ [SUB ERROR]:`, err.message);
    });

    console.log(`Starting watcher engine...`);
    await sub.start();

    // In polling mode, write a small test change to D0 after 1.5s to see the change event fire!
    if (mode === 'polling') {
        setTimeout(async () => {
            try {
                const currentD0 = sub.getValue('D0') || 0;
                const nextD0 = (currentD0 + 1) % 1000;
                console.log(`\n✏️ [DEMO] Writing D0 = ${nextD0} to trigger Change of State...`);
                await plc.writeD(0, nextD0);
            } catch (err) {
                console.error(`Write test error:`, err.message);
            }
        }, 1500);
    }

    await new Promise((r) => setTimeout(r, duration * 1000));

    console.log(`\nStopping watcher engine...`);
    await sub.stop();

    console.log(`\nSession Snapshot:`);
    console.log(`  Final Cached Values:`, JSON.stringify(sub.getValues(), null, 2));
    console.log(`  Total Changes Detected: ${changeCount}`);
    console.log(`  Total Cyclic Frames:    ${cyclicCount}`);

    await plc.disconnect();
    console.log(`Disconnected cleanly.\n`);
}

main().catch((err) => {
    console.error(`Fatal error:`, err.message);
    process.exit(1);
});
