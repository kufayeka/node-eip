# PLC Vendor & Device Profile Authoring Guide

Panduan lengkap untuk menambahkan dukungan merk/vendor atau model PLC baru ke dalam `@kufayeka/ethernet-ip`.

---

## 1. Konsep Arsitektur Dua Lapis

Library ini memisahkan komunikasi industri menjadi dua lapisan yang bersih dan modular:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        TIER 1: PROTOCOL CORE                           │
│  src/encapsulation/  -> Encapsulation headers, session, discovery, CPF │
│  src/cip/            -> MessageRouter, EPath, CIP codecs, EDS parser   │
│  src/scanner.js      -> Standard CIP client (Get/Set, 0x0A Batch, etc.)│
│  src/client.js       -> EIPSession socket connection & auto-reconnect  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ wraps
┌───────────────────────────────────▼────────────────────────────────────┐
│                    TIER 2: DEVICE & VENDOR LAYER                       │
│  src/device/profile.js       -> DeviceProfile definition & validation  │
│  src/device/device.js        -> Universal Device client (dynamic API)  │
│  src/device/batch-builder.js -> Schema-driven BatchBuilder (0x0A)      │
│  src/device/registry.js      -> Profile Registry                       │
│                                                                        │
│  src/vendors/                                                          │
│    ├── delta/                -> Delta Electronics (ES2, SX3, 12SE)     │
│    ├── rockwell/             -> Rockwell Automation (Logix, etc.)      │
│    └── <vendor_baru>/        -> Merk/Brand PLC lainnya                 │
└────────────────────────────────────────────────────────────────────────┘
```

- **Tier 1 (Core EIP/CIP)** murni standar ODVA EtherNet/IP. Lapisan ini **tidak boleh** memuat logika spesifik merk atau percabangan `if (vendor === '...')`.
- **Tier 2 (Device & Vendor Layer)** sepenuhnya digerakkan oleh **skema deklaratif (`DeviceProfile`)**. Tiap tipe PLC mendefinisikan kamus CIP objeknya sendiri.

---

## 2. Struktur Anatomi `DeviceProfile`

Untuk membuat profile PLC baru, instansiasi class `DeviceProfile` dengan konfigurasi berikut:

```javascript
import { DeviceProfile } from '@kufayeka/ethernet-ip/src/device/profile.js';

