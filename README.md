# @kufayeka/ethernet-ip

A vendor-neutral ODVA EtherNet/IP (CIP) communication stack and universal PLC device engine for Node.js, built directly from the official **CIP Networks Library** (*Vol 1: Common Industrial Protocol*, *Vol 2: EtherNet/IP Adaptation of CIP*).

Architecture is strictly partitioned into two decoupled layers:
1. **Core ODVA CIP/EIP Protocol Stack**: Pure, vendor-agnostic encapsulation, message router, connection manager, Class 1 I/O engine, EDS parser, and symbolic tag codec.
2. **Universal Device & Pluggable Vendor Profiles**: Declarative, schema-driven PLC abstraction layer (`Device`, `DeviceProfile`, `BatchBuilder`) supporting any PLC manufacturer (Delta, Rockwell, Omron, etc.) with zero protocol hardcoding.

---

## 1. Pemahaman Dasar EtherNet/IP (EIP) & CIP dari Nol

Bagi developer web, IoT, atau software engineer yang baru masuk ke dunia otomasi industri, memahami arsitektur EtherNet/IP sering kali membingungkan karena banyaknya istilah seperti *CIP*, *EPATH*, *Encapsulation*, *Assembly*, *Explicit vs Implicit*, dan *EDS*. Bagian ini mengupas cara kerja protokol ini dari lapisan terbawah (*bottom-up*).

```
+-------------------------------------------------------------------------+
|                  APLIKASI / PERANGKAT (PLC / SCADA / NODE-RED)          |
+-------------------------------------------------------------------------+
|                        DeviceProfile / Tags / Registers                 |
|                   (Memetakan D, Y, M, Timer, Counter ke EPATH)          |
+-------------------------------------------------------------------------+
|                CIP (Common Industrial Protocol) - Layer 7               |
|      Object-Oriented: Class ID -> Instance ID -> Attribute ID           |
|      Services: GetAttribute (0x0E), SetAttribute (0x10), Batch (0x0A)  |
+-------------------------------------------------------------------------+
|                 EtherNet/IP Encapsulation Layer                         |
|      24-Byte Header (Command, Session Handle, Status, Sender Context)   |
|      Command: RegisterSession (0x65), SendRRData (0x6F), NOP (0x00)     |
+-------------------------------------------------------------------------+
|            TCP/IP & UDP Transport Layer (Standard Ethernet)             |
|      Port 44818 (TCP/UDP Explicit Messaging & Session Management)       |
|      Port 2222 (UDP Real-Time Implicit / Class 1 Cyclic I/O)            |
+-------------------------------------------------------------------------+
```

### 1.1 Hubungan EtherNet/IP dan CIP
- **EtherNet/IP BUKAN protokol proprietary**. Kata "IP" di sini singkatan dari *Industrial Protocol*, bukan Internet Protocol.
- **CIP (Common Industrial Protocol)** adalah *bahasa pesan tingkat aplikasi* (Layer 7) yang sama persis digunakan oleh DeviceNet, ControlNet, dan EtherNet/IP.
- **EtherNet/IP** adalah *pembungkus (enkapsulasi)* CIP agar bisa dikirimkan melalui kabel Ethernet standar (IEEE 802.3) menggunakan protokol TCP/IP dan UDP standar.

### 1.2 Model Objek CIP (Class, Instance, Attribute)
Segala sesuatu di dalam perangkat CIP diorganisir sebagai **Objek Berorientasi (Object-Oriented)** dengan alamat 3 tingkat yang disebut **EPATH**:
1. **Class ID**: Kategori atau jenis objek.
   - *Standar ODVA*: Class `0x01` (Identity), Class `0x04` (Assembly), Class `0xF5` (TCP/IP Interface), Class `0xF6` (Ethernet Link).
   - *Vendor-Specific*: Class `0x352` (Delta Data Register D), Class `0x351` (Delta Output Y), Class `0x64` (Omron / generic IO).
2. **Instance ID**: Nomor unit spesifik dari Class tersebut.
   - Contoh: Instance `1` (Unit pertama atau mode bit/word tergantung model PLC).
3. **Attribute ID**: Data atau variabel di dalam objek tersebut.
   - Contoh pada Identity (Class 0x01, Inst 1): Attr `1` = Vendor ID, Attr `7` = Nama Perangkat (*Product Name*).
   - Contoh pada Delta D-Register (Class 0x352): Attr `0` = Register D0, Attr `100` = Register D100.

### 1.3 Dua Metode Komunikasi Utama: Explicit vs Implicit (Class 1)
EtherNet/IP membagi lalu lintas data menjadi dua kanal terpisah sesuai urgensi waktunya:

| Karakteristik | **Explicit Messaging (TCP 44818)** | **Implicit / Class 1 I/O Messaging (UDP 2222)** |
|---|---|---|
| **Pola Komunikasi** | Request - Response (Klien meminta $\to$ Server menjawab) | Producer - Consumer (Streaming data berkala searah/dua arah) |
| **Protokol Jaringan** | **TCP Port 44818** (Unconnected via `SendRRData`) | **UDP Port 2222** (Cyclic multicast/unicast) |
| **Karakter Waktu** | Asinkron, non-realtime deterministik (cocok untuk dashboard, SCADA, HMI, config) | Real-time deterministik berkecepatan tinggi (RPI: misal tiap 10ms - 50ms) |
| **Struktur Data** | Membawa alamat lengkap EPATH (Class, Instance, Attribute) | Hanya membawa buffer biner mentah (*Assembly Data*) tanpa header alamat |
| **Kasus Penggunaan** | Membaca/menulis register PLC (`readD`, `writeY`, `writeM`), membaca diagnostik, batch CIP 0x0A | Mengontrol inverter drive, robot, sensor berat, modul remote I/O, inter-PLC sync |

---

## 2. EDS (*Electronic Data Sheet*) vs `DeviceProfile`

Banyak developer bertanya: *"Jika sudah ada file EDS dari pabrikan, mengapa kita masih membutuhkan `DeviceProfile`? Dan apa bedanya?"*

### 2.1 Apa itu File EDS (`.eds`)?
File EDS adalah dokumen teks standar ODVA (CIP Vol 1 Ch 7) yang diterbitkan oleh pabrikan hardware.
- **Fungsi EDS**: Memberitahukan software konfigurasi jaringan (seperti Rockwell RSLogix, Delta COMMGR, atau Scanner ini) **bagaimana perangkat tersebut hadir di jaringan EtherNet/IP**.
- **Isi EDS**:
  - `[Device]`: Vendor ID, Product Code, Device Type, Revision.
  - `[Assembly]`: ID Assembly Input (T $\to$ O) & Output (O $\to$ T) beserta ukurannya dalam byte.
  - `[Connection Manager]`: Jalur koneksi (*Connection Path*) untuk membuka koneksi Class 1 I/O via `Forward_Open`.
  - `[Params]`: Konfigurasi parameter generik (IP address, timeout, baud rate).

