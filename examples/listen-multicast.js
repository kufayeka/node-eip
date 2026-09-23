'use strict';

/**
 * Delta DVP-SX3 EtherNet/IP Multicast 20ms Stream Listener & Tag Monitor
 *
 * Mendengarkan paket Multicast UDP (RPI 20ms = 50 packets/sec) dari PLC Delta SX3
 * di IP Multicast ODVA (misal 239.192.32.32:2222).
 *
 * Menampilkan:
 * 1. Delta waktu antar paket (Δt ≈ 20ms) & Kecepatan Streaming (Hz)
 * 2. Tag Values dari delta-produced-tag.CSV:
 *    - Var_1 (D0 - DINT 32-bit): Offset 0..3
 *    - Var_2 (D2 - DINT 32-bit): Offset 4..7
 *    - D0, D1, D2, D3, D4, D5 (INT 16-bit)
 *
 * Usage:
 *   node examples/listen-multicast.js [host] [durationSeconds] [--listen-only]
 * Contoh:
 *   node examples/listen-multicast.js 192.168.68.250 10
 */

const { Scanner } = require('../src/scanner');
const { ConnectionType } = require('../src/cip/connection-manager');
const { encodeAssemblyConnectionPath, encodeListenOnlyConnectionPath } = require('../src/cip/path');

