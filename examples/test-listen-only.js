'use strict';

/**
 * ODVA EtherNet/IP Listen-Only Demonstration
 *
 * Skenario ODVA Multicast + Listen-Only:
 * 1. Owner Client (Scanner 1) membuka koneksi Multicast Owner (Connection 1: Assembly 100 -> 101).
 *    Delta SX3 mulai memproduksi data T->O ke Multicast IP (e.g. 239.192.32.32:2222).
 * 2. Listen-Only Client (Scanner 2) membuka koneksi Listen-Only (Connection 9: Heartbeat 199 -> Input 101).
 *    Karena sudah ada Owner aktif, Delta SX3 mengizinkan Scanner 2 bergabung ke multicast group yang sama.
 * 3. KEDUA scanner mendengarkan port UDP 2222 secara bersamaan tanpa conflict 0x0106!
 *
 * Usage: node examples/test-listen-only.js [host] [durationSeconds]
 */

const { Scanner } = require('../src/scanner');
const { ConnectionType } = require('../src/cip/connection-manager');
const { encodeAssemblyConnectionPath, encodeListenOnlyConnectionPath } = require('../src/cip/path');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const durationSeconds = process.argv[3] ? Number(process.argv[3]) : 3;

    console.log(`================================================================`);
    console.log(`  ODVA EIP LISTEN-ONLY TEST (Target: ${host})`);
    console.log(`================================================================\n`);

    // -------------------------------------------------------------
    // LANGKAH 1: Inisialisasi Scanner 1 (MULTICAST OWNER)
    // -------------------------------------------------------------
    console.log(`[1] Menghubungkan SCANNER 1 (MULTICAST OWNER)...`);
    const ownerScanner = new Scanner(host);
    await ownerScanner.connect();
    console.log(`    Scanner 1 TCP Connected. Session Handle: 0x${ownerScanner.session.sessionHandle.toString(16)}`);

    // Resolusi IP Multicast (standar ODVA: 239.192.x.x)
    const multicastIp = await ownerScanner.resolveMulticastAddress();
    console.log(`    Resolved CIP Multicast IP: ${multicastIp}`);

    // Buka koneksi Multicast Owner
    // O->T = 100 (200 bytes), T->O = 101 (200 bytes, Multicast)
    console.log(`    Mengirim Forward_Open untuk Multicast Owner...`);
    const ownerPath = encodeAssemblyConnectionPath({
        configInstance: 0x80,
        o2tInstance: 0x64,
        t2oInstance: 0x65
    });

    const ownerConn = await ownerScanner.openConnection({
        connectionPath: ownerPath,
        rpiUs: 20000,
        otSize: 200,
        toSize: 200,
        toConnectionType: ConnectionType.Multicast,
        multicast: true,
        multicastAddress: multicastIp
    });

    console.log(`    [SUCCESS] Owner Connection Terbuka!`);
    console.log(`      O->T Conn ID : 0x${ownerConn.otNetworkConnectionId.toString(16)}`);
    console.log(`      T->O Conn ID : 0x${ownerConn.toNetworkConnectionId.toString(16)}`);
    console.log(`      Multicast IP : ${ownerConn.multicastAddress}`);

    // Start I/O Engine untuk Owner
    const ownerIo = ownerScanner.createIoConnection(ownerConn, {
        rpiMs: 20,
        initialOutputData: Buffer.alloc(200)
    });

    let ownerRxCount = 0;
    ownerIo.on('data', (data, meta) => {
        ownerRxCount++;
        if (ownerRxCount === 1 || ownerRxCount % 20 === 0) {
            console.log(`  [OWNER RX #${ownerRxCount}] Seq: ${meta.sequenceNumber}, Len: ${data.length}B, Hex: ${data.slice(0, 4).toString('hex')}`);
        }
    });

    await ownerIo.start();
    console.log(`    Owner I/O Engine aktif mengirim output & menerima input.\n`);

    // Tunggu 500ms agar multicast stream dari PLC sudah stabil
    await new Promise((r) => setTimeout(r, 500));

    // -------------------------------------------------------------
    // LANGKAH 2: Inisialisasi Scanner 2 (LISTEN-ONLY FOLLOWER)
    // -------------------------------------------------------------
    console.log(`[2] Menghubungkan SCANNER 2 (LISTEN-ONLY FOLLOWER)...`);
    const listenScanner = new Scanner(host);
    await listenScanner.connect();
    console.log(`    Scanner 2 TCP Connected. Session Handle: 0x${listenScanner.session.sessionHandle.toString(16)}`);

    // Sesuai EDS Delta SX3 Connection 9 (Connection1_Listen only):
    // Config: 128 (0x80), Heartbeat: 199 (0xC7), Input: 101 (0x65)
    // O->T Size = 0 (Heartbeat saja), T->O Size = 200 (Multicast)
    console.log(`    Mengirim Forward_Open untuk Listen-Only (Heartbeat 199 -> Input 101)...`);
    const listenPath = encodeListenOnlyConnectionPath({
        configInstance: 0x80,
        heartbeatInstance: 0xC7,
        t2oInstance: 0x65
    });

    const listenConn = await listenScanner.openConnection({
        connectionPath: listenPath,
        rpiUs: 20000,
        otSize: 4, // Delta SX3 Heartbeat (199) requires 4 bytes for 32-bit Run/Idle header
        toSize: 200,
        toConnectionType: ConnectionType.Multicast,
        multicast: true,
        multicastAddress: multicastIp
    });

    console.log(`    [SUCCESS] Listen-Only Connection Terbuka!`);
    console.log(`      O->T Conn ID : 0x${listenConn.otNetworkConnectionId.toString(16)}`);
    console.log(`      T->O Conn ID : 0x${listenConn.toNetworkConnectionId.toString(16)}`);
    console.log(`      Multicast IP : ${listenConn.multicastAddress}`);

    // Start I/O Engine untuk Listen-Only
    const listenIo = listenScanner.createIoConnection(listenConn, {
        rpiMs: 20,
        useRunIdleHeader: true
    });

    let listenRxCount = 0;
    listenIo.on('data', (data, meta) => {
        listenRxCount++;
        if (listenRxCount === 1 || listenRxCount % 20 === 0) {
            console.log(`    >>> [LISTEN-ONLY RX #${listenRxCount}] Seq: ${meta.sequenceNumber}, Len: ${data.length}B, Hex: ${data.slice(0, 4).toString('hex')}`);
        }
    });

    await listenIo.start();
    console.log(`    Listen-Only I/O Engine aktif bergabung ke multicast stream.\n`);

    // -------------------------------------------------------------
    // LANGKAH 3: Jalankan Bersamaan Selama durasi yang ditentukan
    // -------------------------------------------------------------
    console.log(`[3] Menjalankan Owner dan Listen-Only bersamaan selama ${durationSeconds} detik...`);
    await new Promise((r) => setTimeout(r, durationSeconds * 1000));

    // -------------------------------------------------------------
    // LANGKAH 4: Stop & Cleanup Bersih
    // -------------------------------------------------------------
    console.log(`\n[4] Tearing down connections...`);

    console.log(`    Menghentikan Listen-Only...`);
    await listenIo.stop();
    try {
        await listenScanner.closeConnection(listenConn);
    } catch {
        // Delta SX3 manages listen-only passively and may return 0x0107 on close
    }
    await listenScanner.disconnect();
    console.log(`    Listen-Only disconnected.`);

    console.log(`    Menghentikan Owner...`);
    await ownerIo.stop();
    await ownerScanner.closeConnection(ownerConn);
    await ownerScanner.disconnect();
    console.log(`    Owner disconnected.`);

    console.log(`\n================================================================`);
    console.log(`  HASIL AKHIR:`);
    console.log(`    Owner RX Packets       : ${ownerRxCount}`);
    console.log(`    Listen-Only RX Packets : ${listenRxCount}`);
    console.log(`================================================================`);
}

main().catch((err) => {
    console.error(`\n[ERROR]:`, err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