> [!CAUTION]
> **Batasan Fatal File EDS:**
> **File EDS resmi pabrikan PLC (seperti Delta, Mitsubishi, Omron) TIDAK PERNAH memuat peta alamat register memori internal PLC (D, Y, M, X, S, T, C)!**
>
> Jika Anda membaca file EDS resmi Delta ES2-E atau SX3, Anda hanya akan menemukan deklarasi generik seperti `Assem101` (Input_data 32 bytes). File EDS **sama sekali tidak mendokumentasikan** bahwa register `D` berada di CIP Class `0x352`, atau bahwa pada ES2 register `D` memakai Instance 1 sedangkan pada SX3 memakai Instance 2. Pengalamatan register PLC adalah fitur *vendor-proprietary* yang hanya dijelaskan di manual teknis PLC.

### 2.2 Apa itu `DeviceProfile`?
`DeviceProfile` adalah inovasi arsitektur di driver ini (`src/device/profile.js`) untuk memecahkan masalah ketiadaan peta memori pada EDS.
- **Fungsi `DeviceProfile`**: Memberikan **peta kamus memori deklaratif** agar developer bisa memanggil `plc.readD(0)` atau `b.writeYBit('Y10', true)` tanpa pusing memikirkan EPATH atau keanehan tiap seri PLC.
- **Isi `DeviceProfile`**:
  - Pemetaan register: `D` $\to$ Class 0x352, `Y` $\to$ Class 0x351, `M` $\to$ Class 0x353.
  - Resolusi Instance: ES2 memakai Instance 1 (16-bit word), SX3 memakai Instance 2 (16-bit word) dan Instance 1 (bit).
  - Tipe Data & Codec: Lebar byte (INT16, DINT32, BOOL), parser label oktal (`Y10` $\to$ index 8), serta detektor dynamic range (pada ES2, counter `C < 200` adalah 16-bit INT, sedangkan `C >= 200` adalah 32-bit DINT).
  - Kapabilitas: Apakah perangkat mendukung Multiple Service Packet (batch CIP 0x0A), Class 1 I/O, atau Symbolic Tag.

### 2.3 Tabel Perbandingan Lengkap

| Parameter | **File EDS (`.eds`)** | **`DeviceProfile` (Driver Ini)** |
|---|---|---|
| **Format** | File ASCII teks standar ODVA | Objek / File JavaScript deklaratif (`src/vendors/`) |
| **Diterbitkan Oleh** | Pabrikan Hardware Resmi (Rockwell, Delta, Omron) | Pengembang Driver / Integrator Sistem |
| **Level Abstraksi** | **Level Jaringan (Network/Transport)** | **Level Aplikasi & Memori (PLC Logic)** |
| **Pengalamatan Register (D, Y, M, X)** | ❌ **Tidak Tahu** (Hanya berisi buffer Assembly kosong) | ✅ **Tahu Persis** (Class, Instance, bit/word, octal conversion) |
| **Koneksi Class 1 I/O (UDP 2222)** | ✅ **Sangat Lengkap** (Menyediakan EPATH & RPI batas) | 🔶 Hanya mencatat flag kapabilitas (`class1IO: true`) |
| **Batch Operation (CIP 0x0A)** | ❌ Tidak tahu bagaimana cara menyusun batch register | ✅ Menyusun `BatchBuilder` otomatis berdasarkan skema |
| **Verifikasi Identitas Alat** | ✅ Mencocokkan Vendor ID, Device Type, Product Code | 🔶 Berdasarkan nama alias atau vendor/model string |

---

## 3. Panduan Keputusan: Kapan Butuh yang Mana?

Gunakan diagram alur dan panduan berikut untuk menentukan apa yang perlu Anda gunakan untuk kebutuhan proyek Anda:

```
Apakah Anda ingin mengakses register memori PLC (D, Y, M, W)?
 ├── YA  ──> Butuh DEVICE PROFILE (misal 'delta:es2' atau 'delta:sx3')
 └── TIDAK ──> Apakah Anda ingin menghubungkan Modul I/O / Drive via UDP 2222?
                ├── YA  ──> Butuh EDS FILE (untuk auto-config Assembly & RPI)
                └── TIDAK ──> Butuh SCANNER CIP Murni (Explicit Messaging standar)
```

### Skenario 1: Kapan HANYA Butuh `DeviceProfile`?
- **Kasus**: Anda membangun aplikasi Node-RED flow, SCADA, HMI, atau Web Dashboard IoT untuk membaca/menulis register PLC (misal memantau tangki di `D100`, menghidupkan motor di `Y0`, atau membaca counter di `C10`).
- **Alasan**: Anda berkomunikasi via TCP port 44818. Yang Anda butuhkan adalah pemetaan nama register ke EPATH yang tepat. `DeviceProfile` menyelesaikan ini secara elegan dan instan.
- **Contoh**:
  ```js
  const { Device } = require('@kufayeka/ethernet-ip');
  const plc = new Device('192.168.68.111', 'delta:es2');
  await plc.connect();
  const speed = await plc.readD(0);
  await plc.writeYBit(0, true);
  ```

### Skenario 2: Kapan HANYA Butuh `EDS`?
- **Kasus**: Anda menghubungkan perangkat non-PLC (misal remote I/O block, modul pneumatic valve Festo/SMC, barcode reader industri, atau servo drive) yang mengirimkan paket I/O cyclic streaming real-time via UDP 2222.
- **Alasan**: Perangkat tersebut tidak memiliki memori PLC register D/Y/M. Data ditransfer murni dalam bentuk blok byte Assembly I/O. File EDS memberikan informasi otomatis mengenai ukuran buffer input/output, connection path EPATH, dan nilai RPI minimum tanpa perlu Anda cari manual di datasheet setebal 500 halaman.
- **Contoh**:
  ```js
  const { Scanner, EdsFile } = require('@kufayeka/ethernet-ip');
  const eds = EdsFile.fromFile('path/to/device.eds');
  const scanner = new Scanner('192.168.1.50');
  await scanner.connect();
  const connection = await scanner.openConnectionFromEds(eds, { rpiUs: 10000 });
  ```

### Skenario 3: Kapan Butuh KEDUANYA?
- **Kasus**: **Solusi SCADA/Dashboard Hybrid Kinerja Tinggi (Ultra-Fast Monitoring)**.
- **Alasan**:
  1. Anda menggunakan **EDS** untuk membuka koneksi Class 1 I/O (UDP 2222) agar PLC Delta mengirimkan *Assembly 101* (berisi streaming ratusan register D) setiap 20ms tanpa overhead request/response.
  2. Anda menggunakan **`DeviceProfile`** untuk mendekode buffer biner Assembly mentah tersebut menjadi tag register manusia (`D0`, `D1`, `D2`) dan mendeteksi perubahannya (*Change of State*).
- **Contoh**: Digunakan pada fitur `Subscription` / Real-Time Tag Watcher driver ini:
  ```js
  const { Device } = require('@kufayeka/ethernet-ip');
  const plc = new Device('192.168.68.250', 'delta:sx3');
  await plc.connect();

  const watcher = plc.createSubscription({
      mode: 'udp', // Membuka Class 1 UDP stream (berbasis profil koneksi EDS)
      rpiMs: 20,
      tags: ['D0', 'D1', 'Y0'] // Diterjemahkan menggunakan DeviceProfile
  });
  watcher.on('change:D0', (val) => console.log('D0 berubah:', val));
  await watcher.start();
  ```

---

## 4. Quick Start

### 4.1 Akses Register PLC Universal (Delta ES2-E, SX3, dll)
Menggunakan `Device` client universal dengan schema profile otomatis:

