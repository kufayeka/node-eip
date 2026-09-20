# Panduan Menambahkan Vendor & Device Profile

Panduan menambahkan dukungan merk/model PLC baru ke `@kufayeka/ethernet-ip`, di sisi **Client**
(`Device`/`Scanner`) — bukan sisi `DeviceBuilder` (virtual device/adapter), yang dibahas di
[`VIRTUAL_DEVICE_GUIDE.md`](VIRTUAL_DEVICE_GUIDE.md).

Semua contoh kode di dokumen ini pakai CommonJS (`require`/`module.exports`), sesuai module
system paket ini (`package.json` tidak mendeklarasikan `"type": "module"`). Semua contoh diverifikasi
langsung terhadap kode sumber saat dokumen ini ditulis; profil Delta (`es2`, `sx3`, `12se`) dan
Rockwell (`logix`) yang dikutip di sini adalah profil bawaan yang sudah ada di
`src/vendors/`, bukan contoh reka-reka.

---

## 1. Konsep Arsitektur Dua Lapis

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TIER 1: PROTOCOL CORE                           │
│  src/encapsulation/  -> Encapsulation headers, session, discovery, CPF │
│  src/cip/            -> MessageRouter, EPath, CIP codecs, EDS parser   │
│  src/scanner.js      -> Standard CIP client (Get/Set, 0x0A Batch, dll) │
│  src/client.js       -> EIPSession socket connection & auto-reconnect │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ dipakai oleh
┌───────────────────────────────────▼────────────────────────────────────┐
│                    TIER 2: DEVICE & VENDOR LAYER                       │
│  src/device/profile.js       -> DeviceProfile (skema register/alamat)  │
│  src/device/device.js        -> Device — client dinamis per profile    │
│  src/device/batch-builder.js -> BatchBuilder (0x0A) berbasis skema     │
│  src/device/registry.js      -> Profile Registry (lookup by key)       │
│                                                                        │
│  src/vendors/                                                          │
│    ├── delta/     -> Profil bawaan: es2, sx3, dvp12se                  │
│    ├── rockwell/  -> Profil bawaan: logix (symbolic tag, registers={}) │
│    └── <vendor_baru>/                                                 │
└────────────────────────────────────────────────────────────────────────┘
```

- **Tier 1** murni EtherNet/IP (CIP) generik — tidak boleh berisi percabangan `if (vendor === '...')`.
- **Tier 2** sepenuhnya digerakkan skema deklaratif `DeviceProfile`. Menambah vendor baru berarti menulis satu objek konfigurasi, bukan mengubah kode Tier 1.

---

## 2. Anatomi `DeviceProfile`

```js
const { DeviceProfile } = require('@kufayeka/ethernet-ip/src/device/profile');

