# @kufayeka/ethernet-ip

Implementasi protokol **EtherNet/IP (CIP)** untuk Node.js, mengacu pada spesifikasi *CIP Networks
Library* (Vol 1: *Common Industrial Protocol*, Vol 2: *EtherNet/IP Adaptation of CIP*). Paket ini
bersifat internal/privat (lihat `package.json`), digunakan di dalam monorepo ini — belum
dipublikasikan ke npm registry publik.

Pustaka ini menyediakan dua peran yang dapat dipakai secara terpisah maupun bersamaan:

1. **Client / Scanner** — menghubungkan aplikasi Node.js ke PLC atau perangkat EtherNet/IP: membaca/menulis register, membaca/menulis symbolic tag, batch operation, real-time subscription, serta Class 1 I/O.
2. **Virtual Device Builder (Adapter/Server)** — menjalankan proses Node.js sebagai perangkat EtherNet/IP (adapter) yang dapat di-*discover*, file EDS-nya di-*import*, dan dihubungkan oleh PLC/SCADA. Digunakan untuk simulasi perangkat, pengujian, atau menjembatani sistem non-EIP agar tampak sebagai perangkat EtherNet/IP di sisi PLC.

Ringkasnya:
- Untuk membaca/menulis PLC dari Node.js atau Node-RED, gunakan sisi **Client**.
- Untuk membuat simulator perangkat EtherNet/IP, atau menjadikan proses Node.js sebagai device yang dapat dihubungkan PLC, gunakan sisi **DeviceBuilder (Virtual Device)**.

## Status & Batasan Pengujian

Penting dibaca sebelum menganggap bagian mana pun dari pustaka ini sebagai "resmi ODVA":