```js
const { Device } = require('@kufayeka/ethernet-ip');

// Model otomatis menentukan format CIP:
// - 'delta:es2' menggunakan Instance 1 untuk D
// - 'delta:sx3' menggunakan Instance 2 untuk D
const plc = new Device('192.168.68.111', 'delta:es2');
await plc.connect();

// Baca & tulis word (16-bit)
const d0 = await plc.readD(0);
await plc.writeD(0, 1234);

// Baca & tulis bit (BOOL)
const y0 = await plc.readYBit(0);
await plc.writeYBit(0, true);

// Penulisan label oktal PLC (Y10 oktal = index desimal 8)
await plc.writeYBitLabel('Y10', true);

await plc.close();
```

### 4.2 Schema-Driven Batch Operations (CIP 0x0A)
Kirim puluhan baca/tulis register dalam **1 paket jaringan tunggal**:

```js
const results = await plc.batch((b) => {
    b.writeYBit(0, true);
    b.writeYBit(1, false);
    b.writeD(0, 500);
    b.writeD(1, 1000);
    b.readD(0);
    b.readYBit(0);
});
console.log('Batch results:', results); // [true, true, true, true, 500, true]
```

### 4.3 Pure ODVA CIP Scanner (EIPSession & Explicit Messaging)
Jika hanya membutuhkan scanner protokol CIP generik:

```js
const { Scanner } = require('@kufayeka/ethernet-ip');

const scanner = new Scanner('192.168.1.10');
await scanner.connect();

// Get_Attribute_Single (Identity Object: Vendor ID)
const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
console.log('Vendor ID:', vendorId.readUInt16LE(0));

await scanner.disconnect();
```


```js
// Class 1 Real-Time Cyclic I/O (UDP 2222 with 32-bit Run/Idle & Sequence Tracking)
const { Scanner, encodeAssemblyConnectionPath } = require('@kufayeka/ethernet-ip');
const scanner = new Scanner('192.168.68.250');
await scanner.connect();

const conn = await scanner.openConnection({
    connectionPath: encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 }),
    rpiUs: 20000, otSize: 200, toSize: 200
});
const io = scanner.createIoConnection(conn, { rpiMs: 20, initialOutputData: Buffer.alloc(200) });
io.on('data', (buf, meta) => console.log(`[T->O] Seq: ${meta.sequence}, Bytes: ${buf.length}`));
// io.close() when done
```

```js
// Automated Connection from ODVA Standard EDS File
const { Scanner, EdsFile } = require('@kufayeka/ethernet-ip');
const eds = EdsFile.fromFile('eds/sx3-sample/031F000E0F0600010001.eds');
const scanner = new Scanner('192.168.68.250');
await scanner.connect();
const conn = await scanner.openConnectionFromEds(eds, { rpiUs: 20000 });
```

```js
// CIP Fragmentation & Large Data Transfer (§33, §34)
const { data, fragmentsCount } = await scanner.readLargeAttribute({
    classId: 0x04, instance: 101, attribute: 3, chunkSize: 480
});
```

```js
// Symbolic Tag Addressing (§26, §27 — e.g. Logix, Omron, Delta SYMBOL_ANSI)
const speed = await scanner.readTag('Motor.Speed', { dataType: 'INT' });
await scanner.writeTag('Motor.Speed', 2500, { dataType: 'INT' });
const tank = await scanner.readTag('Tanks[2].Level', { dataType: 'REAL' });
```

```js
// Real-Time Tag Watcher / Subscription (Dual Mode: Polling TCP 44818 & Real-Time UDP 2222)
const sub = plc.createSubscription({
    mode: 'udp', // or 'polling'
    rpiMs: 20,   // 20ms cyclic stream
    tags: ['D0', 'D1', 'D10', 'Y0']
});

// Event listeners: Change of State (by exception) & Cyclic (every tick)
sub.on('change', (tag, newVal, oldVal) => console.log(`Tag ${tag} changed: ${oldVal} -> ${newVal}`));
sub.on('change:D0', (newVal, oldVal) => console.log(`D0 updated: ${newVal}`));
sub.on('cyclic', (snapshot) => console.log('Current PLC Values:', snapshot));

await sub.start();
```

## Test

```
npm test
```

281 tests (`test/*_spec.js`) — encoding/round-trip tests against synthetic
buffers, real Delta hardware captures, and loopback EIPAdapter.
Live-hardware validation is separate — see the `Live?` notes throughout
this checklist and [`examples/README.md`](examples/README.md) for runnable scripts
against a real device (all defaulting to `192.168.68.250`).

---

## 1. EtherNet/IP Encapsulation Layer

### 1.1 Encapsulation Header — ✅

24-byte header encode/decode: [src/encapsulation/header.js](src/encapsulation/header.js).
`decodeMessage()` validates length and returns `null` on an incomplete
buffer (correct TCP-stream framing, see §39) rather than throwing or
guessing. Sender Context (8 bytes) is actively generated as a 64-bit
monotonic sequence counter and used for **request/response correlation**
via an internal `Map` in `EIPSession` (see §40 — ✅ completed and live-validated).
Zero-length payload, malformed/truncated buffers, and unexpected session handles
are handled without crashing (`decodeHeader`/`decodeMessage` throw
`RangeError`/return `null` predictably).

### 1.2 Encapsulation Commands

| Command | Code | Status |
|---|---|---|
| `NOP` | 0x0000 | ✅ live — heartbeat probe in `src/client.js` and echoed by `src/adapter.js` |
| `ListServices` | 0x0004 | ✅ live — queries encapsulation services (`src/encapsulation/services.js`, `Scanner.listServices()`, `EIPAdapter`) |
| `ListIdentity` | 0x0063 | ✅ live — UDP broadcast, UDP unicast, TCP (`src/encapsulation/discovery.js`) |
| `ListInterfaces` | 0x0064 | ⬜ constant only |
| `RegisterSession` | 0x0065 | ✅ live (`src/encapsulation/session.js`, `src/client.js`) |
| `UnregisterSession` | 0x0066 | ✅ live |
| `SendRRData` | 0x006F | ✅ live — unconnected explicit messaging (`src/encapsulation/rrdata.js`) |
| `SendUnitData` | 0x0070 | ⬜ constant only — connected (Class 3) explicit messaging is not implemented on either client or server side |

Unknown/unsupported commands: the Adapter (`src/adapter.js`) answers
`ListServices` (0x0004) with capability flags and service name, and returns
`EncapsulationStatus.InvalidCommand` (0x0001) for unhandled commands (such as
`ListInterfaces` or `SendUnitData`) per ODVA specification.

---

## 2. Session Management

### 2.1 Register Session — ✅

`EIPSession.connect()` sends `RegisterSession`, parses the returned
session handle, stores it, and rejects on a nonzero response status
(`src/client.js`). Protocol version/options are fixed (version 1, options
0) — not configurable, but that's the only value any real device accepts
per spec.

### 2.2 Session Lifecycle — ✅ **live-validated**

Full session lifecycle state machine (`DISCONNECTED` ➔ `CONNECTING` ➔ `REGISTERED` ➔ `ACTIVE` ➔ `DESTROYED`)
in `src/client.js` and `src/scanner.js`. Includes:
- **Encapsulation NOP (0x0000) & Identity Keepalive**: periodic heartbeat timer (`heartbeatIntervalMs`)
  detecting silent network link dropouts. Supported in `src/encapsulation/services.js` and echoed by `src/adapter.js`.