const myPlcProfile = new DeviceProfile({
    vendor: 'Omron',              // wajib
    model: 'NX1P2',               // wajib
    family: 'NX',                 // opsional, default: sama dengan vendor
    description: 'Omron Sysmac NX1P2 Series Controller', // opsional, default: "<vendor> <model>"
    name: undefined,              // opsional, default: sama dengan description

    capabilities: {
        multipleServicePacket: true, // default TRUE kalau tidak diisi false eksplisit
        symbolicTags: true,          // default FALSE
        class1IO: true                // default FALSE
    },

    aliases: ['nx1p2', 'omron:nx1p2'], // key lookup TAMBAHAN, lihat §6

    registers: {
        // lihat §3
    },

    customMethods: {
        // lihat §7.3
    }
});
```

Field yang wajib diisi hanya `vendor` dan `model` — constructor melempar `TypeError` kalau salah
satunya tidak ada. Semua field lain punya default seperti tercantum di atas (lihat
`_normalizeRegisterDef()`/constructor di `src/device/profile.js` untuk nilai default persisnya).

---

## 3. Mendefinisikan Register

Setiap entri di `registers{}` dipetakan lewat `_normalizeRegisterDef()` — field yang tidak diisi akan
memakai default berikut:

| Field | Tipe | Default | Keterangan |
|---|---|---|---|
| `classId` | `number` | *(wajib diisi manual)* | CIP Class ID, mis. `0x352` untuk D register Delta ES2/SX3 |
| `instance` | `number \| (index) => number` | `1` | Instance ID mode "word"/non-bit. Fungsi dipanggil dengan index register (mis. nomor D) |
| `bitInstance` | `number \| (index) => number` | `1` | Instance ID mode "bit", dipakai saat `resolveAddress()` dipanggil dengan `{ mode: 'bit' }` atau register punya `isBit: true` |
| `attribute` | `number \| (index) => number` | index register itu sendiri | Kalau tidak diisi, attribute = nomor register yang diminta (pola paling umum) |
| `dataType` | `string` | `'BOOL'` jika `isBit: true`, selain itu `'INT'` | Tipe CIP: `BOOL`, `SINT`, `INT`, `DINT`, `LINT`, `USINT`, `UINT`, `UDINT`, `ULINT`, `REAL`, `LREAL`, `STRING`, dst. |
| `access` | `'r' \| 'w' \| 'rw'` | `'rw'` | Ditegakkan di `Device.read()`/`write()` dan `BatchBuilder` — bukan cuma dokumentasi |
| `isBit` | `boolean` | `false` | Menandai register sebagai titik bit/boolean tunggal |
| `isWord` | `boolean` | `!isBit` | Informasional; dipakai kode lain yang membaca skema profile |
| `isScalar` | `boolean` | `false` | `true` untuk register yang tidak butuh index (dipanggil tanpa argumen index, `resolveAddress` otomatis pakai `index = 0`) |
| `units` | `string` | `''` | Informasional (satuan fisik, mis. `'0.01 Hz'`) |
| `octal` | `boolean` | `false` | `true` kalau label alamat berbasis oktal (mis. `X0`–`X377`) — lihat §4.3 |
| `range` | `[min, max]` | `null` (tidak divalidasi) | Batas index yang divalidasi `resolveAddress()` |
| `bitRange` | `[min, max]` | dihitung dari `range` bila kosong: `(range[1]+1)*16-1` | Batas index KHUSUS saat diakses via `options.bitIndex` (word+bit addressing, §4.2) |
| `resolve` | `(index, options) => object` | `null` | Resolver custom untuk pola alamat non-linear — lihat §4.4 |

`classId` tidak punya default — kalau lupa diisi, tiap operasi ke register itu akan mengirim CIP
request dengan `classId: undefined`, yang akan gagal di level encoding EPath, bukan di validasi
`DeviceProfile` sendiri. Tidak ada pengecekan eksplisit untuk ini saat `addParam`/registrasi.

---

## 4. Bagaimana `resolveAddress()` Menerjemahkan Alamat

`Device.read()`/`write()` dan `BatchBuilder` sama-sama memanggil `profile.resolveAddress(regName,
indexOrLabel, options)` sebelum membentuk request CIP. Memahami urutan logikanya penting untuk
menulis profile yang benar.

### 4.1 Mode Word vs Bit

```js
resolveAddress('Y', 10)                       // mode word (default)
resolveAddress('Y', 10, { mode: 'bit' })      // mode bit dipaksa
resolveAddress('Y', 10, { mode: 'word' })     // mode word dipaksa, meski register isBit: true
```

Kalau `options.mode` tidak diisi, mode bit otomatis aktif bila `reg.isBit === true`. Saat mode bit
aktif DAN register punya `bitInstance` terpisah dari `instance` (pola dual-mode seperti D register di
Delta SX3), instance yang dipakai adalah `bitInstance`, bukan `instance`.

### 4.2 Word + Bit Index (`options.bitIndex`)

```js
resolveAddress('D', 100, { mode: 'bit', bitIndex: 5 })
// -> instance = bitInstance (karena mode:'bit'), attribute = 100 * 16 + 5 = 1605
```

Ini pola "akses satu bit di dalam word tertentu" (mis. `D100.5` di banyak PLC ladder-logic). `bitIndex`
SENDIRIAN, tanpa `mode: 'bit'`, TIDAK memindahkan instance ke `bitInstance` — hanya mengubah rumus
`attribute` sementara `instance` tetap ikut `reg.instance` (mode word). Yang dipanggil `Device`/
`BatchBuilder` lewat method `read<Reg>Bit`/`write<Reg>Bit` (§8) SELALU menyertakan `mode: 'bit'`
sekaligus `bitIndex`, jadi kombinasi keduanya inilah yang perlu diingat, bukan `bitIndex` saja. Rumus
attribute-nya SELALU `index * 16 + bitIndex`, hardcoded di `resolveAddress()` — bukan bisa dikonfigurasi
per-register. Kalau vendor target punya rumus bit-offset yang berbeda (bukan kelipatan 16 per word),
pola ini tidak cocok; pakai `resolve()` custom (§4.4) sebagai gantinya.

### 4.3 Label Oktal (`octal: true`)

```js
resolveAddress('Y', 'Y10')  // "Y10" -> ekstrak digit trailing "10" -> parseInt('10', 8) = 8
resolveAddress('Y', 8)      // angka desimal langsung juga valid, tidak diproses sebagai oktal
```

Parsing labelnya berupa regex `/^[A-Za-z]*([0-7]+)$/` — huruf apa pun di depan diabaikan, lalu digit
tersisa (harus 0-7) diparse sebagai basis 8. Kalau input berupa angka (bukan string), `octal` tidak
berpengaruh sama sekali — dianggap sudah desimal.

### 4.4 Resolver Custom (`resolve`)

Dipakai untuk pola alamat yang tidak bisa diekspresikan lewat kombinasi field statis di atas —
misalnya tipe data yang berubah tergantung range index (Counter 16-bit vs 32-bit), atau `classId`
yang berbeda per mode akses (DVP-12SE: Timer punya `classId` sama tapi `attribute` berbeda untuk
mode angka vs mode bit).

```js
resolve: (index, options = {}) => {
    // Field yang TIDAK dikembalikan di sini otomatis jatuh kembali (fallback) ke field
    // dasar register (classId, instance/bitInstance, access) -- lihat resolveAddress() di
    // src/device/profile.js untuk urutan fallback persisnya.
    if (options.mode === 'bit') {
        return { instance: 1, dataType: 'BOOL', byteWidth: 1, isBit: true };
    }
    const is32Bit = index >= 200;
    return {
        instance: 2,
        dataType: is32Bit ? 'DINT' : 'INT',
        byteWidth: is32Bit ? 4 : 2,
        isBit: false
    };
}
```

Field yang dikembalikan `resolve()` (`classId`, `instance`, `attribute`, `dataType`, `byteWidth`,
`access`, `isBit`) masing-masing OPSIONAL — yang tidak disebut akan jatuh ke nilai default register
dasarnya (`reg.classId`, `reg.instance`/`reg.bitInstance`, `reg.access`, dst). `attribute` yang tidak
disebutkan jatuh ke `index` itu sendiri, BUKAN ke `reg.attribute` — beda dari field lain. Perhatikan
juga bahwa saat `resolve` didefinisikan, `range` pada level register tidak divalidasi otomatis oleh
`resolveAddress()` — validasi range untuk kasus dinamis (kalau diperlukan) harus dilakukan sendiri di
dalam fungsi `resolve`.

### 4.5 Validasi Index Otomatis (`range`)

```js
D: { classId: 0x352, instance: 1, dataType: 'INT', access: 'rw', isWord: true, range: [0, 11999] }