- **Belum pernah melalui ODVA Conformance Test** (alat/proses sertifikasi resmi ODVA). Implementasi di sini dibangun berdasarkan pembacaan spesifikasi publik dan pengujian sendiri, bukan hasil sertifikasi pihak ketiga.
- Dasar pengujian yang benar-benar ada: test suite otomatis (`npm test`, lihat [§6](#6-menjalankan-test-suite)) dan pengujian langsung terhadap PLC **Delta ES2 dan SX3** sungguhan. Interoperabilitas dengan perangkat vendor lain (Rockwell, Omron, dan sejenisnya) **belum diverifikasi terhadap hardware asli** — dukungan untuk vendor lain di level protokol mengikuti spesifikasi CIP yang bersifat umum, dan profil register (`delta:es2`, `delta:sx3`, `rockwell:logix`, dan sejenisnya) hanya memetakan alamat/tipe data, bukan bukti kompatibilitas hardware.
- Sebagian kecil kode secara eksplisit mem-port logika dari **[OpENer](https://github.com/EIPStackGroup/OpENer)** (reference stack ODVA yang sudah lulus conformance test) — di titik-titik itu saja, ditandai pada komentar kode dan tabel di bawah. Ini bukan klaim bahwa seluruh pustaka setara OpENer.

## Daftar Isi

1. [Fitur & Status Implementasi](#1-fitur--status-implementasi)
2. [Arsitektur](#2-arsitektur)
3. [Instalasi / Pemakaian](#3-instalasi--pemakaian)
4. [Tutorial A — Penggunaan sebagai Client/Scanner](#4-tutorial-a--penggunaan-sebagai-clientscanner)
5. [Tutorial B — Membangun Virtual EtherNet/IP Device (DeviceBuilder)](#5-tutorial-b--membangun-virtual-ethernetip-device-devicebuilder)
6. [Menjalankan Test Suite](#6-menjalankan-test-suite)
7. [Keterbatasan yang Diketahui](#7-keterbatasan-yang-diketahui)
8. [Dokumentasi Lanjutan & Sumber Rujukan](#8-dokumentasi-lanjutan--sumber-rujukan)

---

## 1. Fitur & Status Implementasi

Legenda:
- ✅ Diimplementasikan dan dicakup oleh test otomatis (lihat [§6](#6-menjalankan-test-suite)), dan/atau diuji langsung terhadap PLC Delta ES2/SX3 sungguhan.
- 🔶 Implementasi dasar/parsial — misalnya hanya mengembalikan atribut statis/konfigurasi tanpa perilaku protokol penuh, atau berlaku dengan catatan penting (lihat kolom Catatan).
- ❌ Belum diimplementasikan.

### 1.1 Encapsulation Layer (CIP Vol 2)

| Fitur | Status | Catatan |
|---|---|---|
| RegisterSession / UnregisterSession | ✅ | |
| SendRRData (Unconnected Explicit Messaging) | ✅ | |
| SendUnitData (Connected Explicit Messaging) | ✅ | Adapter menerima & menjawabnya (Forward_Open Class 3 ke Message Router + SendUnitData); Scanner dapat mengirimkannya via `scanner.openExplicitConnection()` + `scanner.sendConnected()` |
| NOP (heartbeat) | ✅ | |
| ListIdentity (UDP broadcast/unicast discovery) | ✅ | `Scanner.discover()`, `Scanner.discoverAt()` |
| ListServices | ✅ | |
| Validasi Session Handle pada SendRRData/SendUnitData | ✅ | Diporting dari `CheckRegisteredSessions()` OpENer — session handle yang belum atau sudah tidak terdaftar ditolak dengan `InvalidSessionHandle` (0x0064) |

### 1.2 CIP Object Model (Vol 1)

| Object (Class) | Status | Catatan |
|---|---|---|
| Identity Object (0x01) | ✅ | Get_Attribute_Single/All, Class-level Instance-0 attributes (Revision/Max Instance/Number of Instances — CIP Vol 1 §4-4.4), Reset service (0x05) diporting dari `IdentityObjectPreResetCallback` OpENer |
| Message Router (0x02) | ✅ | Routing service ke seluruh object class terdaftar, termasuk Multiple Service Packet |
| Assembly Object (0x04) | ✅ | Instance-0 class attributes, size-mismatch enforcement (`TooMuchData`) sesuai perilaku empiris hardware Delta yang diuji |
| Connection Manager (0x06) | ✅ | Forward_Open, Forward_Close, Large_Forward_Open (0x5B, hingga 65535 byte) |
| ↳ Electronic Key Segment validation | ✅ | Diporting field-per-field dari `CheckElectronicKeyData()` OpENer — strict keying (Major/Minor = 0 sebagai wildcard) dan compatible keying (Major harus persis sama, Minor > 0 dan ≤ minor perangkat) |
| ↳ Duplicate Forward_Open handling | ✅ | Default: lenient — menggantikan koneksi lama dari originator yang sama. Opsional: `strictDuplicateConnections: true` untuk perilaku ODVA-strict, menolak duplikat dengan status 0x0100 (CIP Vol 1 §3-5.5.3) |
| ↳ Connection type: Exclusive-Owner / Input-Only / Listen-Only | ✅ | Diporting dari `appcontype.c` OpENer — klasifikasi berdasarkan slot (O→T, T→O) yang didaftarkan per profil koneksi. Listen-Only ditolak dengan `0x0119` bila belum ada koneksi "master"; Exclusive-Owner kedua ke T→O yang sama dari originator berbeda ditolak dengan `0x0106` (Ownership Conflict) |
| ↳ Production Trigger: Cyclic | ✅ | Mengirim T→O tanpa syarat pada setiap RPI |
| ↳ Production Trigger: Change of State | ✅ | Polling lebih cepat dari RPI, hanya mengirim bila data berubah atau RPI telah terlampaui (RPI berlaku sebagai interval maksimum, bukan interval tetap — CIP Vol 1 §3-4.5.2) |
| ↳ Production Trigger: Application Object | ✅ | Diporting dari `TriggerConnections()` OpENer — tidak ada timer otomatis; produksi hanya terjadi saat aplikasi memanggil `adapter.triggerProduction(instance)` / `builder.triggerConnection(name)` secara eksplisit |
| ↳ Multicast Class 1 Connection (T→O) | ✅ | Alamat multicast dihitung dari IP/netmask device sendiri (CIP Vol 2 §3-5.3, formula dari `CipTcpIpCalculateMulticastIp()` OpENer), diekspos di TCP/IP Object Attribute 9. Forward_Open dari Originator di luar subnet ditolak (`0x0813`). Koneksi multicast pertama ke satu instance T→O jadi "owner"; koneksi berikutnya ke instance yang sama jadi "follower" yang berbagi stream & `toNetworkConnectionId` yang sama |
| TCP/IP Interface Object (0xF5) | ✅ | Instance-0 dan Attr 1 (Status), 2 (Config Capability), 3 (Config Control), 4 (Physical Link), 5 (Interface Config), 6 (Host Name), 13 (Inactivity Timeout) |
| Ethernet Link Object (0xF6) | ✅ | Instance-0 dan Attr 1 (Speed), 2 (Flags), 3 (MAC), 10 (Label), 11 (Capability) |
| Parameter Object (0x0F) | ✅ | Get/Set_Attribute_Single, access control (penegakan read-only), digunakan oleh `DeviceBuilder.addParam()` |
| QoS Object (0x48) | 🔶 | Menyimpan & mengembalikan nilai DSCP (Get/Set_Attribute_Single); tidak benar-benar menandai paket keluar dengan DSCP tersebut di level socket |
| Port Object (0xF4) | 🔶 | Attribute dasar (Port Type, Port Number, Link Object, Node Address) sesuai struktur STRUCT CIP; tidak memodelkan multi-port device |
| Device Level Ring — DLR (0x47) | 🔶 | Attribute dasar (Network Topology, Network Status, Ring Supervisor Status/Config) dapat dibaca/ditulis; tidak ada logika beacon/ring-supervisor sungguhan — nilai bersifat statis/dikonfigurasi manual, bukan hasil deteksi topologi nyata |
| Symbol Object (0x6B) — penelusuran/discovery tag | ❌ | Perangkat Delta SX3 yang diuji juga tidak memiliki object ini (dikonfirmasi dari EDS resminya) — nama tag pada software konfigurasi PLC dimasukkan manual, bukan dipilih dari daftar |
| Vendor-Specific: Delta Register Objects (0x350–0x359, 0x370–0x376) | ✅ | Bukan bagian standar ODVA — pemetaan proprietary Delta untuk register D/Y/M/X dan sejenisnya |
| Generic CIP Object (custom class) | ✅ | `GenericCipObject` — memungkinkan pembuatan object class kustom dengan attribute bebas |

### 1.3 Data & Addressing (Vol 1 Appendix C / §26–§31)

| Fitur | Status | Catatan |
|---|---|---|
| EPATH encode/decode (Logical, Port, Data Segment) | ✅ | |
| Electronic Key Segment encode/decode | ✅ | Struktur 10 byte sesuai CIP Vol 1 Appendix C-1.4.5.2, dicakup unit test roundtrip |
| ANSI Extended Symbol Segment (0x91) — symbolic tag addressing | ✅ | Contoh: `"TotalCount"`, `"Motor.Speed"`, `"Tanks[3]"` |
| Explicit Messaging ke symbolic tag (Get/Set_Attribute_Single langsung berdasarkan nama) | ✅ | |
| Produced/Consumed Tag Class 1 I/O Connection (symbolic Forward_Open) | ✅ | Resolusi `path.tagPath` saat runtime di `ConnectionHandler`, terikat ke arah Consumed/Produced/keduanya. Catatan interoperabilitas dengan Delta EIP Builder: lihat [§7](#7-keterbatasan-yang-diketahui) |
| CIP Elementary Data Types (BOOL, SINT, INT, DINT, LINT, USINT, UINT, UDINT, ULINT, REAL, LREAL, BYTE/WORD/DWORD/LWORD) | ✅ | |
| CIP STRING & SHORT_STRING | ✅ | |
| Bit-level access & packed boolean (member Assembly `bitLength`) | ✅ | |
| Fragmentation (Partial Transfer, 0x06) untuk attribute berukuran besar | ✅ | `readLargeAttribute()` / `writeLargeAttribute()` |
| Multiple Service Packet (0x0A) | ✅ | Otomatis fallback ke request satu per satu apabila perangkat tidak mendukungnya |

### 1.4 EDS (Electronic Data Sheet)

| Fitur | Status | Catatan |
|---|---|---|
| EDS Parser (`EdsFile`) | ✅ | Mem-parse `[File]`, `[Device]`, `[Params]`, `[Assembly]`, `[Connection Manager]` |
| EDS Exporter (`DeviceBuilder.generateEds()`) | ✅ | Format dicocokkan terhadap struktur EDS resmi Delta SX3 (lihat `eds/031F000E0F0600010001.eds` di repo ini). Belum diuji dengan tool validasi EDS resmi ODVA |
| Pembentukan parameter Forward_Open langsung dari EDS | ✅ | `scanner.openConnectionFromEds(eds, connectionName)` |

### 1.5 Real-Time & Robustness

| Fitur | Status | Catatan |
|---|---|---|
| Class 1 I/O cyclic producer/consumer (UDP 2222) | ✅ | |
| Connection (Inactivity) Watchdog — Target mendeteksi Originator diam | ✅ | CIP Vol 1 §3-4.5.3/§5-4.4: `otRpiUs * connectionTimeoutMultiplier` (multiplier didekode dari byte wire Forward_Open sesuai CIP Vol 1 Table 3-5.16, bukan dipakai mentah) |
| Encapsulation Session Inactivity Timeout | ✅ | CIP Vol 2 §2-4.6, TCP/IP Interface Object Attribute 13 |
| Auto-reconnect session (pemulihan setelah TCP terputus) | ✅ | |
| Real-time Tag Subscription (`Subscription`) — mode polling (TCP) dan UDP realtime | ✅ | Event `change`, `change:<tag>`, `cyclic`, `error` |

---

## 2. Arsitektur

```
+-------------------------------------------------------------------------+
|        APLIKASI (Node-RED, SCADA, skrip khusus, atau Virtual Device)    |
+-------------------------------------------------------------------------+
|   Device / DeviceProfile / BatchBuilder   |   DeviceBuilder (Adapter)   |
|   (sisi CLIENT: membaca/menulis register) |   (sisi SERVER: perangkat)  |
+-------------------------------------------------------------------------+
|                CIP (Common Industrial Protocol) — Layer 7               |
|      Object Model: Class ID -> Instance ID -> Attribute ID              |
+-------------------------------------------------------------------------+
|                 EtherNet/IP Encapsulation Layer                         |
|      24-byte Header, RegisterSession, SendRRData, SendUnitData          |
+-------------------------------------------------------------------------+
|            TCP/IP & UDP Transport (Ethernet standar)                    |
|      Port 44818 (Explicit Messaging & Session)                          |
|      Port 2222  (Implicit / Class 1 Cyclic I/O)                         |
+-------------------------------------------------------------------------+
```

Dua konsep kunci:

- **Explicit Messaging (TCP 44818)** — pola request/response, membawa alamat lengkap (`Class`, `Instance`, `Attribute`). Digunakan untuk pembacaan/penulisan satuan, pembacaan identity, dan konfigurasi.
- **Implicit / Class 1 I/O (UDP 2222)** — streaming data biner secara berkala pada interval tertentu (RPI, misalnya setiap 10–50 ms), satu arah atau dua arah, tanpa alamat CIP pada setiap paket (disebut "implicit" karena alamat telah disepakati sekali di awal melalui `Forward_Open`). Digunakan untuk drive, sensor, modul I/O, dan sinkronisasi antar-PLC.

---

## 3. Instalasi / Pemakaian

Paket ini `"private": true` (lihat `package.json`) — tidak dipublikasikan ke npm registry publik. Di dalam monorepo ini, paket dipakai langsung lewat resolusi path Node.js (folder ini berada di bawah `packages/node_modules/@kufayeka/ethernet-ip`), tanpa langkah `npm install` terpisah.

```js
const eip = require('@kufayeka/ethernet-ip');
// atau destructuring:
const { Scanner, Device, DeviceBuilder } = require('@kufayeka/ethernet-ip');
```

Untuk dipakai di luar monorepo ini, salin/`npm link`/referensikan folder ini sebagai dependency lokal (`file:` path) pada `package.json` proyek lain.

---

## 4. Tutorial A — Penggunaan sebagai Client/Scanner

### 4.1 Cara Tercepat: `Device` dengan Profile Terdaftar

Profile yang tersedia saat ini: `delta:es2`, `delta:sx3`, `delta:dvp12se`, `rockwell:logix`. Kelas `Device` menggunakan profile ini untuk menerjemahkan nama register (`D0`, `Y10`, dan sejenisnya) menjadi EPATH CIP yang sesuai. Profile Delta (`es2`/`sx3`/`dvp12se`) diuji terhadap hardware Delta sungguhan; profile `rockwell:logix` memetakan alamat berdasarkan dokumentasi publik, belum diuji terhadap PLC Rockwell sungguhan.

```js
const { Device } = require('@kufayeka/ethernet-ip');

async function main() {
    const plc = new Device('192.168.68.111', 'delta:sx3');
    await plc.connect();

    // Membaca register D (16-bit INT secara default)
    const speed = await plc.readD(0);          // D0
    console.log('D0 =', speed);

    // Menulis register D
    await plc.writeD(1, 1234);                 // D1 = 1234

    // Membaca/menulis bit coil (Y = output, M = internal relay)
    await plc.writeYBit(0, true);               // Y0 = ON
    const state = await plc.readMBit(10);        // membaca M10

    // Akses generik melalui read()/write() (dipakai secara internal oleh method di atas)
    const total = await plc.read('D', 100);

    await plc.disconnect();
}

main().catch(console.error);
```

> Method `readD`/`writeD`/`readYBit`/`writeYBit`, dan sejenisnya di-generate otomatis berdasarkan nama register yang didaftarkan pada tiap profile.

### 4.2 Batch Operation (satu round-trip untuk banyak register)

Digunakan ketika diperlukan pembacaan beberapa register sekaligus tanpa satu round-trip TCP per register:

```js
const results = await plc.batch((b) => {
    b.readD(0);
    b.readD(1);
    b.readD(100, { mode: 'dint' });
    b.readYBit(0);
});
console.log(results); // array nilai, urutan sesuai urutan pemanggilan method
```

Mekanisme ini menggunakan CIP **Multiple Service Packet (0x0A)**. Apabila perangkat tidak mendukungnya, sistem melakukan fallback ke request satu per satu secara transparan.

### 4.3 Real-Time Tag Subscription (Watcher)

Untuk memantau nilai yang berubah secara real-time (dashboard, alarm, trending):

```js
const sub = plc.createSubscription({
    mode: 'polling',      // atau 'udp' untuk mode Class 1 I/O real-time
    interval: 100,        // ms, khusus mode polling
    tags: ['D0', 'D1:REAL', 'Y0']
});

sub.on('change', (tag, newVal, oldVal) => {
    console.log(`${tag}: ${oldVal} -> ${newVal}`);
});
sub.on('error', (err) => console.error(err));

await sub.start();
```

### 4.4 Level Rendah: `Scanner`

`Scanner` adalah lapisan di bawah `Device`, dapat digunakan langsung terhadap perangkat EtherNet/IP mana pun selama Class/Instance/Attribute yang dituju diketahui. Berguna apabila PLC target belum memiliki profile terdaftar, atau diperlukan kontrol yang lebih rinci.

```js
const { Scanner } = require('@kufayeka/ethernet-ip');

const scanner = new Scanner('192.168.68.111');
await scanner.connect();

// Membaca Identity Object (Class 0x01) — selalu tersedia pada semua perangkat CIP
const identity = await scanner.getIdentity();
console.log(identity); // { vendorId, productCode, productName, revision, ... }

// Get/Set attribute generik — dapat menyasar object class apa pun
const raw = await scanner.getAttribute({ classId: 0x04, instance: 101, attribute: 3 });
await scanner.setAttribute({ classId: 0x04, instance: 100, attribute: 3, data: Buffer.from([1, 2, 3, 4]) });

// Membaca/menulis symbolic tag (gaya ControlLogix, atau ke virtual device — lihat Tutorial B)
const val = await scanner.readTag('TotalCount', { dataType: 'DINT' });
await scanner.writeTag('Heartbeat', 42, { dataType: 'DINT' });

await scanner.disconnect();
```

### 4.5 Discovery (menemukan perangkat di jaringan)

```js
const { Scanner } = require('@kufayeka/ethernet-ip');

// Broadcast ListIdentity ke seluruh network interface lokal
const devices = await Scanner.discover({ timeoutMs: 2000 });
console.log(devices); // [{ address, vendorId, productName, ... }, ...]

// Atau menyapu satu subnet secara eksplisit (lebih andal pada Wi-Fi/managed switch)
const found = await Scanner.scanSubnet({ subnet: '192.168.68.0/24', timeoutMs: 3000 });
```

### 4.6 Class 1 I/O Langsung dari EDS

Untuk perangkat target yang memiliki file `.eds` resmi (drive, remote I/O, dan sejenisnya — bukan PLC dengan peta register proprietary):

```js
const { Scanner, EdsFile } = require('@kufayeka/ethernet-ip');

const eds = EdsFile.fromFile('path/to/device.eds');
const scanner = new Scanner('192.168.1.50');
await scanner.connect();

const connection = await scanner.openConnectionFromEds(eds, 'Connection1', { rpiUs: 10000 });
const io = scanner.createIoConnection(connection);

io.on('data', (buf) => console.log('T->O data:', buf));
io.setOutput(Buffer.from([0x01, 0x00, 0x00, 0x00])); // mengirim O->T
```

> **EDS dibandingkan `DeviceProfile`**: EDS resmi dari pabrikan tidak memuat peta register internal PLC (D/Y/M/X) — hanya mengetahui, misalnya, "Assembly 101 = buffer 32 byte" tanpa mengetahui isinya. `DeviceProfile` adalah lapisan tambahan pada pustaka ini yang mengisi kekosongan tersebut. Untuk membaca/menulis register PLC, gunakan `Device` dengan profile (lihat 4.1), bukan EDS.

---

## 5. Tutorial B — Membangun Virtual EtherNet/IP Device (DeviceBuilder)

Bagian ini menjelaskan cara menjadikan proses Node.js sebagai perangkat EtherNet/IP yang dapat di-*discover*, file EDS-nya di-*import* ke software konfigurasi PLC (Delta EIP Builder / DIADesigner-AX, RSLogix, dan sejenisnya), serta dihubungkan oleh PLC/SCADA melalui jaringan. Alur ini diuji end-to-end terhadap Delta EIP Builder + PLC Delta SX3 sungguhan; interoperabilitas dengan software konfigurasi vendor lain belum diverifikasi.

### 5.1 Konsep

```
DeviceBuilder
  ├── setIdentity()       -> Vendor ID, Product Code, Device Type, Revision (untuk Electronic Key)
  ├── addParam()           -> CIP Parameter Object (0x0F) — menjadi kolom pada layar parameter
  ├── addTag()              -> Symbolic Tag — explicit messaging & Produced/Consumed Tag connection
  ├── defineAssembly()      -> Buffer biner Class 1 I/O (untuk koneksi cyclic UDP 2222)
  ├── defineConnection()    -> Deklarasi profil koneksi pada EDS (muncul pada daftar "Connection")
  ├── generateEds()         -> Menghasilkan file .eds
  └── createAdapter()       -> Menjalankan server EtherNet/IP (TCP 44818 + UDP 2222)
```

### 5.2 Langkah 1 — Menentukan Identity

```js
const { DeviceBuilder } = require('@kufayeka/ethernet-ip');

const builder = new DeviceBuilder({
    vendorId: 799,                          // Vendor ID resmi (mis. 799 = Delta Electronics) agar dikenali software vendor terkait
    vendorName: 'Delta Electronics, Inc.',
    productCode: 1,                         // ID unik produk
    productName: 'Kufayeka Smart Node',
    deviceType: 'Generic Device',           // atau 'AC Drive', 'PLC', dan sejenisnya — memengaruhi ikon & kategori pada software konfigurasi
    catalog: 'KUF-NODE-01',
    revision: { major: 1, minor: 0 },
    description: 'Virtual EtherNet/IP Device untuk pengujian & simulasi'
});
```

> **Catatan mengenai Revision**: software konfigurasi PLC (misalnya Delta EIP Builder) melakukan *cache* pada device library berdasarkan kombinasi Vendor ID + Product Code + Device Type + Revision. Apabila struktur parameter/assembly perangkat diubah tanpa menaikkan `revision`, software konfigurasi bisa saja masih menggunakan data lama yang tersimpan pada cache. Solusinya: naikkan `revision` (atau `productCode`) setiap kali struktur perangkat berubah, lalu re-import EDS pada device library di software konfigurasi (hapus entri lama, tambahkan entri baru) — bukan sekadar menimpa file `.eds` di disk.

### 5.3 Langkah 2 — Menambahkan Parameter (CIP Class 0x0F)

Parameter muncul pada layar parameter di software konfigurasi, dapat dibaca/ditulis satu per satu melalui explicit messaging, dan dapat dipetakan ke dalam Assembly (lihat langkah 5.5).

```js
builder.addParam({
    code: '01-00',
    name: 'TargetFrequency',
    dataType: 'INT',            // BOOL, SINT, INT, DINT, UINT, UDINT, REAL, STRING
    units: '0.01 Hz',
    min: 0,
    max: 30000,
    default: 100,
    access: 'rw',                // 'r', 'w', atau 'rw'
    help: 'Target frequency command'
});

builder.addParam({
    code: '03-00',
    name: 'ActualFrequency',
    dataType: 'INT',
    units: '0.01 Hz',
    default: 0,
    access: 'r',                 // read-only — tidak dapat ditulis oleh PLC
    help: 'Feedback frequency dari motor'
});
```

Untuk parameter `BOOL`, `min`/`max`/`default` pada file EDS yang dihasilkan selalu numerik 0/1 — nilai runtime (`getParamValue()`/`setParam()`) tetap dapat memakai boolean JavaScript (`true`/`false`) maupun numerik.

### 5.4 Langkah 3 — Menambahkan Symbolic Tag (opsional, untuk MES/SCADA key-value)

Tag berbeda dari Parameter: tidak muncul pada layar parameter, tetapi dapat diakses langsung melalui nama string (`readTag`/`writeTag`) dan dapat dijadikan **Produced/Consumed Tag Connection** (Class 1 I/O berbasis nama, bukan Assembly instance berupa angka).

```js
builder.addTag('Heartbeat', 'DINT', 0);
builder.addTag('CommandCode', 'INT', 10);
builder.addTag('PartCounter', 'DINT', 0);
builder.addTag('MES_BatchId', 'STRING', 'BATCH-2026-ALPHA'); // STRING tetap dapat diakses via explicit messaging, tetapi tidak dapat dijadikan Tag Connection (lihat §7)
```

### 5.5 Langkah 4 — Menentukan Assembly (buffer Class 1 I/O)

Assembly adalah buffer byte mentah yang dikirim/diterima secara cyclic melalui UDP 2222. `type: 'output'` merepresentasikan data yang dikirim PLC ke perangkat (O→T, umumnya parameter yang dapat ditulis), sedangkan `type: 'input'` merepresentasikan data yang dikirim perangkat ke PLC (T→O, umumnya parameter read-only/feedback).

```js
builder.defineAssembly({
    instance: 100,
    name: 'CTRL_PARAM_20B',
    sizeBytes: 20,
    type: 'output',
    members: [
        { paramId: '01-00' }, // ditulis oleh PLC, offset dihitung otomatis secara berurutan
        // ... parameter lainnya
    ]
});

builder.defineAssembly({
    instance: 101,
    name: 'STAT_PARAM_20B',
    sizeBytes: 20,
    type: 'input',
    members: [
        { paramId: '03-00' },
        // ...
    ]
});
```

Member juga dapat berupa bit tunggal (`{ paramId, bitLength: 1 }`), untuk memetakan beberapa parameter `BOOL` ke bit-bit dalam satu byte — cocok untuk beberapa flag boolean sekaligus:

```js
members: [
    { paramId: '02-00', bitLength: 1 }, // bit 0
    { paramId: '02-01', bitLength: 1 }, // bit 1
    { paramId: '02-02', bitLength: 1 }, // bit 2
    { bitLength: 5 }                    // sisa bit tidak dipakai (padding, tanpa paramId)
]
```

Apabila `members` tidak diisi, builder secara otomatis memetakan seluruh parameter yang sesuai (writable untuk `output`, seluruhnya untuk `input`) secara berurutan hingga buffer terisi penuh — tetapi hanya berlaku untuk Assembly instance 100 (output) dan 101 (input); instance lain wajib mendeklarasikan `members` secara eksplisit.

### 5.6 Langkah 5 — Menentukan Connection Profile (muncul pada daftar "Connection" di software konfigurasi)

```js
builder.defineConnection({
    name: 'Parameter System IO (20 Bytes)',
    help: 'Control & Feedback Parameters',
    outputAssembly: 100,   // O->T (Consumed oleh perangkat, ditulis PLC)
    inputAssembly: 101     // T->O (Produced oleh perangkat, dibaca PLC)
});
```

Method ini dapat dipanggil berulang kali untuk beberapa profil koneksi berbeda — seluruhnya akan muncul sebagai opsi terpisah pada daftar "Connection" di software konfigurasi PLC.

> **Trigger Mode**: setiap koneksi dideklarasikan mendukung Cyclic maupun Change-of-State (EDS capability `0x04030002`, sesuai deklarasi perangkat Delta SX3 yang diuji). PLC menentukan mode mana yang dipakai saat `Forward_Open`; perangkat menyesuaikan otomatis — Cyclic mengirim data pada setiap RPI tanpa syarat, Change-of-State mengirim data segera setelah terjadi perubahan (dengan RPI sebagai batas interval maksimum, bukan interval tetap).

### 5.7 Langkah 6 — Menghasilkan EDS & Menjalankan Server

```js
const fs = require('fs');

// 1. Menghasilkan file .eds
const edsText = builder.generateEds();
fs.writeFileSync('MyDevice.eds', edsText);

// 2. Menjalankan server EtherNet/IP
const adapter = builder.createAdapter({
    port: 44818,           // TCP/UDP encapsulation
    ioPort: 2222,           // UDP Class 1 I/O
    address: '0.0.0.0',    // bind ke seluruh interface (atau IP spesifik)
    strictDuplicateConnections: false // true = perilaku ODVA-strict (menolak Forward_Open duplikat)
});

await adapter.start();
console.log('Virtual EIP Device berjalan pada', adapter.address, '- import MyDevice.eds ke software konfigurasi PLC');
```

### 5.8 Langkah 7 — Memantau dan Merespons Aktivitas PLC

```js
builder.watch({
    logParams: true,   // mencatat setiap penulisan parameter oleh PLC
    logTags: true,     // mencatat setiap penulisan tag oleh PLC
    logAssembly: false // false = tidak mencatat setiap paket cyclic (mencegah log berlebihan)
});

// Event granular untuk penanganan kustom
builder.on('paramChange', (code, newVal, oldVal, param, source) => {
    if (code === '01-00') {
        console.log('PLC meminta frequency baru:', newVal);
        // ... tempat memicu aksi nyata, misalnya mengirim perintah ke motor sesungguhnya
    }
});

builder.on('tagWrite', (name, value) => {
    console.log(`Tag "${name}" ditulis menjadi`, value);
});

// Memperbarui nilai dari sisi perangkat (inisiatif perangkat, misalnya dari sensor sesungguhnya)
builder.setParam('03-00', 4500);     // memperbarui parameter feedback
builder.setTag('Heartbeat', Date.now() % 100000);
```

### 5.9 Konfigurasi pada Software PLC (contoh: Delta EIP Builder / DIADesigner-AX)

1. Jalankan skrip Node.js (`node my-device.js`) — perangkat listening pada TCP 44818 dan UDP 2222.
2. Pada software konfigurasi PLC, buka Network View / Device Library, klik kanan → **Add Device** → **Import EDS** → pilih file `.eds` yang dihasilkan pada langkah 5.7.
3. Atur **Node IP Address** sesuai alamat IP tempat skrip dijalankan.
4. Buka **Data Exchange** / **Connection Setting**, pilih Connection Profile yang telah dibuat pada langkah 5.6, atur RPI dan Trigger Mode.
5. Apabila perangkat pernah di-*import* sebelumnya dan strukturnya diubah (parameter/assembly/revision) — hapus entri perangkat lama dari library, kemudian import ulang dari file `.eds` terbaru. Software konfigurasi umumnya melakukan cache perangkat berdasarkan Vendor ID + Product Code + Device Type; menimpa file `.eds` di disk saja tidak otomatis memperbarui data yang sudah tersimpan pada cache.
6. Download konfigurasi ke PLC, kemudian jalankan (RUN). Terminal Node.js akan menampilkan log setiap koneksi serta setiap penulisan parameter/tag dari PLC apabila `watch()` diaktifkan.

---

## 6. Menjalankan Test Suite

```bash
npm test
```

Saat penulisan ini, test suite (Mocha) berisi 347 test yang mencakup: encode/decode pada setiap lapisan protokol, seluruh CIP object yang diimplementasikan, validasi Electronic Key & session (sebagian diporting dari OpENer), EDS parser & exporter (roundtrip terhadap file EDS Delta SX3), Class 1 I/O (numeric dan symbolic tag, cyclic dan change-of-state), auto-reconnect, serta integrasi client–adapter end-to-end pada localhost. Jumlah ini akan berubah seiring waktu — jalankan `npm test` untuk angka yang akurat.

---

## 7. Keterbatasan yang Diketahui

Poin-poin berikut adalah temuan nyata dari pengujian terhadap software konfigurasi Delta EIP Builder dan PLC Delta sungguhan (ES2/SX3), bukan kelalaian yang belum sempat diperbaiki.

- **Tidak tersedia Symbol Object (0x6B) untuk penelusuran tag.** Kolom nama tag pada software konfigurasi (misalnya "Slave Register/Parameter/Variable" pada layar Data Exchange Delta EIP Builder) bersifat isian teks manual — tidak ada daftar pilihan/autocomplete yang membaca daftar tag dari perangkat. Perangkat Delta SX3 yang diuji juga tidak memiliki Symbol Object (dikonfirmasi dari EDS resminya). Nama yang dimasukkan pada software konfigurasi harus sama persis (case-sensitive) dengan nama yang didaftarkan melalui `addTag()`.
- **Ukuran (Length) pada Produced/Consumed Tag Connection harus dicocokkan secara manual.** Kolom "Length" pada software konfigurasi mengikuti tipe data variabel yang dipilih pada sisi PLC (Master), bukan dibaca otomatis dari perangkat. Apabila tag pada perangkat bertipe `DINT` (4 byte), variabel PLC yang dipasangkan juga harus bertipe 4 byte; jika tidak, Forward_Open akan ditolak dengan connection size mismatch (extended status `0x0109`). Tidak ada mekanisme negosiasi ukuran otomatis.
- **Symbolic tag bertipe STRING tidak dapat dijadikan Produced/Consumed Tag Connection.** CIP Parameter, yang menjadi acuan ukuran pada EDS, bersifat fixed-size dengan Min/Max/Default numerik sehingga tidak sesuai untuk string dengan panjang variabel. Tag STRING tetap dapat diakses melalui explicit messaging (`readTag`/`writeTag`).
- **Menghubungkan perangkat ini sebagai client ke Produced Tag milik PLC sungguhan (arah sebaliknya — perangkat ini bertindak sebagai Scanner, PLC sebagai target) belum terverifikasi.** Format `connectionPath` yang tepat untuk Forward_Open ke Produced Tag pada firmware PLC Delta yang diuji berbeda dari format yang diterima oleh perangkat virtual ini (dicoba dan ditolak dengan extended status `0x0127`, yang menurut manual Delta berarti "configuration path parameters mismatch"). Arah yang terverifikasi dan didukung adalah **PLC (Scanner) menghubungi perangkat virtual (Adapter)**, bukan sebaliknya.
- **Multicast Class 1 I/O dari sisi Scanner belum diimplementasikan.** Pada sisi Adapter, produksi T→O multicast sudah didukung (lihat §1.2); pada sisi Scanner, `IOConnection` selalu mengirim/menerima unicast.
- **Revision perangkat disimpan pada cache oleh software konfigurasi PLC.** Lihat catatan pada [§5.2](#52-langkah-1--menentukan-identity). Apabila perangkat tampak "tidak ter-update" setelah perubahan kode, kemungkinan besar penyebabnya adalah cache pada software konfigurasi, bukan cacat pada generator EDS.

---

## 8. Dokumentasi Lanjutan & Sumber Rujukan

Dokumen ini adalah titik masuk (entry point) yang ringkas. Dokumen lain di repo ini untuk pembahasan lebih dalam:

| Dokumen | Isi |
|---|---|
| [`docs/ODVA_COMPLIANCE_REFERENCE.md`](docs/ODVA_COMPLIANCE_REFERENCE.md) | Kutipan persyaratan Scanner/Adapter dari publikasi ODVA (PUB00070, PUB00213), disandingkan dengan status implementasi proyek ini per-item, sejauh sudah benar-benar diverifikasi. |
| [`docs/VIRTUAL_DEVICE_GUIDE.md`](docs/VIRTUAL_DEVICE_GUIDE.md) | Tutorial lebih rinci membangun Virtual EtherNet/IP Device — tiap opsi `DeviceBuilder`, mode trigger, Tag Connection, serta kejanggalan Delta EIP Builder yang benar-benar ditemui saat pengujian dan tabel troubleshooting kode error terkait. |
| [`docs/VENDOR_GUIDE.md`](docs/VENDOR_GUIDE.md) | Cara membuat `DeviceProfile` untuk vendor/model PLC baru, termasuk menerjemahkan tabel object CIP milik vendor menjadi skema `registers{}`. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Prioritas pengembangan berikutnya, berdasarkan gap yang sudah teridentifikasi. |
| [`docs/REFERENCES.md`](docs/REFERENCES.md) | Daftar bacaan/rujukan yang dipakai menyusun implementasi ini. |
| [`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md) | Catatan historis investigasi & versi README sebelum direstrukturisasi — konteks "bagaimana suatu perilaku ditemukan", bukan rujukan status terkini (lihat §1 di README ini untuk itu). |

**Referensi ODVA yang dipakai** — PUB00070 dan PUB00213 dapat diunduh langsung dari odva.org tanpa autentikasi; CIP Networks Library Volume 1 & 2 (spesifikasi normatif lengkap) memerlukan langganan berbayar dari ODVA dan tidak direproduksi di sini:
- [PUB00070 — Recommended Functionality for EtherNet/IP Devices](https://www.odva.org/wp-content/uploads/2020/05/PUB00070_Recommended-Functionality-for-EIP-Devices-v10.pdf)
- [PUB00213 — EtherNet/IP Quick Start for Vendors Handbook](https://www.odva.org/wp-content/uploads/2020/05/PUB00213R0_EtherNetIP_Developers_Guide.pdf)
- [ODVA Conformance Testing](https://www.odva.org/technology-standards/conformance-testing/)
- [ODVA Document Library](https://www.odva.org/technology-standards/document-library/)
- [OpENer](https://github.com/EIPStackGroup/OpENer) — reference stack ODVA-conformance-tested, dipakai sebagai acuan porting di bagian-bagian yang ditandai pada §1
- [Halaman spesifikasi ODVA (berbayar)](https://www.odva.org/subscriptions-services/specifications/) — untuk CIP Networks Library Volume 1 & 2
