# @kufayeka/ethernet-ip

Implementasi protokol EtherNet/IP (CIP) untuk Node.js, mengacu pada *CIP Networks Library* (Vol 1:
*Common Industrial Protocol*, Vol 2: *EtherNet/IP Adaptation of CIP*). Paket internal (`"private": true`
di `package.json`), dipakai di dalam monorepo ini — belum dipublikasikan ke npm registry publik.

Pustaka ini punya dua peran independen:

- **Client / Scanner** — menghubungkan Node.js ke PLC/perangkat EtherNet/IP: baca-tulis register, symbolic tag, batch operation, subscription real-time, dan Class 1 I/O.
- **DeviceBuilder (Adapter/Server)** — menjalankan proses Node.js sebagai perangkat EtherNet/IP: bisa di-*discover*, EDS-nya di-*import*, dan dihubungkan oleh PLC/SCADA sungguhan. Dipakai untuk simulasi perangkat, pengujian, atau menjembatani sistem non-EIP agar tampak sebagai perangkat EtherNet/IP.

Gunakan sisi **Client** untuk membaca/menulis PLC dari Node.js atau Node-RED. Gunakan **DeviceBuilder**
untuk membuat simulator perangkat, atau menjadikan proses Node.js sebagai device yang dihubungkan PLC.

## Daftar Isi