resolveAddress('D', 12000) // RangeError: Address 12000 is out of range [0..11999] for register D
```

Berlaku hanya kalau `range` diisi dan `isScalar` tidak `true`. Untuk mode bit tanpa `bitRange`
eksplisit, batas maksimum otomatis dihitung `(range[1] + 1) * 16 - 1` — asumsi tiap word register
punya 16 bit anak (X0..X377 oktal, Y0..Y377, dst). Kalau asumsi 16-bit-per-word ini tidak berlaku di
vendor target, definisikan `bitRange` secara eksplisit.

---

## 5. Menerjemahkan Tabel Object CIP Resmi Vendor

Kalau vendor menerbitkan tabel object CIP resmi (seperti manual Delta di
`docs/delta-cip-object-reference.md`, transkripsi dari PDF resminya), pola tabelnya biasanya begini:

| Object Name | Class Code | # of Instance |
|---|---|---|
| Identity | 0x01 | 8 |
| Assembly | 0x04 | 8 |
| X input | 0x350 | 256 |
| Y output | 0x351 | 256 |
| D Register | 0x352 | 10000 |

Diikuti tabel kedua yang mendokumentasikan attribute per instance:

| Attribute ID | Access | Data Type | Description |
|---|---|---|---|
| 0 – 9999 | Get/Set | INT | D0 – D9999 |

Langkah penerjemahan:

1. **Class Code → `classId`** — salin nilai hex-nya langsung.
2. **Pola alamat attribute** — baca baris "Attribute ID" dengan teliti, tiap vendor beda konvensi:
   - **Attribute = nomor register langsung** (paling umum, seperti contoh D di atas) → `attribute` tidak perlu didefinisikan.
   - **Instance = nomor register + offset tetap, attribute tetap** (mis. DVP-12SE: `instance: (idx) => idx + 1`, `attribute: 0x64` tetap) — lihat §5.3 (Kasus DVP-12SE).
   - **Attribute = rumus dari index** (mis. bit-mode Delta SX3: `attribute = D_index * 16 + bitIndex`, sudah otomatis lewat `options.bitIndex`, §4.2) atau pola non-linear lain → pakai `resolve()` (§4.4).
3. **Tipe data resmi vendor → `dataType` ODVA** — kalau manual sudah pakai istilah CIP standar (INT/DINT/BOOL/dst), salin langsung. Istilah non-standar (mis. "Word", "Long") dipetakan ke tipe ODVA terdekat berdasar lebar byte-nya (Word→INT/UINT 16-bit, Long→DINT/UDINT 32-bit).
4. **Access → `access`** — "Get" saja = `'r'`, "Set" saja = `'w'`, "Get/Set" = `'rw'`.
5. **Range alamat → `range`** — salin dari kolom "# of Instance" atau rentang attribute yang didokumentasikan. Model berbeda dalam satu keluarga PLC sering punya rentang berbeda — cek per-model, jangan asumsikan seragam (lihat `docs/delta-cip-object-reference.md`, satu manual yang mendokumentasikan beberapa model Delta sekaligus dengan rentang berbeda-beda).

### Checklist sebelum submit profile baru

- [ ] `classId` di `registers{}` sudah dicocokkan persis dengan tabel object list resmi.
- [ ] Sudah dites baca DAN tulis ke hardware asli, bukan cuma dari dokumentasi — manual vendor kadang salah cetak (off-by-one instance, access yang salah ketik).
- [ ] Kalau ada mode bit DAN word untuk register yang sama, `bitInstance` sudah didefinisikan terpisah dari `instance` (§5.1, §5.2).
- [ ] `range` sudah dicek tidak melebihi yang benar-benar didukung hardware.
- [ ] `aliases` (§6) sudah ditest lewat `getProfile()`/`hasProfile()`, bukan cuma dibaca dari kode sumber — lihat catatan di §6 soal bug yang pernah membuat ini gagal diam-diam.

---

## 6. Mendaftarkan Profile ke Registry

### 6.1 Vendor bawaan (dibundel di repo ini)

Buat `src/vendors/<vendor>/profiles/<model>.js` mengikuti pola profil Delta/Rockwell yang sudah ada
(lihat §7 untuk contoh lengkapnya), lalu buat `src/vendors/<vendor>/index.js`:

```js
'use strict';

