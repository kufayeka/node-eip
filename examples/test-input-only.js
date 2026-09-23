'use strict';

/**
 * ODVA EtherNet/IP Input-Only Demonstration & Test
 *
 * Apa itu Input-Only Connection menurut ODVA CIP:
 * -------------------------------------------------------------
 * 1. Input-Only adalah koneksi Class 1 I/O di mana Scanner HANYA membaca input (T->O)
 *    dan TIDAK mengontrol output fisik (O->T hanya mengirim Run/Idle Heartbeat, ukuran data 0 bytes).
 * 2. BERBEDA dengan Listen-Only:
 *    - Listen-Only: Bersifat pasif dan WAJIB bergantung pada Owner yang sedang aktif.
 *                   Jika tidak ada Owner, Target menolak koneksi.
 *    - Input-Only : Merupakan "Owner" atas produksi input (Input Production Owner).
 *                   Dapat berdiri sendiri (standalone) TANPA perlu ada Exclusive Owner yang mengontrol output!
 * 3. T->O Connection Type pada Input-Only bisa berupa:
 *    - Point-to-Point (Unicast langsung ke IP scanner)
 *    - Multicast (ke IP multicast grup)
 *
 * Script ini menguji apakah target PLC (Delta SX3) mendukung koneksi Input-Only mandiri:
 * - O->T: Heartbeat Instance (199 / 0xC7), Point-to-Point
 * - T->O: Input Assembly (101 / 0x65), Point-to-Point / Unicast (size 200 bytes)
 *
 * Usage: node examples/test-input-only.js [host] [durationSeconds]
 */

const { Scanner } = require('../src/scanner');
const { ConnectionType } = require('../src/cip/connection-manager');
const { encodeListenOnlyConnectionPath } = require('../src/cip/path');

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const durationSeconds = process.argv[3] ? Number(process.argv[3]) : 3;

    console.log(`================================================================`);
    console.log(`  ODVA EIP INPUT-ONLY TEST (Target: ${host})`);
    console.log(`================================================================\n`);

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`[1] TCP Session Connected ke ${host}. Session Handle: 0x${scanner.session.sessionHandle.toString(16)}`);

    // Path CIP untuk Input-Only / Listen-Only:
    // Config: 128 (0x80), Heartbeat: 199 (0xC7), Input: 101 (0x65)
    const connectionPath = encodeListenOnlyConnectionPath({
        configInstance: 0x80,
        heartbeatInstance: 0xC7,
        t2oInstance: 0x65
    });

    console.log(`[2] Menguji pembukaan koneksi INPUT-ONLY (Standalone - Tanpa Owner)...`);
    console.log(`    - O->T: Heartbeat 199 (4 Bytes Run/Idle Header, Point-to-Point)`);
    console.log(`    - T->O: Input 101 (200 Bytes Data, Point-to-Point / Unicast)`);

    let conn;
    try {
        conn = await scanner.openConnection({
            connectionPath,
            rpiUs: 20000,
            otSize: 4, // 32-bit Run/Idle header
            toSize: 200,
            otConnectionType: ConnectionType.PointToPoint,
            toConnectionType: ConnectionType.PointToPoint
        });
        console.log(`\n[SUCCESS] PLC Menerima Standalone Input-Only Connection!`);
        console.log(`    O->T Connection ID : 0x${conn.otNetworkConnectionId.toString(16)}`);
        console.log(`    T->O Connection ID : 0x${conn.toNetworkConnectionId.toString(16)}`);
        console.log(`    Actual T->O API    : ${conn.toApiUs / 1000} ms`);

        const io = scanner.createIoConnection(conn, {
            rpiMs: 20,
            useRunIdleHeader: true
        });

        let rxCount = 0;
        io.on('data', (data, meta) => {
            rxCount++;
            if (rxCount === 1 || rxCount % 20 === 0) {
                console.log(`  [INPUT-ONLY RX #${rxCount}] Seq: ${meta.sequenceNumber}, Len: ${data.length}B, First 4B: ${data.slice(0, 4).toString('hex')}`);
            }
        });

        await io.start();
        console.log(`    I/O Engine berjalan menerima input stream selama ${durationSeconds} detik...`);
        await new Promise((r) => setTimeout(r, durationSeconds * 1000));

        await io.stop();
        await scanner.closeConnection(conn);
        console.log(`\n[INFO] Total paket input diterima: ${rxCount}`);
    } catch (err) {
        console.log(`\n[INFO HASIL TES DARI PLC]:`);
        console.log(`    Pesan error: ${err.message}`);
        console.log(`\n[ANALISIS RESPON HARDWARE]:`);
        if (err.message.includes('0x127') || err.message.includes('0x106') || err.message.includes('0x1')) {
            console.log(`    -> PLC Delta SX3 menolak koneksi karena instance Heartbeat 199 pada firmware SX3`);
            console.log(`       didefinisikan secara khusus sebagai 'Connection1_Listen only' (Connection 9 di EDS).`);
            console.log(`    -> Menurut firmware Delta SX3: Assembly 199 TIDAK diizinkan berjalan mandiri (Input-Only),`);
            console.log(`       melainkan HANYA bisa berjalan sebagai Listen-Only (wajib ada Owner aktif lebih dulu).`);
            console.log(`    -> Hal ini sesuai dengan EDS resmi Delta SX3 (031F000E0F0600010001.eds), di mana`);
            console.log(`       hanya ada koneksi: Exclusive Owner (Conn 1-8) dan Listen-Only (Conn 9-16).`);
        }
    }

    await scanner.disconnect();
    console.log(`\nSession closed cleanly.`);
}

main().catch((err) => {
    console.error(`Error:`, err.message);
    process.exit(1);
});