export const myPlcProfile = new DeviceProfile({
    vendor: 'Omron',           // Nama vendor / brand
    family: 'NX',              // Seri / family PLC
    model: 'NX1P2',            // Model spesifik
    description: 'Omron Sysmac NX1P2 Series Controller',
    
    // 1. Kapabilitas hardware
    capabilities: {
        multipleServicePacket: true, // Mendukung CIP 0x0A batch
        symbolicTags: true,          // Mendukung tag berbasis nama string
        class1IO: true               // Mendukung UDP Class 1 cyclic I/O
    },
    
    // 2. Alias pemanggilan di Device registry
    aliases: ['nx1p2', 'omron:nx1p2'],
    
    // 3. Kamus register / CIP object schema
    registers: {
        // Lihat panduan penulisan register di bawah
    },
    
    // 4. Method khusus / custom helper
    customMethods: {
        // Helper tambahan di luar register standar
    }
});
```

---

## 3. Mendefinisikan Register & Skema CIP Objek

Setiap item di dalam kamus `registers` dipetakan ke CIP Class ID, Instance, Attribute, dan tipe data biner ODVA.

### Properti Field Register:
| Field | Tipe | Keterangan |
|---|---|---|
| `classId` | `number` | CIP Class ID (misal `0x352` untuk Delta D register, `0x64` untuk Omron/DVP12SE) |
| `instance` | `number \| function(index)` | CIP Instance ID (angka tetap atau fungsi kalkulasi) |
| `attribute` | `number \| function(index)` | CIP Attribute ID (default: nilai register number) |
| `dataType` | `string` | Tipe data ODVA: `'BOOL'`, `'SINT'`, `'INT'`, `'DINT'`, `'LINT'`, `'USINT'`, `'UINT'`, `'UDINT'`, `'REAL'`, `'LREAL'`, `'STRING'` |
| `access` | `string` | `'r'` (read-only), `'w'` (write-only), atau `'rw'` (read-write) |
| `isBit` | `boolean` | `true` jika point bit/boolean/relay |
| `isWord` | `boolean` | `true` jika register 16-bit atau lebih |
| `octal` | `boolean` | `true` jika alamat fisik menggunakan penomoran oktal (misal `X0`–`X377`) |
| `range` | `[min, max]` | Batas validasi alamat register yang diizinkan |
| `resolve` | `function(index, options)` | *(Opsional)* Handler custom parsing/resolusi dinamis |

---

## 4. Kasus-Kasus Khusus & Pola Solusinya

### Kasus A: Register Standar (16-bit Word flat)
Contoh: Register `D` pada Delta ES2-E (Class `0x352`, Instance `1`, Attribute = nomor register):
```javascript
D: {
    classId: 0x352,
    instance: 1,
    dataType: 'INT',
    access: 'rw',
    isWord: true,
    range: [0, 9999]
}
```

### Kasus B: Point I/O Digital dengan Penomoran Oktal (Base-8)
Contoh: Output `Y` pada Delta (Y0..Y7, Y10..Y17, Y20..):
```javascript
Y: {
    classId: 0x351,
    instance: 1,
    dataType: 'BOOL',
    access: 'rw',
    isBit: true,
    octal: true, // Otomatis mengonversi 'Y10' menjadi desimal 8
    range: [0, 255]
}
```
*Penggunaan di developer:*
```javascript
await plc.writeY('Y10', true); // Otomatis di-parse sebagai attribute 8
await plc.writeY(8, true);     // Nilai integer desimal langsung juga valid
```

### Kasus C: Resolusi Tipe Data Dinamis (Dynamic Resolver)
Contoh: Counter `C` pada Delta ES2-E:
- C0..C199: 16-bit `INT`
- C200..C255: 32-bit `DINT` (High-speed counter)
- Mode bit (contact): Instance 1, tipe `BOOL`
```javascript
C: {
    classId: 0x356,
    instance: 2,
    bitInstance: 1,
    access: 'rw',
    range: [0, 255],
    resolve: (regIndex, options = {}) => {
        if (options.mode === 'bit') {
            return { instance: 1, dataType: 'BOOL', byteWidth: 1, isBit: true };
        }
        const is32Bit = regIndex >= 200;
        return {
            instance: 2,
            dataType: is32Bit ? 'DINT' : 'INT',
            byteWidth: is32Bit ? 4 : 2,
            isBit: false
        };
    }
}
```

### Kasus D: Instance-Per-Point (PLC Model Jadul / Non-standard)
Contoh: Delta DVP-12SE di mana nomor register dipetakan ke CIP Instance (`Instance = index + 1`) dan Attribute selalu `0x64`:
```javascript
D: {
    classId: 0x69,
    instance: (idx) => idx + 1, // D0 -> Instance 1, D100 -> Instance 101
    attribute: 0x64,            // Selalu 100
    dataType: 'INT',
    access: 'rw',
    isWord: true,
    range: [0, 11999]
}
```

### Kasus E: Dual Mode (Word vs Bit Enumeration)
Contoh: Register `D` pada Delta SX3 / AS300:
- Akses Word: Instance 2, Attribute = nomor D
- Akses Bit: Instance 1, Attribute = `nomorD * 16 + bitIndex`
```javascript
D: {
    classId: 0x352,
    instance: 2,    // Mode word
    bitInstance: 1, // Mode bit
    dataType: 'INT',
    access: 'rw',
    range: [0, 29999]
}
```
*Penggunaan di developer:*
```javascript
await plc.writeD(100, 1234);      // Mengakses Instance 2, Attribute 100
await plc.writeDBit(100, 5, true);// Mengakses Instance 1, Attribute 1605 (100*16 + 5)
```

### Kasus F: Register Pairing 32-Bit (D32 / Dn + Dn+1)
Jika PLC tidak memiliki instruksi 32-bit native di CIP, sediakan helper di `customMethods`:
```javascript
customMethods: {
    readD32: async (target, n) => {
        const low = await target.read('D', n);
        const high = await target.read('D', n + 1);
        return ((high & 0xFFFF) << 16) | (low & 0xFFFF);
    },
    writeD32: async (target, n, value) => {
        const low = value & 0xFFFF;
        const high = (value >> 16) & 0xFFFF;
        await target.write('D', n, low);
        await target.write('D', n + 1, high);
        return true;
    }
}
```

---

## 5. Mendaftarkan Profile ke Registry

Buat file `index.js` di dalam folder vendor Anda (misal `src/vendors/omron/index.js`):

```javascript
import { registerProfile } from '@kufayeka/ethernet-ip/src/device/registry.js';
import { nx1p2Profile } from './profiles/nx1p2.js';

// Registrasi profile
registerProfile(nx1p2Profile);

export { nx1p2Profile };
```

Lalu panggil di aplikasi atau `src/vendors/index.js`:
```javascript
require('./omron');
```

---

## 6. Penggunaan oleh Pengembang Aplikasi (DX yang Seamless)

Begitu profile didaftarkan, pengguna akhir mendapatkan Developer Experience yang sangat intuitif:

### 1. Inisialisasi Device
```javascript
import { Device } from '@kufayeka/ethernet-ip/src/device/index.js';

// Hubungkan ke PLC berdasarkan string identifikasi profile:
const plc = new Device('192.168.1.50', 'omron:nx1p2');
await plc.connect();
```

### 2. Akses Single Read / Write (Dynamic Method Proxy)
Method helper otomatis terbentuk sesuai nama register di profile:
```javascript
// Membaca & Menulis Word:
await plc.writeD(0, 1234);
const dVal = await plc.readD(0);

// Membaca & Menulis Bit / I/O:
await plc.writeYBit(0, true);
await plc.writeY('Y10', false); // Dukungan label oktal
```

### 3. Operasi Batch 1 Round-Trip (Schema-Driven)
BatchBuilder otomatis mengambil skema dari profile PLC yang sedang aktif tanpa hardcoding:
```javascript
const results = await plc.batch(b => {
    b.writeYBit(0, true);
    b.writeD(0, 100);
    b.writeD(1, 200);
    b.readD(0);
    b.readD(1);
});
// results: [ true, true, true, 100, 200 ]
```

### 4. Validasi Otomatis
Jika pengguna memanggil register yang tidak didukung oleh hardware (misal mencoba `readHC()` pada Delta ES2):
```
Error: Register "HC" is not supported on Delta ES2. Supported registers: X, Y, D, M, S, T, C
```
Pesan error jelas, informatif, dan tidak merusak alur program.