const { registerProfile } = require('../../device/registry');
const { nx1p2Profile } = require('./profiles/nx1p2');

registerProfile(nx1p2Profile);

module.exports = {
    nx1p2: nx1p2Profile,
    profiles: [nx1p2Profile]
};
```

Lalu **daftarkan vendor barunya** di `src/vendors/index.js` — ini langkah yang mudah terlewat, karena
folder vendor baru TIDAK otomatis ter-require hanya dengan diletakkan di `src/vendors/`:

```js
const delta = require('./delta');
const rockwell = require('./rockwell');
const omron = require('./omron'); // baris baru

module.exports = { delta, rockwell, omron };
```

`src/device/index.js` sudah me-require `../vendors` secara otomatis, jadi setelah langkah di atas,
`require('@kufayeka/ethernet-ip')` akan langsung mendaftarkan profile baru tanpa langkah tambahan
di sisi pengguna.

### 6.2 Profile pihak ketiga (di aplikasi Anda sendiri, tanpa mengubah repo ini)

Tidak perlu menyentuh `src/vendors/`. Panggil `registerProfile()` langsung dari kode aplikasi,
sebelum profile itu dipakai lewat `new Device(host, 'key-nya')`:

```js
const { DeviceProfile, registerProfile } = require('@kufayeka/ethernet-ip');

