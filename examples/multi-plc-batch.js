'use strict';

/**
 * Multi-PLC Heterogeneous Batch Demo
 *
 * Demonstrates controlling different PLC models simultaneously (e.g. Delta DVP-ES2-E
 * and Delta DVP-SX3) using the Universal Device architecture.
 *
 * Each PLC automatically uses its declarative DeviceProfile:
 *   - ES2: D registers resolve to Instance 1, Y bit registers resolve to Instance 1.
 *   - SX3: D registers resolve to Instance 2, Y bit registers resolve to Instance 1.
 * Both execute native CIP Multiple Service Packet (0x0A) batch requests concurrently.
 *
 * Usage: node examples/multi-plc-batch.js [host1] [host2]
 * Defaults: host1 = 192.168.68.111 (ES2), host2 = 192.168.68.250 (SX3)
 */

const { Device } = require('../src/device');

async function main() {
    const hostEs2 = process.argv[2] || '192.168.68.111';
    const hostSx3 = process.argv[3] || '192.168.68.250';

    console.log(`Initializing Multi-PLC Batch Controller...`);
    const plc1 = new Device(hostEs2, 'delta:es2');
    const plc2 = new Device(hostSx3, 'delta:sx3');

    console.log(`Connecting to PLC 1 (ES2-E at ${hostEs2})...`);
    await plc1.connect();
    console.log(`  Connected: ${plc1.profile.name}`);

    console.log(`Connecting to PLC 2 (SX3 at ${hostSx3})...`);
    await plc2.connect();
    console.log(`  Connected: ${plc2.profile.name}\n`);

    try {
        console.log('Running 5 cycles of synchronized multi-device LED sequence in batch mode:');

        const MIN_BIT = 0; // Y0
        const MAX_BIT = 5; // Y5

        for (let cycle = 1; cycle <= 5; cycle++) {
            for (let bit = MIN_BIT; bit <= MAX_BIT; bit++) {
                const startTime = Date.now();

                // Execute batch requests across both PLCs concurrently
                await Promise.all([
                    plc1.batch((b) => {
                        for (let i = MIN_BIT; i <= MAX_BIT; i++) {
                            b.writeYBit(i, i === bit);
                            b.writeD(i, i === bit ? 100 : 0);
                        }
                    }),
                    plc2.batch((b) => {
                        for (let i = MIN_BIT; i <= MAX_BIT; i++) {
                            b.writeYBit(i, i === bit);
                            b.writeD(i, i === bit ? 100 : 0);
                        }
                    })
                ]);

                const duration = Date.now() - startTime;
                console.log(`Cycle ${cycle}: Active LED Y${bit} | Both PLCs updated in ${duration}ms`);

                await new Promise((r) => setTimeout(r, 120));
            }
        }

        // Clean up: turn off LEDs
        console.log('\nTurning off all LEDs...');
        await Promise.all([
            plc1.batch((b) => {
                for (let i = MIN_BIT; i <= MAX_BIT; i++) {
                    b.writeYBit(i, false);
                    b.writeD(i, 0);
                }
            }),
            plc2.batch((b) => {
                for (let i = MIN_BIT; i <= MAX_BIT; i++) {
                    b.writeYBit(i, false);
                    b.writeD(i, 0);
                }
            })
        ]);

        console.log('All outputs cleared cleanly. Multi-PLC batch demo completed!');
    } finally {
        await Promise.all([plc1.close(), plc2.close()]);
    }
}

main().catch((err) => {
    console.error('Multi-PLC Demo Failed:', err);
    process.exit(1);
});