- **Liveness probe**: fast 2ms Identity probe via `scanner.ping()`.
- **Auto-Reconnect Engine**: configurable exponential backoff (`reconnectDelayMs`, `maxReconnectAttempts`)
  when remote PLC disconnects, drops the socket, or reboots. Automatically re-registers the session and
  safely drains pending queues.
- Tested in `test/session-robustness_spec.js` and live against Delta SX3 in `examples/session-robustness.js`.

### 2.3 Thread Safety — N/A / ⬜ (see §40)

Node.js is single-threaded, so classic multi-thread races don't apply —
but the *concurrent request* version of this problem (§40) is a real,
confirmed gap: `EIPSession` has no per-request correlation at all.

---

## 3. SendRRData / Unconnected Explicit Messaging — ✅

`src/encapsulation/rrdata.js` builds/parses the full stack (Encapsulation
→ SendRRData → CPF → CIP Message). CPF parsing (§5) handles Null Address
Item + Unconnected Data Item; Connected Address/unknown items would
decode generically (CPF is type-agnostic) but aren't exercised on this
path since SendRRData is always unconnected. Live-validated extensively
against a real Delta SX3 (explicit reads/writes of hundreds of registers,
Forward_Open/Close, etc. — see `docs/PROJECT_LOG.md`).

## 4. SendUnitData / Connected Messaging — ⬜

Not implemented on either the client (`EIPSession`) or the server
(`EIPAdapter`) side — `grep SendUnitData src/` finds only the constant and
an explicit "not yet implemented" comment in `src/adapter.js`. This means
**Class 3 connected explicit messaging doesn't exist in this driver at
all** — every explicit request goes over unconnected `SendRRData`
instead, which works for everything tested so far but isn't spec-complete.

## 5. Common Packet Format (CPF) — ✅

Generic encoder/decoder: [src/encapsulation/cpf.js](src/encapsulation/cpf.js).
Item shape is `{ typeId, data }`, decoded generically — unknown item types
pass through without special-casing (nothing to reject), matching the
spec's "ignore what you don't recognize" intent. Validates item count and
truncated headers/data (`RangeError`, no buffer over-read). Supports Null
Address, Connected Address, Unconnected Data, Connected Data, and
Sequenced Address item type IDs (`CpfItemType`).

## 6. CIP Message Layer — ✅

`src/cip/message-router.js`: `buildRequest`/`parseResponse` (client) and
`parseRequest`/`buildResponse` (server, Phase 3) are exact inverses.
Response parsing structurally separates `generalStatus` from
`additionalStatus` (an array, not discarded — see §36) and `data`.
"Partial Success" isn't a distinct case in the general-status decode logic
(0x06 `PartialTransfer` is just another status value, not specially
branched), which is spec-accurate — CIP doesn't have a third
success/partial/error tier beyond checking `generalStatus === 0`.

## 7. CIP Service Framework — ✅

Not hardcoded — `buildRequest({ service, path, data })` accepts any
service code as a plain number, used identically for `Get_Attribute_Single`
(0x0E), `Set_Attribute_Single` (0x10), `Forward_Open` (0x54, via
`connection-manager.js`), and every Delta vendor service. `Scanner.getAttribute()`/`setAttribute()`
are the ergonomic wrapper (`src/scanner.js`), but the raw
`sendUnconnected(buildRequest(...))` path is always available for any
service/class/instance/attribute combination — including ones this driver
has no named wrapper for yet.

`Get_Attributes_All` (0x01): ✅ live — `scanner.getAttributesAll({ classId, instance })`
implements Get_Attribute_All and automatically decodes Identity Object (0x01).
The `EIPAdapter` server dispatches `GetAttributeAll` across Identity, TCP/IP, and
Ethernet Link objects. Live-validated against Delta SX3 PLC.

`Set_Attribute_All` (0x02), `Reset` (0x05), `Create` (0x08), `Delete` (0x09): ⬜ no
dedicated helper, though the generic `buildRequest` framework supports issuing
any of these manually today.

`Multiple_Service_Packet` (0x0A): ✅ **live-validated** — full batching support in
`src/cip/multiple-service.js`, `Scanner.sendMultipleRequests()`, `DeltaDevice.batch()`,
and `EIPAdapter` dispatch. (See §25).

## 8. CIP Object Model — 🔶

Generic path builder: `encodeEPath({ classId, instance, attribute,
connectionPoint, member })` in [src/cip/path.js](src/cip/path.js), covering
Logical Segments only (see §21). No fluent builder API
(`CIPPath.class(x).instance(y)`) — it's a plain options object, functionally
equivalent but not the exact shape README_GOAL sketches.

## 9. Standard CIP Objects

### Identity Object (0x01) — ✅

Client-side read confirmed live (Vendor ID, Product Name, cross-checked
against ListIdentity — `docs/PROJECT_LOG.md`). Server-side implementation:
[src/cip/objects/identity.js](src/cip/objects/identity.js) (Phase 3, loopback-validated).
`Reset` service: ⬜ not implemented.

### Message Router (0x02) — 🔶

Framing (§6) is complete and this **is** the message router in the sense
that every CIP request in this driver is dispatched through it — but there
is no explicit "Message Router Object" with its own queryable attributes
(Number Available/Number Active) on either client or server side.

### Connection Manager (0x06) — 🔶 (see §12 for detail)

### TCP/IP Interface Object (0xF5) / Ethernet Link Object (0xF6) — ✅

Fully implemented and live-validated (see §10 and §11 below). Served by `EIPAdapter`
and queryable via `Scanner.getTcpIpConfig()` and `Scanner.getEthernetLinkInfo()`.

---

## 10. TCP/IP Interface Object (0xF5) — ✅ **live-validated**

Implemented in [src/cip/objects/tcp-ip.js](src/cip/objects/tcp-ip.js):
- **Server side (`EIPAdapter`)**: Serves Instance 1 with Status (Attr 1, DWORD),
  Configuration Capability (Attr 2, DWORD), Configuration Control (Attr 3, DWORD),
  Physical Link Object EPATH pointing to Class 0xF6 (Attr 4, STRUCT), Interface
  Configuration (Attr 5, STRUCT with IP, Netmask, Gateway, Primary/Secondary DNS,
  Domain Name), Host Name (Attr 6, STRING), and Inactivity Timeout (Attr 13, UINT).
  Supports `setAttributeSingle` for settable attributes (3, 5, 13).
- **Client side (`Scanner.getTcpIpConfig()`)**: Reads and decodes raw attribute
  buffers into friendly JavaScript objects.
- **Live-validated** against real Delta SX3 hardware (`examples/read-network-objects.js`),
  successfully decoding IP `192.168.68.250`, Netmask `255.255.255.0`, and Host Name `"DVP-SX3"`.

## 11. Ethernet Link Object (0xF6) — ✅ **live-validated**

Implemented in [src/cip/objects/ethernet-link.js](src/cip/objects/ethernet-link.js):
- **Server side (`EIPAdapter`)**: Serves Instance 1 with Interface Speed (Attr 1, UDINT,
  e.g. 100 Mbps), Interface Flags (Attr 2, DWORD with Link Active bit 0 and Full Duplex bit 1),
  Physical MAC Address (Attr 3, USINT[6]), Interface Label (Attr 10, SHORT_STRING),
  and Interface Capability struct (Attr 11).