const myProfile = new DeviceProfile({ vendor: 'Acme', model: 'PLC-9000', registers: { /* ... */ } });
registerProfile(myProfile);

const plc = new Device('192.168.1.1', 'acme:plc-9000'); // langsung bisa dipakai
```

### 6.3 Lookup key yang otomatis terdaftar

`registerProfile()` (`src/device/registry.js`) selalu mendaftarkan dua key otomatis, tidak peduli
`aliases` diisi atau tidak:
- `"<vendor>:<model>"` (huruf kecil semua), mis. `"delta:sx3"`
- `"<model>"` saja (huruf kecil), mis. `"sx3"`

Key TAMBAHAN di luar dua itu (mis. `"es2e"`, `"dvp12se"`, `"rockwell:logix"`, `"controllogix"`) hanya
terdaftar kalau ada di array `aliases` konfigurasi `DeviceProfile`. **Catatan penting**: field ini
sempat rusak — `DeviceProfile` tidak pernah benar-benar menyimpan `config.aliases` ke instance-nya,
jadi seluruh alias tambahan di semua profile bawaan (Delta maupun Rockwell) diam-diam tidak pernah
bisa di-lookup sampai bug ini diperbaiki. Kalau alias baru yang Anda tambahkan tidak bisa ditemukan
`getProfile()`, jalankan `npm test` dulu untuk memastikan versi pustaka yang dipakai sudah termasuk
perbaikan itu — commit `fix: DeviceProfile never stored config.aliases`.

---

## 7. Contoh Nyata: Tiga Profil Delta yang Sudah Ada

Ketimbang contoh reka-reka, bagian ini mengutip langsung tiga profil bawaan (`src/vendors/delta/profiles/`)
yang sudah diuji terhadap hardware Delta sungguhan — masing-masing mewakili pola pengalamatan berbeda.

### 7.1 Delta ES2 — instance tetap, attribute = nomor register langsung

Pola paling sederhana: satu `instance` tetap per register, `attribute` = index yang diminta.

```js
// src/vendors/delta/profiles/es2.js (diringkas)
registers: {
    X: { classId: 0x350, instance: 1, dataType: 'BOOL', access: 'r',  isBit: true, octal: true, range: [0, 255] },
    Y: { classId: 0x351, instance: 1, dataType: 'BOOL', access: 'rw', isBit: true, octal: true, range: [0, 255] },
    D: { classId: 0x352, instance: 1, dataType: 'INT',  access: 'rw', isWord: true, range: [0, 11999] },
    M: { classId: 0x353, instance: 1, dataType: 'BOOL', access: 'rw', isBit: true, range: [0, 4095] },

    // T Timer: Instance 2 = nilai INT, Instance 1 = bit kontak -- dua instance BERBEDA untuk
    // objek CIP yang SAMA, dipilih otomatis oleh resolveAddress() lewat instance/bitInstance.
    T: { classId: 0x355, instance: 2, bitInstance: 1, dataType: 'INT', access: 'rw', range: [0, 255] },

    // C Counter: instance sama seperti T, TAPI tipe datanya berubah tergantung index -- perlu resolve().
    C: {
        classId: 0x356, instance: 2, bitInstance: 1, access: 'rw', range: [0, 255],
        resolve: (regIndex, options = {}) => {
            if (options.mode === 'bit') return { instance: 1, dataType: 'BOOL', byteWidth: 1, isBit: true };
            const is32Bit = regIndex >= 200; // C200-C255 = high-speed counter 32-bit
            return { instance: 2, dataType: is32Bit ? 'DINT' : 'INT', byteWidth: is32Bit ? 4 : 2, isBit: false };
        }
    }
}
```

### 7.2 Delta SX3 — dual-mode word/bit di HAMPIR SEMUA register

Beda dari ES2: hampir semua register numerik (X, Y, D, T, C, HC) punya dua instance (`instance` untuk
mode word, `bitInstance` untuk mode bit per-bit), sementara M/S/SM/SR cuma satu mode:

```js
// src/vendors/delta/profiles/sx3.js (diringkas)
registers: {
    X:  { classId: 0x350, instance: 2, bitInstance: 1, dataType: 'INT', access: 'r',  octal: true, range: [0, 255] },
    Y:  { classId: 0x351, instance: 2, bitInstance: 1, dataType: 'INT', access: 'rw', octal: true, range: [0, 255] },
    D:  { classId: 0x352, instance: 2, bitInstance: 1, dataType: 'INT', access: 'rw', isWord: true, range: [0, 29999] },
    M:  { classId: 0x353, instance: 1, dataType: 'BOOL', access: 'rw', isBit: true, range: [0, 8191] },
    HC: { classId: 0x357, instance: 2, bitInstance: 1, dataType: 'DINT', access: 'rw', range: [0, 255] }, // high-speed counter, 32-bit native
    SR: { classId: 0x359, instance: 1, dataType: 'INT', access: 'r', isWord: true, range: [0, 2047] }      // read-only, word-only
}
```

Pemakaian sisi aplikasi (rumus `attribute = D_index * 16 + bitIndex` untuk bit-in-word terjadi otomatis, §4.2):

```js
await plc.writeD(100, 1234);           // instance 2 (bitInstance TIDAK dipakai), attribute 100
await plc.writeDBit(100, 5, true);     // instance 1 (bitInstance), attribute 100*16 + 5 = 1605
```

### 7.3 Delta DVP-12SE — instance-per-point, attribute tetap

Kebalikan dari ES2/SX3: nomor register dipetakan ke CIP **Instance**, bukan Attribute. Attribute-nya
selalu tetap (`0x64`), dan `classId` beda per jenis register (bukan satu class dengan banyak instance).

```js
// src/vendors/delta/profiles/dvp12se.js (diringkas)
registers: {
    X: { classId: 0x64, instance: (idx) => idx + 1, attribute: 0x64, dataType: 'BOOL', access: 'r',  isBit: true, octal: true, range: [0, 255] },
    Y: { classId: 0x65, instance: (idx) => idx + 1, attribute: 0x64, dataType: 'BOOL', access: 'rw', isBit: true, octal: true, range: [0, 255] },
    D: { classId: 0x69, instance: (idx) => idx + 1, attribute: 0x64, dataType: 'INT',  access: 'rw', isWord: true, range: [0, 11999] },

    // T Timer: classId TETAP sama utk kedua mode, tapi attribute BEDA (0x64 vs 0x65) --
    // pola classId-tetap + attribute-berubah ini butuh resolve(), beda dari pola SX3 di atas
    // (classId tetap + INSTANCE berubah lewat bitInstance).
    T: {
        classId: 0x66, instance: (idx) => idx + 1, access: 'rw', range: [0, 255],
        resolve: (regIndex, options = {}) => {
            const isBit = options.mode === 'bit';
            return { classId: 0x66, instance: regIndex + 1, attribute: isBit ? 0x65 : 0x64, dataType: isBit ? 'BOOL' : 'INT', byteWidth: isBit ? 1 : 2, isBit };
        }
    }
}
```

Karena `resolve()` di sini mengembalikan `classId` dan `instance` secara eksplisit (bukan mengandalkan
fallback ke `reg.classId`/`reg.instance`), pola ini juga valid dipakai ketika `classId` ATAU `instance`
sama-sama perlu berubah tergantung mode — bukan cuma salah satunya.

---

## 8. Method Dinamis di `Device` dan `BatchBuilder`

`Device` (`src/device/device.js`) dan `BatchBuilder` (`src/device/batch-builder.js`) sama-sama
memakai `Proxy` untuk membentuk method `readX`/`writeX` secara otomatis dari nama register yang
terdaftar di profile aktif — pola nama method dan urutan pengecekannya identik di keduanya:

| Pola nama method | Contoh | Diteruskan sebagai |
|---|---|---|
| `read<Reg>BitLabel(label)` | `readYBitLabel('Y10')` | `read('Y', 'Y10', { mode: 'bit' })` |
| `write<Reg>BitLabel(label, value)` | `writeYBitLabel('Y10', true)` | `write('Y', 'Y10', true, { mode: 'bit' })` |
| `read<Reg>Bit(indexOrLabel, bitIndex?)` | `readDBit(100, 5)` | `read('D', 100, { mode: 'bit', bitIndex: 5 })` |
| `write<Reg>Bit(indexOrLabel, value)` **atau** `write<Reg>Bit(indexOrLabel, bitIndex, value)` | `writeYBit(0, true)` / `writeDBit(100, 5, true)` | 2 argumen = tanpa `bitIndex`; 3 argumen = argumen ke-2 jadi `bitIndex`, argumen ke-3 jadi value |
| `read<Reg>(indexOrLabel)` | `readD(0)` | `read('D', 0)` |
| `write<Reg>(indexOrLabel, value)` | `writeD(0, 1234)` | `write('D', 0, 1234)` |
| *(nama lain apa pun)* | `readTag(...)`, `readC32(...)` | dicari di `profile.customMethods[nama]`, dipanggil `(target, ...args)` |

Pengecekan `<Reg>` di setiap pola selalu lewat `profile.hasRegister(nama)` — kalau register-nya tidak
ada di profile, method itu TIDAK terbentuk sama sekali (proxy mengembalikan `undefined`, bukan
melempar error saat pembuatan objek); memanggilnya sebagai fungsi baru menghasilkan
`TypeError: plc.readXyz is not a function` dari JavaScript sendiri, bukan pesan error dari pustaka ini.

`BatchBuilder` menghasilkan pola nama method yang PERSIS sama, dipakai di dalam callback `plc.batch()`:

```js
const results = await plc.batch((b) => {
    b.writeYBit(0, true);
    b.writeD(0, 100);
    b.readD(0);
});
```

`Device.batch()` sendiri memeriksa `profile.capabilities.multipleServicePacket` sebelum membentuk
`BatchBuilder` — kalau `false`, `batch()` melempar error eksplisit (`"... does not support Multiple
Service Packet (batch)"`) sebelum request apa pun dikirim, bukan gagal di pertengahan.