1. [Status & Batasan Pengujian](#1-status--batasan-pengujian)
2. [Instalasi](#2-instalasi)
3. [Quick Start](#3-quick-start)
4. [Arsitektur](#4-arsitektur)
5. [Panduan Client/Scanner](#5-panduan-clientscanner)
6. [Panduan DeviceBuilder (Virtual Device)](#6-panduan-devicebuilder-virtual-device)
7. [Detail Status Implementasi per Objek CIP](#7-detail-status-implementasi-per-objek-cip)
8. [Keterbatasan yang Diketahui](#8-keterbatasan-yang-diketahui)
9. [Test Suite](#9-test-suite)
10. [Dokumentasi Lanjutan & Sumber Rujukan](#10-dokumentasi-lanjutan--sumber-rujukan)

---

## 1. Status & Batasan Pengujian

Pustaka ini **belum pernah melalui ODVA Conformance Test** (proses sertifikasi resmi ODVA). Implementasinya
dibangun dari pembacaan spesifikasi publik dan pengujian mandiri, bukan hasil sertifikasi pihak ketiga.

Dasar pengujian yang benar-benar ada:
- Test suite otomatis — lihat [§9](#9-test-suite) untuk jumlah dan cakupannya.
- Pengujian langsung terhadap PLC **Delta ES2 dan SX3** sungguhan.

Yang belum diverifikasi: interoperabilitas dengan hardware vendor lain (Rockwell, Omron, dll). Profil
register seperti `rockwell:logix` hanya memetakan alamat/tipe data berdasarkan dokumentasi publik —
bukan bukti kompatibilitas hardware.

Sebagian kecil kode mem-port logika dari **[OpENer](https://github.com/EIPStackGroup/OpENer)** (reference
stack ODVA yang sudah lulus conformance test), ditandai eksplisit pada komentar kode dan pada tabel di
[§7](#7-detail-status-implementasi-per-objek-cip). Ini bukan klaim bahwa seluruh pustaka setara OpENer.

---

## 2. Instalasi

Di dalam monorepo ini, paket dipakai langsung lewat resolusi path Node.js (folder ini berada di
`packages/node_modules/@kufayeka/ethernet-ip`), tanpa langkah instalasi terpisah:

```js
const { Scanner, Device, DeviceBuilder } = require('@kufayeka/ethernet-ip');
```

Untuk dipakai di luar monorepo ini, referensikan folder ini sebagai dependency lokal (`file:` path)
pada `package.json` proyek lain.

---

## 3. Quick Start

### Client — membaca & menulis PLC

```js
const { Device } = require('@kufayeka/ethernet-ip');

const plc = new Device('192.168.68.111', 'delta:sx3');
await plc.connect();

const speed = await plc.readD(0);     // baca D0
await plc.writeD(1, 1234);            // tulis D1 = 1234
await plc.writeYBit(0, true);         // Y0 = ON

await plc.disconnect();
```

Detail lengkap (batch operation, subscription, akses level-rendah via `Scanner`, discovery jaringan,
Class 1 I/O dari EDS): [§5](#5-panduan-clientscanner).

### DeviceBuilder — perangkat virtual

```js
const { DeviceBuilder } = require('@kufayeka/ethernet-ip');

const builder = new DeviceBuilder({ vendorId: 799, productName: 'My Device', revision: { major: 1, minor: 0 } });

builder.addParam({ code: '01-00', name: 'TargetFrequency', dataType: 'INT', min: 0, max: 30000, default: 0, access: 'rw' });
builder.defineAssembly({ instance: 100, sizeBytes: 2, type: 'output', members: [{ paramId: '01-00' }] }); // O->T
builder.defineAssembly({ instance: 101, sizeBytes: 2, type: 'input', members: [{ paramId: '01-00' }] });  // T->O
builder.defineConnection({ name: 'Basic IO', outputAssembly: 100, inputAssembly: 101 });

require('fs').writeFileSync('MyDevice.eds', builder.generateEds());

const adapter = builder.createAdapter({ port: 44818, ioPort: 2222 });
await adapter.start();
```

Detail lengkap (identity/revision, tag, bit-packed assembly, trigger mode, event handling, langkah
konfigurasi di software PLC): [§6](#6-panduan-devicebuilder-virtual-device) dan
[`docs/VIRTUAL_DEVICE_GUIDE.md`](docs/VIRTUAL_DEVICE_GUIDE.md).

---

## 4. Arsitektur

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

- **Explicit Messaging (TCP 44818)** — request/response, membawa alamat lengkap (`Class`, `Instance`, `Attribute`). Dipakai untuk baca/tulis satuan, pembacaan identity, dan konfigurasi.
- **Implicit / Class 1 I/O (UDP 2222)** — streaming data biner berkala pada interval tertentu (RPI), satu atau dua arah, tanpa alamat CIP per paket (alamat disepakati sekali di awal lewat `Forward_Open`). Dipakai untuk drive, sensor, modul I/O, dan sinkronisasi antar-PLC.

---

## 5. Panduan Client/Scanner

### 5.1 `Device` dengan Profile Terdaftar

Profile yang tersedia: `delta:es2`, `delta:sx3`, `delta:dvp12se`, `rockwell:logix`. `Device` memakai
profile ini untuk menerjemahkan nama register (`D0`, `Y10`, dst.) menjadi EPATH CIP. Profile Delta diuji
terhadap hardware sungguhan; `rockwell:logix` belum.

```js
const { Device } = require('@kufayeka/ethernet-ip');

const plc = new Device('192.168.68.111', 'delta:sx3');
await plc.connect();

const speed = await plc.readD(0);
await plc.writeD(1, 1234);
await plc.writeYBit(0, true);
const state = await plc.readMBit(10);
const total = await plc.read('D', 100); // akses generik, dipakai internal oleh method di atas

await plc.disconnect();
```

Method `readD`/`writeD`/`readYBit`/dst. di-generate otomatis dari nama register yang didaftarkan
tiap profile.

### 5.2 Batch Operation

Membaca beberapa register dalam satu round-trip TCP, lewat CIP **Multiple Service Packet (0x0A)**
(fallback otomatis ke request satu-per-satu bila perangkat tidak mendukungnya):

```js
const results = await plc.batch((b) => {
    b.readD(0);
    b.readD(1);
    b.readD(100, { mode: 'dint' });
    b.readYBit(0);
});
```

### 5.3 Subscription Real-Time

```js
const sub = plc.createSubscription({
    mode: 'polling',      // atau 'udp' untuk Class 1 I/O real-time
    interval: 100,        // ms, khusus mode polling
    tags: ['D0', 'D1:REAL', 'Y0']
});

sub.on('change', (tag, newVal, oldVal) => console.log(`${tag}: ${oldVal} -> ${newVal}`));
sub.on('error', (err) => console.error(err));
await sub.start();
```

### 5.4 Level Rendah: `Scanner`

`Scanner` adalah lapisan di bawah `Device` — dipakai langsung ke perangkat apa pun bila Class/Instance/
Attribute tujuan diketahui, atau bila PLC target belum punya profile terdaftar.

```js
const { Scanner } = require('@kufayeka/ethernet-ip');

const scanner = new Scanner('192.168.68.111');
await scanner.connect();

const identity = await scanner.getIdentity(); // { vendorId, productCode, productName, revision, ... }
const raw = await scanner.getAttribute({ classId: 0x04, instance: 101, attribute: 3 });
await scanner.setAttribute({ classId: 0x04, instance: 100, attribute: 3, data: Buffer.from([1, 2, 3, 4]) });

const val = await scanner.readTag('TotalCount', { dataType: 'DINT' });
await scanner.writeTag('Heartbeat', 42, { dataType: 'DINT' });

await scanner.disconnect();
```

### 5.5 Discovery

```js
const devices = await Scanner.discover({ timeoutMs: 2000 });                          // broadcast lokal
const found = await Scanner.scanSubnet({ subnet: '192.168.68.0/24', timeoutMs: 3000 }); // sapu subnet eksplisit
```

### 5.6 Class 1 I/O dari EDS

Untuk perangkat dengan file `.eds` resmi (drive, remote I/O, dll. — bukan PLC dengan peta register
proprietary):

```js
const { Scanner, EdsFile } = require('@kufayeka/ethernet-ip');

const eds = EdsFile.fromFile('path/to/device.eds');
const scanner = new Scanner('192.168.1.50');
await scanner.connect();

const connection = await scanner.openConnectionFromEds(eds, 'Connection1', { rpiUs: 10000 });
const io = scanner.createIoConnection(connection);

io.on('data', (buf) => console.log('T->O data:', buf));
io.setOutput(Buffer.from([0x01, 0x00, 0x00, 0x00]));
```

> **EDS vs `DeviceProfile`**: EDS resmi pabrikan tidak memuat peta register internal PLC (D/Y/M/X) —
> hanya tahu, misalnya, "Assembly 101 = buffer 32 byte" tanpa tahu isinya. `DeviceProfile` mengisi
> kekosongan itu. Untuk baca/tulis register PLC, pakai `Device` dengan profile (§5.1), bukan EDS.

### 5.7 Multicast & Listen-Only Scanner (1 PLC Dibaca Banyak Device)

Sesuai spesifikasi ODVA CIP (Vol 1 & Vol 2 §3-5.3), jika satu PLC memiliki data Class 1 I/O yang ingin
dikonsumsi oleh banyak perangkat/aplikasi secara bersamaan:
1. **Device Pertama (Owner)** membuka koneksi Class 1 I/O dengan mode **Multicast** (`Exclusive Owner`). PLC akan memproduksi datagram I/O ke IP Multicast CIP (dihitung otomatis via formula CIP Vol 2 §3-5.3 `239.255.x.y` atau alamat yang ditentukan).
2. **Device Kedua dst. (Followers / Listeners)** membuka koneksi **Listen-Only** (`listenOnly: true`). Koneksi Listen-Only menggunakan Heartbeat Assembly (`0xC7` / 199 pada Delta SX3, size 0) untuk arah O->T, sehingga **tidak memperebutkan kepemilikan output PLC** (mencegah error CIP `0x0106 Ownership Conflict`). PLC akan mengembalikan multicast stream dan Connection ID yang sama.
3. **Penerimaan Port UDP 2222**: Semua instance I/O di dalam proses Node.js berbagi satu socket UDP 2222 secara otomatis melalui `IoSocketManager`. Datagram didistribusikan secara $O(1)$ berdasarkan 32-bit Connection ID, dan otomatis bergabung ke IGMP multicast group via `socket.addMembership()`.

#### Menggunakan `Scanner`:
```js
const { Scanner } = require('@kufayeka/ethernet-ip');

// Device 1: Multicast Owner (menulis output & menerima input multicast)
const ownerScanner = new Scanner('192.168.1.50');
await ownerScanner.connect();
const ownerConn = await ownerScanner.openMulticastConnection({
    outputAssembly: 100,
    inputAssembly: 101,
    rpiUs: 20000 // 20ms
});
const ownerIo = ownerScanner.createIoConnection(ownerConn);
ownerIo.on('data', (buf) => console.log('Owner received T->O:', buf));
await ownerIo.start();

// Device 2: Listen-Only Follower (hanya mendengar data input multicast)
const followerScanner = new Scanner('192.168.1.50');
await followerScanner.connect();
const followerConn = await followerScanner.openMulticastConnection({
    inputAssembly: 101,
    listenOnly: true, // Otomatis memakai Heartbeat Assem 199, otSize = 0
    rpiUs: 20000
});
const followerIo = followerScanner.createIoConnection(followerConn);
followerIo.on('data', (buf) => console.log('Follower received T->O:', buf));
await followerIo.start();
```

#### Menggunakan `Subscription` Real-Time UDP:
```js
// Follower / Listener via Subscription:
const sub = new Subscription(scanner, {
    mode: 'udp',
    multicast: true,
    listenOnly: true,
    rpi: 20, // 20ms
    tags: ['D0', 'D10:REAL']
});
sub.on('change', (tag, val) => console.log(`${tag} changed:`, val));
await sub.start();
```

---

## 6. Panduan DeviceBuilder (Virtual Device)

Bagian ini adalah ringkasan; untuk setiap opsi `DeviceBuilder`, mode trigger, symbolic Tag Connection,
dan tabel troubleshooting kode error, lihat [`docs/VIRTUAL_DEVICE_GUIDE.md`](docs/VIRTUAL_DEVICE_GUIDE.md).
Alur di bawah diuji end-to-end terhadap Delta EIP Builder + PLC Delta SX3 sungguhan; interoperabilitas
dengan software konfigurasi vendor lain belum diverifikasi.

```
DeviceBuilder
  ├── addParam()         -> CIP Parameter Object (0x0F), kolom pada layar parameter PLC
  ├── addTag()           -> Symbolic Tag — explicit messaging & Produced/Consumed Tag connection
  ├── defineAssembly()   -> Buffer biner Class 1 I/O (koneksi cyclic UDP 2222)
  ├── defineConnection() -> Deklarasi profil koneksi pada EDS
  ├── generateEds()      -> Menghasilkan file .eds
  └── createAdapter()    -> Menjalankan server EtherNet/IP (TCP 44818 + UDP 2222)
```

```js
const { DeviceBuilder } = require('@kufayeka/ethernet-ip');
const fs = require('fs');

const builder = new DeviceBuilder({
    vendorId: 799,                   // Vendor ID resmi (mis. 799 = Delta Electronics)
    vendorName: 'Delta Electronics, Inc.',
    productCode: 1,
    productName: 'Kufayeka Smart Node',
    deviceType: 'Generic Device',
    revision: { major: 1, minor: 0 } // lihat catatan cache di bawah
});

builder.addParam({ code: '01-00', name: 'TargetFrequency', dataType: 'INT', min: 0, max: 30000, default: 0, access: 'rw' });
builder.addParam({ code: '03-00', name: 'ActualFrequency', dataType: 'INT', default: 0, access: 'r' });

builder.defineAssembly({ instance: 100, sizeBytes: 2, type: 'output', members: [{ paramId: '01-00' }] });
builder.defineAssembly({ instance: 101, sizeBytes: 2, type: 'input', members: [{ paramId: '03-00' }] });
builder.defineConnection({ name: 'Parameter IO', outputAssembly: 100, inputAssembly: 101 });

fs.writeFileSync('MyDevice.eds', builder.generateEds());

const adapter = builder.createAdapter({ port: 44818, ioPort: 2222, address: '0.0.0.0' });
await adapter.start();

builder.on('paramChange', (code, newVal) => {
    if (code === '01-00') console.log('PLC meminta frequency baru:', newVal);
});
builder.setParam('03-00', 4500); // update feedback dari sisi perangkat
```

Catatan penting yang sering menjebak:

- **Assembly member bit-level**: `{ paramId, bitLength: 1 }` memetakan parameter `BOOL` ke bit tertentu, beberapa parameter bisa berbagi satu byte. Tanpa `members`, builder otomatis memetakan parameter yang sesuai secara berurutan — tapi hanya untuk Assembly instance 100 (output) dan 101 (input); instance lain wajib mendeklarasikan `members` eksplisit.
- **Parameter `BOOL`**: `min`/`max`/`default` pada EDS yang dihasilkan selalu numerik 0/1; nilai runtime (`getParamValue()`/`setParam()`) tetap boleh boolean JavaScript maupun numerik.
- **Revision & cache software konfigurasi**: software seperti Delta EIP Builder meng-cache device library berdasarkan Vendor ID + Product Code + Device Type + Revision. Kalau struktur parameter/assembly berubah tanpa menaikkan `revision`, software bisa saja masih memakai data lama. Naikkan `revision` (atau `productCode`) setiap kali struktur berubah, lalu hapus entri lama di device library dan import ulang EDS-nya — menimpa file `.eds` di disk saja tidak cukup.
- **Trigger Mode**: setiap koneksi dideklarasikan mendukung Cyclic maupun Change-of-State; PLC menentukan mode mana yang dipakai saat `Forward_Open`, perangkat menyesuaikan otomatis.

Langkah konfigurasi di software PLC (Delta EIP Builder / DIADesigner-AX): jalankan skrip Node.js →
Network View/Device Library → Add Device → Import EDS → atur Node IP Address → buka Data
Exchange/Connection Setting → pilih Connection Profile, atur RPI dan Trigger Mode → download ke PLC →
RUN. Detail dan troubleshooting: [`docs/VIRTUAL_DEVICE_GUIDE.md`](docs/VIRTUAL_DEVICE_GUIDE.md).

---

## 7. Detail Status Implementasi per Objek CIP

Legenda:
- ✅ Diimplementasikan dan dicakup test otomatis ([§9](#9-test-suite)), dan/atau diuji langsung terhadap PLC Delta ES2/SX3 sungguhan.
- 🔶 Implementasi dasar/parsial — misalnya hanya mengembalikan atribut statis/konfigurasi tanpa perilaku protokol penuh, atau berlaku dengan catatan penting.
- ❌ Belum diimplementasikan.

### 7.1 Encapsulation Layer (CIP Vol 2)

| Fitur | Status | Catatan |
|---|---|---|
| RegisterSession / UnregisterSession | ✅ | |
| SendRRData (Unconnected Explicit Messaging) | ✅ | |
| SendUnitData (Connected Explicit Messaging) | ✅ | Adapter menerima & menjawab (Forward_Open Class 3 ke Message Router + SendUnitData); Scanner dapat mengirim via `scanner.openExplicitConnection()` + `scanner.sendConnected()` |
| NOP (heartbeat) | ✅ | |
| ListIdentity (UDP broadcast/unicast discovery) | ✅ | `Scanner.discover()`, `Scanner.discoverAt()` |
| ListServices | ✅ | |
| Validasi Session Handle pada SendRRData/SendUnitData | ✅ | Diporting dari `CheckRegisteredSessions()` OpENer — session handle yang belum/sudah tidak terdaftar ditolak dengan `InvalidSessionHandle` (0x0064) |

### 7.2 CIP Object Model (Vol 1)

| Object (Class) | Status | Catatan |
|---|---|---|
| Identity Object (0x01) | ✅ | Get_Attribute_Single/All, Class-level Instance-0 attributes (Revision/Max Instance/Number of Instances — CIP Vol 1 §4-4.4), Reset service (0x05) diporting dari `IdentityObjectPreResetCallback` OpENer |
| Message Router (0x02) | ✅ | Routing service ke seluruh object class terdaftar, termasuk Multiple Service Packet |
| Assembly Object (0x04) | ✅ | Instance-0 class attributes, size-mismatch enforcement (`TooMuchData`) sesuai perilaku empiris hardware Delta yang diuji |
| Connection Manager (0x06) | ✅ | Forward_Open, Forward_Close, Large_Forward_Open (0x5B, hingga 65535 byte) |
| ↳ Electronic Key Segment validation | ✅ | Diporting field-per-field dari `CheckElectronicKeyData()` OpENer — strict keying (Major/Minor = 0 sebagai wildcard) dan compatible keying (Major harus sama persis, Minor > 0 dan ≤ minor perangkat) |
| ↳ Duplicate Forward_Open handling | ✅ | Default lenient (menggantikan koneksi lama dari originator sama). Opsional `strictDuplicateConnections: true` untuk perilaku ODVA-strict, menolak duplikat dengan status 0x0100 (CIP Vol 1 §3-5.5.3) |
| ↳ Connection type: Exclusive-Owner / Input-Only / Listen-Only | ✅ | Diporting dari `appcontype.c` OpENer. Listen-Only ditolak dengan `0x0119` bila belum ada koneksi "master"; Exclusive-Owner kedua ke T→O yang sama dari originator berbeda ditolak dengan `0x0106` (Ownership Conflict) |
| ↳ Production Trigger: Cyclic | ✅ | Mengirim T→O tanpa syarat tiap RPI |
| ↳ Production Trigger: Change of State | ✅ | Mengirim hanya bila data berubah atau RPI terlampaui (RPI = interval maksimum, bukan interval tetap — CIP Vol 1 §3-4.5.2) |
| ↳ Production Trigger: Application Object | ✅ | Diporting dari `TriggerConnections()` OpENer — tanpa timer otomatis; produksi terjadi saat `adapter.triggerProduction(instance)` / `builder.triggerConnection(name)` dipanggil eksplisit |
| ↳ Multicast Class 1 Connection (T→O) | ✅ | Alamat multicast dihitung dari IP/netmask device (CIP Vol 2 §3-5.3, formula dari `CipTcpIpCalculateMulticastIp()` OpENer). Forward_Open dari luar subnet ditolak (`0x0813`). Koneksi pertama ke satu instance T→O jadi "owner"; koneksi berikutnya ke instance sama jadi "follower" berbagi stream |
| TCP/IP Interface Object (0xF5) | ✅ | Instance-0 dan Attr 1 (Status), 2 (Config Capability), 3 (Config Control), 4 (Physical Link), 5 (Interface Config), 6 (Host Name), 13 (Inactivity Timeout) |
| Ethernet Link Object (0xF6) | ✅ | Instance-0 dan Attr 1 (Speed), 2 (Flags), 3 (MAC), 10 (Label), 11 (Capability) |
| Parameter Object (0x0F) | ✅ | Get/Set_Attribute_Single, access control (read-only), dipakai `DeviceBuilder.addParam()` |
| QoS Object (0x48) | 🔶 | Menyimpan & mengembalikan nilai DSCP (Get/Set_Attribute_Single); tidak benar-benar menandai paket keluar dengan DSCP tersebut di level socket |
| Port Object (0xF4) | 🔶 | Attribute dasar (Port Type, Port Number, Link Object, Node Address) sesuai struktur STRUCT CIP; tidak memodelkan multi-port device |
| Device Level Ring — DLR (0x47) | 🔶 | Attribute dasar (Network Topology, Network Status, Ring Supervisor Status/Config) dapat dibaca/ditulis; tidak ada logika beacon/ring-supervisor sungguhan — nilai statis/dikonfigurasi manual, bukan hasil deteksi topologi nyata |
| Symbol Object (0x6B) — penelusuran/discovery tag | ❌ | Perangkat Delta SX3 yang diuji juga tidak memiliki object ini (dikonfirmasi dari EDS resminya) — nama tag di software konfigurasi dimasukkan manual |
| Vendor-Specific: Delta Register Objects (0x350–0x359, 0x370–0x376) | ✅ | Bukan bagian standar ODVA — pemetaan proprietary Delta untuk register D/Y/M/X dan sejenisnya |
| Generic CIP Object (custom class) | ✅ | `GenericCipObject` — pembuatan object class kustom dengan attribute bebas |

### 7.3 Data & Addressing (Vol 1 Appendix C / §26–§31)

| Fitur | Status | Catatan |
|---|---|---|
| EPATH encode/decode (Logical, Port, Data Segment) | ✅ | |
| Electronic Key Segment encode/decode | ✅ | Struktur 10 byte sesuai CIP Vol 1 Appendix C-1.4.5.2, dicakup unit test roundtrip |
| ANSI Extended Symbol Segment (0x91) — symbolic tag addressing | ✅ | Contoh: `"TotalCount"`, `"Motor.Speed"`, `"Tanks[3]"` |
| Explicit Messaging ke symbolic tag (Get/Set_Attribute_Single langsung berdasarkan nama) | ✅ | |
| Produced/Consumed Tag Class 1 I/O Connection (symbolic Forward_Open) | ✅ | Resolusi `path.tagPath` saat runtime di `ConnectionHandler`. Catatan interoperabilitas dengan Delta EIP Builder: [§8](#8-keterbatasan-yang-diketahui) |
| CIP Elementary Data Types (BOOL, SINT, INT, DINT, LINT, USINT, UINT, UDINT, ULINT, REAL, LREAL, BYTE/WORD/DWORD/LWORD) | ✅ | |
| CIP STRING & SHORT_STRING | ✅ | |
| Bit-level access & packed boolean (member Assembly `bitLength`) | ✅ | |
| Fragmentation (Partial Transfer, 0x06) untuk attribute berukuran besar | ✅ | `readLargeAttribute()` / `writeLargeAttribute()` |
| Multiple Service Packet (0x0A) | ✅ | Fallback otomatis ke request satu-per-satu bila perangkat tidak mendukungnya |

### 7.4 EDS (Electronic Data Sheet)

| Fitur | Status | Catatan |
|---|---|---|
| EDS Parser (`EdsFile`) | ✅ | Mem-parse `[File]`, `[Device]`, `[Params]`, `[Assembly]`, `[Connection Manager]` |
| EDS Exporter (`DeviceBuilder.generateEds()`) | ✅ | Format dicocokkan terhadap struktur EDS resmi Delta SX3 (`eds/031F000E0F0600010001.eds` di repo ini). Belum diuji dengan tool validasi EDS resmi ODVA |
| Pembentukan parameter Forward_Open langsung dari EDS | ✅ | `scanner.openConnectionFromEds(eds, connectionName)` |

### 7.5 Real-Time & Robustness

| Fitur | Status | Catatan |
|---|---|---|
| Class 1 I/O cyclic producer/consumer (UDP 2222) | ✅ | |
| Connection (Inactivity) Watchdog — Target mendeteksi Originator diam | ✅ | CIP Vol 1 §3-4.5.3/§5-4.4: `otRpiUs * connectionTimeoutMultiplier` (multiplier didekode dari byte wire Forward_Open sesuai CIP Vol 1 Table 3-5.16, bukan dipakai mentah) |
| Encapsulation Session Inactivity Timeout | ✅ | CIP Vol 2 §2-4.6, TCP/IP Interface Object Attribute 13 |
| Auto-reconnect session (pemulihan setelah TCP terputus) | ✅ | |
| Real-time Tag Subscription (`Subscription`) — mode polling (TCP) dan UDP realtime | ✅ | Event `change`, `change:<tag>`, `cyclic`, `error` |

---

## 8. Keterbatasan yang Diketahui

Temuan nyata dari pengujian terhadap software konfigurasi Delta EIP Builder dan PLC Delta sungguhan
(ES2/SX3) — bukan kelalaian yang belum sempat diperbaiki.

- **Tidak ada Symbol Object (0x6B) untuk penelusuran tag.** Kolom nama tag di software konfigurasi (mis. "Slave Register/Parameter/Variable" di layar Data Exchange Delta EIP Builder) adalah isian teks manual, tanpa daftar pilihan/autocomplete dari perangkat. Perangkat Delta SX3 yang diuji juga tidak punya Symbol Object. Nama yang dimasukkan harus sama persis (case-sensitive) dengan yang didaftarkan lewat `addTag()`.
- **Ukuran (Length) pada Produced/Consumed Tag Connection harus dicocokkan manual.** Kolom "Length" mengikuti tipe data yang dipilih di sisi PLC, bukan dibaca otomatis dari perangkat. Tag `DINT` (4 byte) harus dipasangkan dengan variabel PLC 4 byte; kalau tidak, Forward_Open ditolak dengan connection size mismatch (extended status `0x0109`). Tidak ada negosiasi ukuran otomatis.
- **Symbolic tag STRING tidak bisa dijadikan Produced/Consumed Tag Connection.** CIP Parameter, acuan ukuran pada EDS, bersifat fixed-size dengan Min/Max/Default numerik — tidak cocok untuk string berpanjang variabel. Tag STRING tetap bisa diakses lewat explicit messaging (`readTag`/`writeTag`).
- **Menghubungkan perangkat ini sebagai client ke Produced Tag milik PLC sungguhan (arah sebaliknya) belum terverifikasi.** Format `connectionPath` untuk Forward_Open ke Produced Tag pada firmware PLC Delta yang diuji berbeda dari yang diterima perangkat virtual ini (dicoba, ditolak dengan extended status `0x0127` — menurut manual Delta berarti "configuration path parameters mismatch"). Arah yang terverifikasi: PLC (Scanner) menghubungi perangkat virtual ini (Adapter), bukan sebaliknya.
- **Multicast Class 1 I/O dari sisi Scanner belum diimplementasikan.** Sisi Adapter sudah mendukung produksi T→O multicast ([§7.2](#72-cip-object-model-vol-1)); sisi Scanner (`IOConnection`) selalu unicast.
- **Revision perangkat disimpan pada cache software konfigurasi PLC.** Lihat [§6](#6-panduan-devicebuilder-virtual-device). Perangkat yang tampak "tidak ter-update" setelah perubahan kode biasanya disebabkan cache tersebut, bukan cacat pada generator EDS.

---

## 9. Test Suite

```bash
npm test
```

Saat ini test suite (Mocha) berisi 347 test: encode/decode tiap lapisan protokol, seluruh CIP object
yang diimplementasikan, validasi Electronic Key & session (sebagian diporting dari OpENer), EDS parser
& exporter (roundtrip terhadap file EDS Delta SX3), Class 1 I/O (numeric dan symbolic tag, cyclic dan
change-of-state), auto-reconnect, serta integrasi client–adapter end-to-end pada localhost. Angka ini
berubah seiring waktu — jalankan `npm test` untuk angka yang akurat.

---

## 10. Dokumentasi Lanjutan & Sumber Rujukan

| Dokumen | Isi |
|---|---|
| [`docs/VIRTUAL_DEVICE_GUIDE.md`](docs/VIRTUAL_DEVICE_GUIDE.md) | Panduan lengkap `DeviceBuilder` — tiap opsi, mode trigger, Tag Connection, kejanggalan Delta EIP Builder yang ditemui saat pengujian, dan tabel troubleshooting kode error. |
| [`docs/ODVA_COMPLIANCE_REFERENCE.md`](docs/ODVA_COMPLIANCE_REFERENCE.md) | Kutipan persyaratan Scanner/Adapter dari publikasi ODVA (PUB00070, PUB00213), disandingkan dengan status implementasi proyek ini per-item, sejauh sudah diverifikasi. |
| [`docs/VENDOR_GUIDE.md`](docs/VENDOR_GUIDE.md) | Cara membuat `DeviceProfile` untuk vendor/model PLC baru, termasuk menerjemahkan tabel object CIP vendor menjadi skema `registers{}`. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Prioritas pengembangan berikutnya, berdasarkan gap yang sudah teridentifikasi. |
| [`docs/REFERENCES.md`](docs/REFERENCES.md) | Daftar bacaan/rujukan yang dipakai menyusun implementasi ini. |
| [`docs/PROJECT_LOG.md`](docs/PROJECT_LOG.md) | Catatan historis investigasi & versi README sebelum direstrukturisasi — konteks "bagaimana suatu perilaku ditemukan", bukan rujukan status terkini (lihat [§7](#7-detail-status-implementasi-per-objek-cip) untuk itu). |

**Referensi ODVA** — PUB00070 dan PUB00213 dapat diunduh langsung dari odva.org tanpa autentikasi; CIP
Networks Library Volume 1 & 2 (spesifikasi normatif lengkap) memerlukan langganan berbayar dari ODVA
dan tidak direproduksi di sini:
- [PUB00070 — Recommended Functionality for EtherNet/IP Devices](https://www.odva.org/wp-content/uploads/2020/05/PUB00070_Recommended-Functionality-for-EIP-Devices-v10.pdf)
- [PUB00213 — EtherNet/IP Quick Start for Vendors Handbook](https://www.odva.org/wp-content/uploads/2020/05/PUB00213R0_EtherNetIP_Developers_Guide.pdf)
- [ODVA Conformance Testing](https://www.odva.org/technology-standards/conformance-testing/)
- [ODVA Document Library](https://www.odva.org/technology-standards/document-library/)
- [OpENer](https://github.com/EIPStackGroup/OpENer) — reference stack ODVA-conformance-tested, dipakai sebagai acuan porting pada bagian yang ditandai di [§7](#7-detail-status-implementasi-per-objek-cip)
- [Halaman spesifikasi ODVA (berbayar)](https://www.odva.org/subscriptions-services/specifications/) — untuk CIP Networks Library Volume 1 & 2