- **Client side (`Scanner.getEthernetLinkInfo()`)**: Formats MAC addresses into
  standard `XX:XX:XX:XX:XX:XX` strings and decodes duplex/link status flags.
- **Live-validated** against real Delta SX3 hardware (`examples/read-network-objects.js`),
  successfully reading Speed `100 Mbps`, Duplex `Full Duplex`, Link `Active`, and
  MAC Address `00:18:23:E4:61:2E`.

---

## 12. Connection Manager — ✅ **live-validated**

**Forward_Open (0x54):** ✅ full classic Forward_Open (≤511 bytes) build/parse on
both client (`src/cip/connection-manager.js` + `src/client.js`) and
server (`src/adapter/connection-handler.js`) — live-validated against real Delta SX3.

**Large_Forward_Open (0x5B):** ✅ **live-validated** per CIP Vol 1 Section 3-5.5.3.
Supports 32-bit Network Connection Parameters (Table 3-5.17) allowing connection sizes
up to 65,535 bytes. Includes `buildLargeForwardOpenRequest()`, `parseLargeForwardOpenRequest()`,
adapter handling in `src/adapter.js`, and transparent fallback to standard Forward_Open if
a legacy target rejects 0x5B. Empirically confirmed supported natively on real Delta DVP-SX3
hardware (`isLarge: true` in `examples/large-forward-open.js`).

**Forward_Close (0x4E):** ✅ same completeness/validation as Forward_Open.

**Extended status decoding:** 🔶 `ForwardOpenExtendedStatus` in
`connection-manager.js` covers ~25 common codes for debugging, explicitly
documented as non-exhaustive.

---

## 13. CIP Connection Lifecycle — ✅ **live-validated**

Full connection lifecycle management in `src/cip/io-connection.js` (`IOConnection` engine):
State transitions tracked explicitly (`CLOSED` ➔ `OPENING` ➔ `ACTIVE` ➔ `TIMED_OUT` ➔ `RECOVERING` ➔ `CLOSED`).
Includes watchdog timer monitoring incoming stream health, automatic recovery upon packet reception,
and clean connection teardown via `Forward_Close`. Tested in `test/io-connection_spec.js` and
live against Delta SX3 in `examples/class1-cyclic-io.js`.

## 14. Real-Time I/O — UDP/2222 — ✅ **live-validated**

`src/cip/io-connection.js` implements full-duplex implicit messaging on UDP port 2222:
- Supports both **Modeless** (0-byte) and **32-bit Run/Idle Header** (`Header32Bit`, 4-byte little-endian
  where `Run = 0x00000001` and `Idle = 0x00000000`) per CIP Vol 1 Section 3-5.5.
- Originator cyclically transmits O➔T datagrams at negotiated RPI.
- Target cyclically transmits T➔O datagrams with Sequence Number and Run/Idle status.
- Live-validated against Delta DVP-SX3 hardware (`examples/class1-cyclic-io.js`).

## 15. I/O Connection Types — ✅ **live-validated**

Point-to-point ✅. Unicast ✅. Cyclic ✅ (default `transportTypeTrigger = 0x01`).
Supports runtime output payload mutation (`io.setOutput(buf)`) and Run/Idle state toggling
(`io.setRun(bool)`). EIPAdapter server loopback mirrors cyclic connections (`src/adapter/connection-handler.js`).

## 16. RPI — ✅ **live-validated**

Negotiates actual connection intervals (`rpiUs`, `otApiUs`, `toApiUs`) via Forward_Open.
The `IOConnection` engine uses actual negotiated `toApiUs` / `otApiUs` to drive cyclic transmission
timers and size the watchdog timeout window (`timeoutMultiplier * rpiMs`).

## 17. Sequence Number — ✅ **live-validated**

`SequenceTracker` in `src/cip/io-connection.js` provides comprehensive sequence tracking:
- Encodes and increments 32-bit sequence counter on outgoing datagrams.
- Validates sequence progression on incoming datagrams: detects normal (`ok`), packet loss (`lost` with
  exact count of dropped packets), duplicates (`duplicate`), and out-of-order packets (`out_of_order`).
- Handles 32-bit rollover (`0xFFFFFFFF ➔ 0x00000000`) smoothly without false loss alarms.
- Validated in `test/io-connection_spec.js` (100% test coverage) and live hardware runs.

## 18. Multicast Handling — ⬜

Not implemented at all — no multicast IP handling, no `IGMP`, no
`IP_ADD_MEMBERSHIP`/`IP_MULTICAST_IF`. Every I/O connection tested so far
is point-to-point unicast.

## 19. CIP Routing — ✅

Full multi-hop routing support via Port Segments in `src/cip/path.js`.
`encodeRoutePath(hops, target)` and `encodeEPath({ portSegments, ... })` enable
multi-hop routing (e.g. Ethernet Port 2 → remote IP → Backplane Port 1 → Slot 0
processor → target CIP object). Fully round-trips through `decodeEPath()`.

## 20. Port Segment — ✅

Implemented in `src/cip/path.js` (`encodePortSegment` / `decodePortSegment`).
Supports standard ports (0-14) and extended ports (>= 15), numeric link addresses
(e.g. backplane slot), and extended link addresses (string IP or node addresses)
with strict 16-bit word padding per CIP Vol 1 Appendix C (C-1.3). Validated in
`test/port-segment_spec.js` and `examples/routing-and-types.js`.

## 21. Logical Segments — 🔶

`src/cip/path.js`'s `encodeLogicalSegment`/`decodeLogicalSegment` support
Class, Instance, Attribute, Connection Point, and Member logical types,
correctly switching between 8-bit/16-bit/32-bit padded encoding based on
value size (`test/path_spec.js` covers all three widths). **Extended
Logical** (Logical Type values 5-7: Special, Service ID, reserved) is not
implemented — not needed by anything targeted so far.

---

## 22. Symbolic Segment — ✅ **live-validated**

Implemented in `src/cip/path.js` (`encodeAnsiSymbolSegment`, `decodeAnsiSymbolSegment`, `encodeSymbolicPath`, `decodeSymbolicPath`)
per ODVA CIP Vol 1 Appendix C (C-1.4.3 Data Segments):
- **0x91 Segment Format**: Encodes ASCII symbol string prefixed with `0x91` and 1-byte length, appending 1 pad byte (`0x00`)
  when character length is odd to maintain strict 16-bit word alignment.
- **Struct Navigation**: Chained dot notation (e.g. `Motor.Speed`) seamlessly encodes multiple 0x91 segments.
- **Produced / Consumed Tag Connections**: `encodeTagConnectionPath({ configTag, o2tTag, t2oTag })` binds Class 1
  implicit I/O connections directly to symbolic tag names.
- **Scanner & Adapter Integration**: `scanner.readTag(name, { dataType })`, `scanner.writeTag(name, value, { dataType })`,
  and `adapter.defineTag(name, type, value)`. Tested in `test/symbolic-tag_spec.js` and `examples/symbolic-tag-demo.js`.

## 23. Array Indexing — ✅ **live-validated**