async function run() {
    const args = process.argv.slice(2);
    const host = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || '192.168.68.250';
    const durationArg = args.find((a) => /^\d+$/.test(a));
    const durationSeconds = durationArg ? parseInt(durationArg, 10) : 10;
    const isListenOnly = args.includes('--listen-only');

    console.log(`========================================================================`);
    console.log(`  ETHERNET/IP MULTICAST 20ms RPI STREAM LISTENER`);
    console.log(`  Target PLC : ${host}`);
    console.log(`  Mode       : ${isListenOnly ? 'LISTEN-ONLY FOLLOWER' : 'MULTICAST OWNER & LISTENER'}`);
    console.log(`  Durasi     : ${durationSeconds > 0 ? durationSeconds + ' detik' : 'Kontinu (Tekan Ctrl+C untuk stop)'}`);
    console.log(`========================================================================\n`);

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`[1] Terhubung ke PLC TCP 44818. Session: 0x${scanner.session.sessionHandle.toString(16)}`);

    const multicastIp = await scanner.resolveMulticastAddress();
    console.log(`[2] Resolved ODVA CIP Multicast Group: ${multicastIp}`);

    let conn;
    let io;

    if (isListenOnly) {
        console.log(`[3] Membuka Listen-Only Connection (Heartbeat 199 -> Input 101)...`);
        const path = encodeListenOnlyConnectionPath({
            configInstance: 0x80,
            heartbeatInstance: 0xC7,
            t2oInstance: 0x65
        });

        conn = await scanner.openConnection({
            connectionPath: path,
            rpiUs: 20000,
            otSize: 4,
            toSize: 200,
            toConnectionType: ConnectionType.Multicast,
            multicast: true,
            multicastAddress: multicastIp
        });

        io = scanner.createIoConnection(conn, {
            rpiMs: 20,
            useRunIdleHeader: true
        });
    } else {
        console.log(`[3] Membuka Multicast Owner Connection (Assembly 100 -> 101, RPI 20ms)...`);
        const path = encodeAssemblyConnectionPath({
            configInstance: 0x80,
            o2tInstance: 0x64,
            t2oInstance: 0x65
        });

        conn = await scanner.openConnection({
            connectionPath: path,
            rpiUs: 20000,
            otSize: 200,
            toSize: 200,
            toConnectionType: ConnectionType.Multicast,
            multicast: true,
            multicastAddress: multicastIp
        });

        io = scanner.createIoConnection(conn, {
            rpiMs: 20,
            initialOutputData: Buffer.alloc(200)
        });
    }

    console.log(`    [OK] Connection Established!`);
    console.log(`    -> O->T Network Conn ID : 0x${conn.otNetworkConnectionId.toString(16)}`);
    console.log(`    -> T->O Network Conn ID : 0x${conn.toNetworkConnectionId.toString(16)}`);
    console.log(`    -> Multicast Address    : ${conn.multicastAddress}:2222\n`);

    let packetCount = 0;
    let lastTime = 0;
    let rollingDeltas = [];

    // Header tabel
    console.log(`[STREAMING MULTICAST PACKETS LIVE (RPI: 20ms)]`);
    console.log(`+---------+---------+----------+--------------------+--------------------+-------------------------------+`);
    console.log(`| PKT #   | SEQ NO  | Δt (ms)  | Var_1 [D0] (DINT)  | Var_2 [D2] (DINT)  | D0, D1, D2, D3, D4, D5 (INT)  |`);
    console.log(`+---------+---------+----------+--------------------+--------------------+-------------------------------+`);

    io.on('data', (payload, meta) => {
        packetCount++;
        const now = Date.now();
        const delta = lastTime > 0 ? now - lastTime : 20;
        lastTime = now;
        rollingDeltas.push(delta);
        if (rollingDeltas.length > 20) rollingDeltas.shift();

        // Decode tags
        // Var_1 = D0 (DINT 32-bit: offset 0..3)
        // Var_2 = D2 (DINT 32-bit: offset 4..7)
        const var1 = payload.length >= 4 ? payload.readInt32LE(0) : 0;
        const var2 = payload.length >= 8 ? payload.readInt32LE(4) : 0;

        // D0..D5 (INT 16-bit)
        const d0 = payload.length >= 2 ? payload.readInt16LE(0) : 0;
        const d1 = payload.length >= 4 ? payload.readInt16LE(2) : 0;
        const d2 = payload.length >= 6 ? payload.readInt16LE(4) : 0;
        const d3 = payload.length >= 8 ? payload.readInt16LE(6) : 0;
        const d4 = payload.length >= 10 ? payload.readInt16LE(8) : 0;
        const d5 = payload.length >= 12 ? payload.readInt16LE(10) : 0;

        // Print setiap paket pertama, lalu setiap 5 paket (~100ms) agar terminal tidak freeze tapi tetap sangat responsif
        if (packetCount === 1 || packetCount % 5 === 0) {
            const pNum = String(packetCount).padStart(7, ' ');
            const seq = String(meta.sequenceNumber).padStart(7, ' ');
            const dt = `${delta}ms`.padStart(8, ' ');
            const v1 = String(var1).padStart(18, ' ');
            const v2 = String(var2).padStart(18, ' ');
            const dWords = `[${d0}, ${d1}, ${d2}, ${d3}, ${d4}, ${d5}]`.padEnd(29, ' ');

            console.log(`| ${pNum} | ${seq} | ${dt} | ${v1} | ${v2} | ${dWords} |`);
        }
    });

    // Cleanup hook
    let isCleaningUp = false;
    async function cleanup() {
        if (isCleaningUp) return;
        isCleaningUp = true;
        console.log(`\n\n[-] Menghentikan Multicast Listener...`);
        try {
            await io.stop();
        } catch (_) {}
        try {
            await scanner.closeConnection(conn);
        } catch (_) {}
        try {
            await scanner.disconnect();
        } catch (_) {}

        const avgDelta = rollingDeltas.length > 0 ? (rollingDeltas.reduce((a, b) => a + b, 0) / rollingDeltas.length).toFixed(1) : 20;
        console.log(`\n========================================================================`);
        console.log(`  STATISTIK MULTICAST STREAM:`);
        console.log(`    Total Multicast Packet Diterima : ${packetCount} paket`);
        console.log(`    Rata-rata Interval Kedatangan   : ${avgDelta} ms (Target RPI: 20 ms)`);
        console.log(`    Estimasi Streaming Rate         : ~${(1000 / avgDelta).toFixed(1)} packets/second (~50 Hz)`);
        console.log(`========================================================================`);
        process.exit(0);
    }

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    await io.start();

    if (durationSeconds > 0) {
        setTimeout(cleanup, durationSeconds * 1000);
    }
}

run().catch((err) => {
    console.error(`\n[FATAL ERROR]:`, err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
