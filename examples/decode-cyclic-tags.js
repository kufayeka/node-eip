'use strict';

/**
 * Delta DVP-SX3 Class 1 I/O Stream Decoder & Tag Monitor
 *
 * Menerjemahkan paket 198 bytes [T->O RX] dari PLC Delta SX3
 * menjadi informasi tag & nilai aktual yang mudah dibaca (Human-Readable).
 *
 * Pemetaan Memory Default Delta SX3 Assembly 101:
 * - Word 0  (Bytes 0..1)   -> D0 (16-bit Signed INT)
 * - Word 1  (Bytes 2..3)   -> D1 (16-bit Signed INT)
 * - Word 2  (Bytes 4..5)   -> D2 (16-bit Signed INT)
 * - Word 3  (Bytes 6..7)   -> D3 (16-bit Signed INT)
 * - Word 4  (Bytes 8..9)   -> D4 (16-bit Signed INT)
 * - Word 5  (Bytes 10..11) -> D5 (16-bit Signed INT)
 * - Word 0..1 (Bytes 0..3) -> D0_D1_DINT (32-bit Integer)
 * - Word 2..3 (Bytes 4..7) -> D2_D3_FLOAT (32-bit REAL / Float)
 *
 * Usage: node examples/decode-cyclic-tags.js [host] [durationSeconds]
 */

const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

// Skema Definisi Tag (bisa disesuaikan dengan kebutuhan aplikasi kamu)
const TAG_SCHEMA = [
    { name: 'D0 (Raw Word 0)',      offset: 0,  type: 'INT16',  unit: '' },
    { name: 'D1 (Counter/Speed)',   offset: 2,  type: 'INT16',  unit: 'RPM' },
    { name: 'D2 (Raw Word 2)',      offset: 4,  type: 'INT16',  unit: '' },
    { name: 'D3 (Process Value)',   offset: 6,  type: 'INT16',  unit: 'val' },
    { name: 'D4 (Raw Word 4)',      offset: 8,  type: 'INT16',  unit: '' },
    { name: 'D5 (Timer/Counter)',   offset: 10, type: 'INT16',  unit: 'ms' },
    { name: 'D6 (Raw Word 6)',      offset: 12, type: 'INT16',  unit: '' },
    { name: 'D7 (Raw Word 7)',      offset: 14, type: 'INT16',  unit: '' },
    { name: 'D8 (Raw Word 8)',      offset: 16, type: 'INT16',  unit: '' },
    { name: 'D9 (Raw Word 9)',      offset: 18, type: 'INT16',  unit: '' },
    // Contoh pembacaan 32-bit DINT dan FLOAT:
    { name: 'D0-D1 (DINT 32-bit)',  offset: 0,  type: 'INT32',  unit: '' },
    { name: 'D2-D3 (FLOAT 32-bit)', offset: 4,  type: 'FLOAT32',unit: '°C' }
];

function decodeTagValue(buffer, tag) {
    if (tag.offset + 2 > buffer.length) return null;

    switch (tag.type) {
        case 'INT16':
            return buffer.readInt16LE(tag.offset);
        case 'UINT16':
            return buffer.readUInt16LE(tag.offset);
        case 'INT32':
            return buffer.length >= tag.offset + 4 ? buffer.readInt32LE(tag.offset) : null;
        case 'UINT32':
            return buffer.length >= tag.offset + 4 ? buffer.readUInt32LE(tag.offset) : null;
        case 'FLOAT32':
            return buffer.length >= tag.offset + 4 ? Number(buffer.readFloatLE(tag.offset).toFixed(2)) : null;
        case 'BOOL':
            const byteVal = buffer.readUInt8(tag.offset);
            const bit = tag.bit || 0;
            return Boolean((byteVal >> bit) & 1);
        default:
            return buffer.readInt16LE(tag.offset);
    }
}

async function main() {
    const host = process.argv[2] || '192.168.68.250';
    const durationSeconds = process.argv[3] ? Number(process.argv[3]) : 5;

    console.log(`======================================================================`);
    console.log(`  DELTA DVP-SX3 REAL-TIME TAG DECODER (Target: ${host})`);
    console.log(`======================================================================\n`);

    const scanner = new Scanner(host);
    await scanner.connect();
    console.log(`[+] Terhubung ke PLC via TCP (Session: 0x${scanner.session.sessionHandle.toString(16)})`);

    // Buka koneksi Class 1 Cyclic I/O (RPI 20ms = ~50 Hz update rate)
    const connectionPath = encodeAssemblyConnectionPath({
        configInstance: 0x80, // Config 128
        o2tInstance: 0x64,     // Output 100
        t2oInstance: 0x65      // Input 101
    });

    console.log(`[+] Membuka Class 1 I/O stream (Assembly 101, 200 Bytes, RPI 20ms)...`);
    const conn = await scanner.openConnection({
        connectionPath,
        rpiUs: 20000,
        otSize: 200,
        toSize: 200
    });

    const io = scanner.createIoConnection(conn, {
        rpiMs: 20,
        initialOutputData: Buffer.alloc(200)
    });

    let packetCount = 0;
    let lastPrintTime = 0;

    io.on('data', (rawPayload, meta) => {
        packetCount++;
        const now = Date.now();

        // Tampilkan data setiap 500ms agar terminal nyaman dibaca mata manusia
        // (Di background, data tetap terproses 50 kali per detik)
        if (now - lastPrintTime >= 500) {
            lastPrintTime = now;

            console.log(`\n--- [PACKET #${packetCount} | Seq: ${meta.sequenceNumber} | Payload: ${rawPayload.length}B | Rate: ~50 Hz] ---`);
            console.log(`+---------------------------+-----------+----------+`);
            console.log(`| TAG NAME                  | VALUE     | UNIT     |`);
            console.log(`+---------------------------+-----------+----------+`);

            for (const tag of TAG_SCHEMA) {
                const val = decodeTagValue(rawPayload, tag);
                const strName = tag.name.padEnd(25, ' ');
                const strVal = String(val).padStart(9, ' ');
                const strUnit = (tag.unit || '').padEnd(8, ' ');
                console.log(`| ${strName} | ${strVal} | ${strUnit} |`);
            }
            console.log(`+---------------------------+-----------+----------+`);
        }
    });

    console.log(`[+] I/O Engine aktif. Menerjemahkan stream selama ${durationSeconds} detik...\n`);
    await io.start();

    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1000));

    console.log(`\n[-] Menghentikan I/O Engine...`);
    await io.stop();

    await scanner.closeConnection(conn);
    await scanner.disconnect();

    console.log(`\n======================================================================`);
    console.log(`  RINGKASAN SELESAI:`);
    console.log(`    Total Paket Real-time Diterima : ${packetCount} paket`);
    console.log(`    Rata-rata Kecepatan Update     : ~${Math.round(packetCount / durationSeconds)} paket/detik (~20ms interval)`);
    console.log(`======================================================================`);
}

main().catch((err) => {
    console.error(`Error:`, err.message);
    process.exit(1);
});