Implemented in `src/cip/path.js` (`encodeSymbolicPath` / `decodeSymbolicPath`):
- Automatically resolves bracketed subscript indices (e.g. `Tanks[2]`, `Lines[0].Motors[1].Speed`).
- Generates standard CIP Member Segments (`0x28` for 8-bit index, `0x29` for 16-bit index) following symbol segments.
- Full roundtrip parsing and verification in `test/symbolic-tag_spec.js`.

## 24. Logix Tag Services (Read/Write Tag 0x4C/0x4D, Fragmented 0x52/0x53) — ⏸ deferred

Explicitly out of scope — `src/logix/tag-service.js` is a placeholder
(⬜, "phase 2" in the source layout) with nothing implemented. Delta
devices don't use these services at all (confirmed via a full CIP class
sweep on real hardware — see `docs/delta-cip-object-reference.md`).

## 25. Multiple Service Packet (0x0A) — ✅ **live-validated**

Implemented in `src/cip/multiple-service.js` per CIP Vol 1 Section 3-5.5.
Packages multiple CIP requests into a single Message Router request (`0x02/1, 0x0A`)
with offset tables and sub-response extraction. Includes automatic transparent fallback
to individual pipelined requests if a target device returns `0x08 ServiceNotSupported`.
Supported natively on real Delta DVP-SX3 hardware (resolves 5+ batched requests
in <10 ms). Tested in `test/multiple-service_spec.js` and `examples/multiple-service.js`.

## 26. Logix Symbol Object (0x6B) — ⏸ deferred (Rockwell-specific)

Not implemented, not needed for Delta.

## 27. Template Object (0x6C) — ⏸ deferred (Rockwell-specific, depends on §26)

Not implemented, not needed for Delta.

---

## 28. Data Type System — ✅

Implemented in `src/cip/types.js`. Contains centralized metadata and codecs
(`CIP_DATA_TYPES`, `encodeType`, `decodeType`) for all ODVA elementary data types:
`BOOL`, `SINT`, `INT`, `DINT`, `LINT`, `USINT`, `UINT`, `UDINT`, `ULINT`, `REAL`,
`LREAL`, `BYTE`, `WORD`, `DWORD`, `LWORD`, `SHORT_STRING`, `STRING`.
Fully tested with boundary and truncation assertions in `test/types_spec.js`.

## 29. Endianness — ✅

Every multi-byte field in this codebase is read/written explicitly
little-endian (`readUInt16LE`, `writeInt32LE`, etc.) — `grep -rn
"readUInt\|writeUInt\|readInt\|writeInt" src/` shows zero native-endian
(`readUInt16`/`writeUInt16` without the `LE`/`BE` suffix) calls. No
native-CPU-endian dependency anywhere.

## 30. BOOL / Bit-Level Access — ✅

Implemented in `src/cip/types.js` (`readBit`, `writeBit`, `resolveBitMember`).
Supports bit indexing (0-7), bit setting/clearing, and packed boolean member
resolution by mask or byte/bit offset inside any structured attribute buffer.
Complementary to Delta's per-bit CIP instances in `src/delta/registers.js`.

## 31. String Handling — ✅

Implemented in `src/cip/types.js` (`encodeShortString`, `decodeShortString`,
`encodeCipString`, `decodeCipString`). Supports ODVA standard `SHORT_STRING`
(UINT8 length + ASCII characters) and `STRING` (UINT16 length + ASCII characters).

## 32. UDT Decoder — ⏸ deferred (Rockwell/Logix-specific, depends on §27)

Not implemented, not needed for Delta (no UDTs involved in anything
targeted so far).

## 33. Fragmentation — ✅ **live-validated**

Implemented in `src/cip/fragmentation.js` per CIP Vol 1 Chapter 3 & Section 33:
- **`FragmentReader`**: Progressive read loop automatically handling CIP status `0x06 (Partial Transfer)`
  until final `0x00 (Success)`. Tracks 32-bit little-endian byte offsets, reassembles incoming chunk
  buffers into a contiguous buffer, enforces `maxTotalBytes` safety ceiling, and emits `chunk`/`progress` events.
- **`FragmentWriter`**: Slices large write payloads exceeding MTU into chunks prepended with 32-bit
  unsigned LE offsets, emitting progress percentages until delivery is complete.
- **Server Adapter Integration**: `AssemblyObject` (`src/cip/objects/assembly.js`) supports `maxFragmentSize`,
  serving multi-part `0x06 Partial Transfer` responses and accepting chunked writes.
- **Scanner Integration**: `scanner.readLargeAttribute()` and `scanner.writeLargeAttribute()`.
- Validated in `test/fragmentation_spec.js` and demonstrated in `examples/fragmentation-demo.js`.

## 34. CIP Error Handling — ✅

`parseResponse()` (`src/cip/message-router.js`) always returns a
structured `{ service, generalStatus, additionalStatus, data }` — never
just a boolean/thrown string. Callers (`Scanner.getAttribute`, Delta's
`registers.js`, etc.) build a descriptive `Error` from the *whole*
structure (general status name + hex additional status words), not a bare
`if (status !== 0) throw`.

## 35. General Status Codes — ✅ (exceeds the checklist)

`CipGeneralStatus` in [src/constants.js](src/constants.js) covers the
full CIP Vol 1 Appendix B table through `0x2E`
(`ServiceNotSupportedForSpecifiedPath`) — every code README_GOAL lists
plus ~15 more (Routing Failure variants, Embedded Service Error,
Vendor Specific Error, Member/Attribute-list errors, etc.).

## 36. Additional Status — ✅

Never discarded — `parseResponse()` returns it as a plain array of
16-bit words on every response, and every error path in this driver
(`assertGetSuccess` in `registers.js`, `_forwardOpenError` in
`client.js`) includes it in the thrown error's message. `Forward_Open`
specifically decodes the first additional status word against a
~25-entry lookup table for a human-readable reason.

---

## 37. Timeout Management — 🔶

One `timeoutMs` (default 5000ms) per `EIPSession`, applied to *both* the
initial TCP connect and every subsequent request/response transaction —
not the differentiated set README_GOAL wants (separate TCP connect /
session / CIP request / Forward Open / I/O connection / fragment
timeouts). Works fine for this driver's current sequential-request usage
pattern, but is a single global knob, not per-operation-type.

## 38. Retry Policy — ⬜

No retry logic anywhere in this codebase. A failed/timed-out request
simply rejects its promise; the caller decides whether to retry.
Retryable-vs-non-retryable classification (TCP reset vs. Invalid
Attribute) doesn't exist.

## 39. TCP Stream Handling — ✅

`EIPSession._onData()` (`src/client.js`) buffers incoming chunks
(`Buffer.concat`) and loops `decodeMessage()` until it returns `null`
(incomplete message, keep buffering) — correctly handles both a single
TCP read containing multiple encapsulation messages back-to-back, and one
message split across multiple reads. This is exactly the framing
README_GOAL calls "one of the most important parts for robustness," and
it's implemented correctly.

## 40. Concurrency — ✅ **live-validated**

`EIPSession` implements request/response correlation using the 8-byte
**Sender Context** field specified by ODVA CIP Vol 2 §2-3.1. Each outgoing
encapsulation request is tagged with a unique 64-bit monotonic sequence number
stored in a `Map<string, Entry>`. When an encapsulation response arrives off the
wire, `_onData()` matches `msg.header.senderContext` against the active transactions:
- Responses that arrive out-of-order are matched to their exact original promise
  without cross-talk.