---

## 9. Membuat `customMethods`

`customMethods` adalah objek `{ namaMethod: async (target, ...args) => ... }`, dipanggil dengan
`target` = instance `Device`/`BatchBuilder` itu sendiri sebagai argumen pertama — jadi bisa memanggil
`target.read()`/`target.write()` balik, atau (untuk profile symbolic-tag seperti Rockwell Logix)
`target.scanner` langsung:

```js
// Pola "gabungan dua register 16-bit jadi satu nilai 32-bit", dipakai Delta ES2/SX3 untuk D32/C32
// karena firmware-nya tidak punya instruksi CIP native 32-bit untuk register itu.
customMethods: {
    readD32: async (target, n) => {
        const low = await target.read('D', n);
        const high = await target.read('D', n + 1);
        return ((high & 0xFFFF) << 16) | (low & 0xFFFF);
    },
    writeD32: async (target, n, value) => {
        await target.write('D', n, value & 0xFFFF);
        await target.write('D', n + 1, (value >> 16) & 0xFFFF);
        return true;
    }
}

// Pola symbolic tag (Rockwell Logix) -- registers: {} kosong, semua akses lewat tag bernama string.
customMethods: {
    readTag: async (target, tagName) => target.scanner.readSymbolicTag(tagName),
    writeTag: async (target, tagName, value, dataType) => target.scanner.writeSymbolicTag(tagName, value, dataType)
}
```