- Timed-out requests are purged cleanly; if the server later sends a delayed
  response, it is safely dropped without desynchronizing subsequent requests.
- Live-tested on a real Delta SX3 (`examples/test-concurrency-live.js`), resolving
  7 simultaneous `Promise.all` reads in ~41ms without error.

## 41. Request Queue / Backpressure — ✅ **live-validated**

Embedded industrial PLCs often have shallow TCP socket buffers and drop
or stall incoming bursts if multiple encapsulation packets are written in the
same millisecond. `EIPSession` features an internal request queue with a
configurable `maxInFlight` setting (default `1` for maximum device compatibility,
can be set higher for capable gateways or PC-based targets). When callers issue
bursts like `Promise.all([read(1), read(2), ...])`, `EIPSession` queues and
pipelines them cleanly across the single TCP session.

## 42. Connection Pooling — 🔶

One `EIPSession` = one persistent TCP session, reused across multiple
`read`/`write` calls without re-registering per call (`connect()` once,
then any number of `sendUnconnected()`/`openConnection()` calls, then
`close()`) — matches the "connect → persistent session → read/write →
disconnect" pattern README_GOAL wants. What's missing: any explicit
tracking of *multiple simultaneous* Class 1/Class 3 connections per
session as a managed pool (each `openConnection()` call is independent;
nothing enumerates or manages "all connections currently open on this
session" as a collection).

---

## 43. Discovery — ✅

`ListIdentity` via UDP broadcast (auto-detecting every active local IPv4
interface and sending a subnet-directed broadcast on each —
`ipv4DirectedBroadcasts()`), UDP unicast, and TCP — all three
live-validated against two real, different Delta PLCs found on the same
LAN with zero device-specific code (`src/encapsulation/discovery.js`,
`examples/scan-network.js`). Output shape matches README_GOAL's ideal
exactly: `{ address, vendorId, deviceType, productCode, revision, status,
serialNumber, productName }`.

## 44. Device Identity & EDS Verification — ✅ **live-validated**

Implemented in `src/cip/eds.js` (`EdsFile`):
Parses ODVA standard Electronic Data Sheet (EDS) files per CIP Vol 1 Appendix J & Chapter 7.
Extracts device classification from `[Device]` (VendCode, DevType, ProdCode, MajRev, MinRev, ProdName).
Provides `eds.matchesDevice({ vendorId, productCode, deviceType, majorRev })` to verify discovered
devices against certified EDS profiles. Validated against Delta SX3, ES3, and ES2 EDS files in `test/eds_spec.js`.

## 45. Device Capability Detection via EDS — ✅ **live-validated**

Implemented in `src/cip/eds.js`:
- Extracts real-time I/O connection parameters, application paths, assembly sizes, and default RPIs
  from `[Connection Manager]` (e.g. `Connection1` with ParamPath `20 04 24 80 2C 64 2C 65`).
- Enables automated negotiation via `scanner.openConnectionFromEds(edsOrPath)` without manual register
  hardcoding. Tested live against Delta DVP-SX3 hardware in `examples/eds-discovery.js`.

## 46. Generic CIP Path Builder — 🔶

`encodeEPath({ classId, instance, attribute, connectionPoint, member })`
in `src/cip/path.js` is generic and reusable (used identically by the
core CIP layer and every Delta vendor register) — but it's a plain
options object, not the fluent builder class (`new CIPPath().class(x)...`)
README_GOAL sketches. Functionally equivalent; API shape differs.

## 47. Generic Binary Codec — ⬜ (informal, not a real subsystem)

There is no `ByteReader`/`ByteWriter` abstraction — every module reads
Node's `Buffer` methods directly at the call site (`buf.readUInt16LE(0)`,
etc.). This has worked without incident so far because every payload this
driver handles is small and fixed-shape, but it means byte-parsing logic
is inline everywhere rather than centralized, which is exactly what
README_GOAL warns produces protocol bugs at scale (e.g. Data Type System,
§28, would need this as a foundation).

## 48. Packet Validation — 🔶

Each layer validates its own framing and throws a clear, typed error on
malformation rather than crashing or reading out of bounds: encapsulation
header length (`header.js`), CPF item/length bounds (`cpf.js`), CIP
request/response minimum length (`message-router.js`), EPATH segment
type/length (`path.js`). **Not verified:** no fuzz-testing has been done
to prove there's no buffer-over-read edge case anywhere; this is "looks
correct on inspection and passes 157 targeted unit tests," not "proven
safe against adversarial input."

## 49. Security / Robustness — 🔶

Malformed-packet handling per §48 above. **Not implemented:** any
explicit protection against oversized packets, integer overflow on
attacker-controlled length fields beyond what `Buffer`'s own bounds
checking provides, resource exhaustion from a flood of
connections/requests, or rate limiting. This driver has never been
adversarially tested — treat it as "correct against well-formed and
moderately malformed input from real devices," not "hardened against a
malicious peer."

## 50. Logging & Diagnostics — ⬜

No logging subsystem at all — no log levels (ERROR/WARN/INFO/DEBUG/
TRACE/PACKET), no built-in TX/RX packet tracing. Diagnostic output during
development has been ad-hoc `console.log` in one-off scripts
(`examples/*.js`), never a reusable logger.

## 51. Wireshark Compatibility — 🔶 (informally verified, not tooled)

Every byte-level format in this driver has been manually cross-checked
against real hardware behavior (request sent → expected response
received, correct values read back matching independently-known ground
truth) extensively throughout `docs/PROJECT_LOG.md` — but this was done
by direct protocol testing against real PLCs, not by capturing traffic in
Wireshark and diff'ing byte-for-byte against a reference implementation.
No Wireshark-based verification workflow exists in this repo.

## 52. Protocol Test Suite — 🔶

`npm test` — 157 tests covering encapsulation, CPF, CIP framing, path
encoding, connection manager, Delta register objects (full read/write
matrix, every type, 16-bit and 32-bit, boundary values), and device-type
profiles. **Missing categories** README_GOAL calls for: malformed-input
fuzz tests, concurrency tests (would currently fail — see §40), reconnect
tests, and fragmentation tests (nothing to test, §33 isn't implemented).

## 53. Interoperability Testing — 🔶 (two real devices, one vendor)

Live-tested against two genuinely different real PLCs (a DVP-SX3 and a
DVP32ES2-E — different CPU families, different CIP object models) on the
same LAN, which is more than "one Rockwell PLC," but both are Delta.
Zero testing against Schneider/Omron/Mitsubishi/Keyence/other vendors —
the vendor-neutral core (encapsulation, CPF, CIP framing, Forward_Open)
has no Delta-specific assumptions baked in, but that claim is
"structurally true by code inspection," not "verified against a second
vendor's hardware."

---

## 54. Rockwell-Specific Compatibility Layer — ⏸ deferred

Not built. The architectural intent (`src/logix/` as an additive layer
above the generic CIP core, mirroring `src/delta/`) is already reflected
in the source layout, but nothing inside it is implemented yet
(`src/logix/tag-service.js` is a placeholder). Revisit once Delta work
reaches a stable point — not a priority per current project direction.

## 55. Conformance-Oriented Final Checklist

```text
[x] TCP 44818
[x] UDP 44818
[ ] UDP 2222 (produced I/O only, not general-purpose bind/consume beyond examples)

[x] Encapsulation Header
[x] RegisterSession
[x] UnregisterSession
[x] SendRRData
[ ] SendUnitData
[x] ListIdentity
[ ] ListInterfaces
[x] ListServices
[ ] NOP

[x] CPF
[x] CIP Request
[x] CIP Response
[x] General Status
[x] Additional Status

[~] Object Model              (generic path builder yes, no dedicated Message Router object attributes)
[x] Identity Object           (client read + server serve, live-validated)
[~] Message Router            (framing complete; no Number Available/Active attributes)
[~] Connection Manager        (Forward_Open/Close yes; Large_Forward_Open no)
[x] TCP/IP Interface          (Class 0xF5, client decode + adapter serve, live-validated)
[x] Ethernet Link             (Class 0xF6, client decode + adapter serve, live-validated)

[x] GetAttributesAll
[x] GetAttributeSingle
[ ] SetAttributesAll
[x] SetAttributeSingle
[ ] Reset
[x] Multiple Service Packet

[x] ForwardOpen
[ ] LargeForwardOpen
[x] ForwardClose

[x] Connection IDs
[x] Connection Serial
[x] Originator Vendor ID
[x] Originator Serial
[x] RPI
[x] Timeout Multiplier
[x] Connection Path

[ ] Class 1                   -- see note: implemented as raw UDP I/O, not via SendUnitData/Class 3
[x] Class 1 (raw UDP produce/consume, Originator role, live-validated)
[ ] Class 3 (SendUnitData-based connected explicit messaging)
[x] Unicast
[ ] Multicast
[x] Cyclic
[ ] CoS
[~] Sequence Counter          (encode/parse yes, gap/reorder detection no)
[~] I/O Timeout                (single global timeoutMs, not I/O-connection-specific)
[ ] IGMP

[x] Port Segment
[x] Logical Segment
[ ] Symbolic Segment           (deferred, Rockwell-specific)
[ ] Data Segment                (used once, ad hoc, not a formal path.js primitive)
[ ] Extended Segment
[x] Multi-hop Routing          (encodeRoutePath with port hops, live round-trip)

[x] BOOL                       (generic bit indexing & packed-bit mask resolver, src/cip/types.js)
[x] SINT / INT / DINT / LINT / USINT / UINT / UDINT / ULINT / REAL / LREAL
       (centralized Data Type System, src/cip/types.js)
[x] STRING                     (SHORT_STRING & CIP STRING, src/cip/types.js)
[ ] ARRAY
[ ] STRUCT

[ ] Fragmentation
[ ] Partial Transfer
[ ] Large Data

[x] TCP stream reassembly
[x] Concurrent requests        -- live-validated, see §40
[x] Request correlation        -- 8-byte Sender Context Map
[~] Timeout                    (single global knob, see §37)
[ ] Retry
[ ] Reconnect
[x] Backpressure               -- maxInFlight pipeline queue, see §41
[ ] Resource limits

[x] Malformed packet handling   (per-layer, not fuzz-proven)
[x] Invalid path handling
[x] Invalid service handling
[x] Invalid length handling
[x] Additional status handling

[ ] Packet logging
[ ] Wireshark verification      (informal manual verification only)
[x] Automated conformance tests (211 unit tests across 13 suites)
[~] Interoperability tests      (2 real devices, 1 vendor)
[ ] Long-running stability tests

--- Rockwell Extension (deferred, not a current priority) ---

[ ] Read Tag 0x4C
[ ] Write Tag 0x4D
[ ] Read Tag Fragmented 0x52
[ ] Write Tag Fragmented 0x53
[ ] Symbol Object 0x6B
[ ] Template Object 0x6C
[ ] UDT decoding
[ ] Symbol browsing
[ ] Program-scoped tags
[ ] Controller-scoped tags
[ ] Array indexing
[ ] Structure member addressing
```

### What this means in practice

The vendor-neutral **core is solid for its current scope**: encapsulation,
discovery, unconnected explicit messaging, Forward_Open/Close, and Class 1
UDP I/O are all real, live-validated against genuinely different hardware.
Sender Context correlation (§40) and request queueing with `maxInFlight`
backpressure (§41) are fully implemented and live-verified on real hardware.

The primary structural features remaining for full ODVA compliance are:
1. **§7/§25/§33 (Get_Attributes_All 0x01, Multiple Service Packet 0x0A, Fragmentation 0x06)** —
   request batching and standard multi-attribute querying.
2. **§4 (SendUnitData 0x0070)** — connected explicit messaging (Class 3).
3. **§19/§20 (Port Segment & Multi-hop Routing)** — routing across backplanes and bridges.

Everything Rockwell-specific (§22/24/26/27/32/54, and the Rockwell
Extension block above) is intentionally untouched — not a gap in the
current plan, a deliberate scope boundary while Delta work is the
priority.

## Source layout

```
src/
  constants.js                — encapsulation commands/status, CIP general
                                 status codes (full Vol 1 Appx B table),
                                 common services, class codes            ✅
  encapsulation/
    header.js                 — 24-byte header encode/decode, TCP-safe
                                 framing (decodeMessage returns null on
                                 an incomplete buffer)                   ✅
    cpf.js                     — Common Packet Format, generic item list ✅
    identity.js                 — Identity item / Socket Address decode  ✅
    session.js                   — RegisterSession / UnRegisterSession   ✅
    discovery.js                  — ListIdentity (UDP broadcast/unicast
                                     + TCP)                              ✅
    rrdata.js                       — SendRRData wrap/unwrap             ✅
  cip/
    path.js                    — padded EPATH, Logical Segments & Port Segments (multi-hop) ✅
    message-router.js           — request/response framing              ✅
    connection-manager.js         — Forward_Open, Large_Forward_Open (0x5B), Forward_Close ✅
    io-connection.js               — full-duplex cyclic UDP 2222 engine, 32-bit Run/Idle, SequenceTracker ✅
    multiple-service.js             — Multiple Service Packet (0x0A) batching codec ✅
    types.js                        — centralized CIP data types, packed bits & strings ✅
    eds.js                          — ODVA standard EDS file parser & device capability matcher ✅
    fragmentation.js                — CIP fragmentation engine, FragmentReader/Writer (0x06) ✅
    objects/
      identity.js                    — server-side Identity Object       ✅
      assembly.js                     — server-side Assembly Object with chunked transfer ✅
      tcp-ip.js                       — TCP/IP Interface Object (0xF5)   ✅
      ethernet-link.js                — Ethernet Link Object (0xF6)      ✅
  logix/
    tag-service.js               — placeholder, nothing implemented    ⏸
  delta/                        — see src/delta/README.md              ✅ (current focus)
adapter.js, adapter/            — Phase 3 EIP Adapter (server side):
                                   sessions, CIP dispatch, Forward_Open
                                   acceptance — loopback-validated       ✅
```

## Compliance principle: vendor-neutral by design

The core (encapsulation, message router, generic CIP object model,
Forward Open/Close, implicit I/O) is built to work with **any**
ODVA-conformant device, verified against two genuinely different real
PLCs, not assumed from one vendor's behavior. Rockwell/Logix extensions
belong in `src/logix/` as an additive layer, never a prerequisite for the
generic path — Delta's own vendor layer (`src/delta/`) proves this split
already works in practice for a non-Rockwell vendor.