---

## 10. Menghasilkan Profile Otomatis dari File EDS

`DeviceProfile.fromEds(edsSource, options)` dan `DeviceProfile.generateCodeFromEds(edsSource, options)`
(`src/device/eds-generator.js`), serta CLI `bin/eds-to-profile.js` (`npx eip-profile-gen`) yang
membungkusnya, mengekstrak `[Params]` CIP Parameter Object (Class 0x0F) dari sebuah file `.eds` menjadi
`DeviceProfile` siap pakai.

**Ini bukan pengganti langkah manual di §5–§7.** Diuji langsung terhadap EDS asli Delta SX3 di repo ini
(`eds/031F000E0F0600010001.eds`):

```bash
node bin/eds-to-profile.js eds/031F000E0F0600010001.eds --stdout
```

Hasilnya adalah profile berisi parameter KONFIGURASI Data Exchange milik SX3 sendiri (`RPI`,
`Input_data`, `Conn1_Input(T->O) DeviceType`, dst — parameter Class 0x0F yang dipakai mengatur
mapping I/O remote), BUKAN register D/Y/M/X SX3 yang sebenarnya. Register D/Y/M/X Delta memakai Class
ID proprietary (`0x350`–`0x359`) yang sama sekali tidak lewat CIP Parameter Object standar, sehingga
tidak muncul di `[Params]` EDS dan tidak bisa diekstrak generator ini.

Generator ini relevan untuk vendor yang benar-benar mengekspos data prosesnya lewat Parameter Object
0x0F standar di EDS (umum pada AC drive dan perangkat CIP generik) — untuk vendor dengan peta register
proprietary seperti Delta, tetap tulis `registers{}` manual mengikuti §5–§7.

---

## 11. Ringkasan Alur Kerja

1. Kumpulkan tabel object CIP resmi vendor (manual PDF, atau `EdsFile.fromFile()` kalau ada `.eds`).
2. Terjemahkan tiap register ke entri `registers{}` mengikuti §3–§5; pilih pola dari §7 yang paling mirip pola alamat vendor target.
3. Buat `DeviceProfile` (§2), lengkap dengan `capabilities` dan `aliases` yang relevan.
4. Daftarkan lewat `registerProfile()` — vendor bawaan lewat §6.1, profile aplikasi sendiri lewat §6.2.
5. Uji tiap register baca DAN tulis ke hardware asli (checklist §5), termasuk `aliases` (§6.3).
6. Kalau ada operasi yang tidak bisa diekspresikan lewat skema register biasa (mis. gabungan 32-bit dari dua register 16-bit, akses symbolic tag), tambahkan lewat `customMethods` (§9).
