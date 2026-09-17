# Delta EtherNet/IP support

Delta-specific layer on top of `@kufayeka/ethernet-ip`'s vendor-neutral CIP
core. Everything here is **additive** — it reuses the same
`encodeEPath`/`buildRequest`/`sendUnconnected` machinery already validated
against generic ODVA CIP, just with Delta's own addressing conventions
layered on top. Nothing in `src/encapsulation/`, `src/cip/`, `src/client.js`,
or `src/scanner.js` depends on any of this.

For the full protocol-compliance checklist (what's implemented, what's
live-validated, what's still open) see the main
[../../README.md](../../README.md) — this file is the Delta-specific,
"what can I actually do today" summary.

## Quick start

```js
const { DeltaDevice } = require('@kufayeka/ethernet-ip/src/delta/device');

const plc = new DeltaDevice('192.168.68.250', 'sx3'); // see "Device types" below
await plc.connect();

const value = await plc.readD(100);   // read D100
await plc.writeD(100, 1234);          // write D100
await plc.disconnect();
```

`'sx3'` and `'es2'` are the two device types confirmed against real
hardware so far — see the table below for exactly what each one supports.

## Device types — what's confirmed working, today

Two real, physically different Delta PLCs were used to validate this
module: a **DVP-SX3** (AS300 CPU) and a **DVP32ES2-E**. They turned out to
need genuinely different strategies — see "Why two strategies?" below — so
the driver requires you to state the type explicitly rather than guessing.

### `'sx3'` — DVP-SV3/SX3, DVP-ES3/EX3 (AS/AH-series family)

Uses Delta's documented Vendor-Specific Register Objects (manual Ch. 8.12,
Class `0x350`-`0x359`) — the CIP Attribute ID **is** the register number.

| Method | Register | Access | Live-validated? |
|---|---|---|---|
| `readX(n)` | X (input) | read-only | ✅ |
| `readXBit(n)` | X bit | read-only | spot-checked |
| `readY(n)` / `writeY(n, v)` | Y (output) | read/write | ✅ |
| `readYBit(n)` / `writeYBit(n, v)` | Y bit | read/write | not yet |
| `readD(n)` / `writeD(n, v)` | D (data register) | read/write | ✅ incl. round-trip write |
| `readM(n)` / `writeM(n, v)` | M (marker/coil) | read/write | ✅ incl. round-trip write |
| `readS(n)` / `writeS(n, v)` | S (step) | read/write | ✅ incl. round-trip write |
| `readT(n)` / `writeT(n, v)` | T (timer, current value) | read/write | read ✅, write not yet |
| `readC(n)` / `writeC(n, v)` | C (counter, current value) | read/write | read ✅, write not yet |
| `readHC(n)` / `writeHC(n, v)` | HC (high-speed counter, DINT) | read/write | read ✅, write not yet |
| `readSM(n)` | SM (system marker) | read-only | ✅ |
| `readSR(n)` | SR (system register) | read-only | ✅ |

Only the specific device actually tested (product code 3846, a real SX3) is
empirically confirmed. DVP-ES3/EX3/SV3 share the same manual table entry
("DVP-SV3/SX3 Series") but haven't been individually tested — treat as
"expected to work, not yet confirmed" until checked against real hardware
of those exact models.

**Bit addressing caveat:** `D0.0`, `D0.1`, etc. use this driver's own
interpretation of the manual's enumeration pattern
(`attribute = wordIndex * 16 + bitIndex`) — spot-checked live but not
exhaustively verified across the full range.

### `'es2'` — DVP-ES2-E (confirmed on a real DVP32ES2-E)

This family does **not** implement the vendor Register Objects at all
(`Class 0x350`+ → `PathDestinationUnknown`). Per Delta's own product table
(manual Ch. 9), it's Adapter-capable but not Scanner-capable — that's a
device-role distinction, not a reason it can't be read from as an Adapter,
which is exactly the role this driver uses it in.

| Method | Access | How | Live-validated? |
|---|---|---|---|
| `readD(n)` | read-only | Assembly-window fallback (Instance 101, offset `n*2`) | ✅ |
| `readX` / `readY` / `writeY` / `writeD` / `readM` / `writeM` / `readS` / `writeS` / `readT` / `writeT` / `readC` / `writeC` / `readHC` / `writeHC` / `readSM` / `readSR` | — | not implemented | throws a clear "not supported for device type 'es2'" error |

The `readD` mapping was found empirically: a known pattern
(`D0=10, D1=0, D2=20, ...`) written into the PLC's own D-table via
ISPSoft/WPLSoft, then located by scanning every Assembly instance's Data
attribute for a byte-for-byte match. **Write support for D is an open
item** — Instance 100 accepts `Set_Attribute_Single` at the wire level, but
what it's actually wired to (if anything) in the PLC's own register table
is unconfirmed; see "Open items" below.

DVP26SE and DVP12SE share this table row in Delta's manual but haven't
been tested — don't assume the same Instance/offset mapping applies without
re-confirming (the known-pattern technique below).

### Why two strategies?

Real CIP capability turned out to vary per specific Delta model, not along
a clean product tier. A device answering a generic CIP request
successfully doesn't reliably signal which register-access strategy to
use — the ES2 even accepts `Set_Attribute_Single` on some Assembly
instances, so "did this request succeed" alone isn't a safe detection
signal. So the driver doesn't try to auto-detect; you state the type.

## Architecture

```
registers.js            Vendor-Specific Register Objects (Class 0x350-0x359).
                         Delta manual-documented, works the same on any
                         device that implements them (so far: SX3 only).

assembly-window.js       Generic fallback primitive: read/write a plain
                          word inside a generic Assembly instance's Data
                          attribute. Not Delta-specific in itself — reusable
                          for any device without Register Objects.

es2-fallback-profile.js   One confirmed device's assembly-window mapping
                           (D read-only via Instance 101). NOT a general
                           DVP-ES2 convention — re-confirm per device.

device-types/
  index.js                 Profile registry: register(key, profile) /
                            get(key) / list(). Adding a new PLC type means
                            adding one file here and registering it.
  sx3.js                     Profile: thin passthrough to registers.js.
  es2.js                      Profile: readD via assembly-window fallback;
                               every other method throws clearly rather
                               than being silently wrong or omitted.

device.js                  DeltaDevice — wraps a Scanner (session + generic
                            CIP) with a chosen device-type profile. The
                            public entry point for this whole module.

eds-inspect.js              Profile-authoring assist: parses an EDS file's
                             [Assembly]/[Connection Manager] sections into a
                             quick list of candidate instances/sizes/paths.
                             NOT auto-generation — EDS files don't document
                             which byte offset means which named register
                             (confirmed on the SX3's own EDS: its Param
                             names are generic "Input_data0".."Input_dataN",
                             not "D0".."D99"). A starting point for a human
                             defining a new profile, nothing more.
```

## Adding a new device type

1. Get the device talking generic CIP first (`Scanner.discover()` /
   `getAttribute()` against Identity) to confirm basic connectivity.
2. Try `registers.js`'s Class `0x350`-`0x359` directly
   (`readWord(session, RegisterClass.D, 0)`). If that works, your new type
   can likely just be a thin passthrough like `sx3.js`.
3. If it returns `PathDestinationUnknown`, fall back to the known-pattern
   technique that found the ES2's mapping:
   - Write a distinguishing value pattern into the register range you care
     about, using the device's own programming software (not this driver).
   - Sweep every Assembly instance's Data attribute
     (`examples/discover-assemblies.js` is a good starting point) and
     search for a byte-for-byte match.
   - Optionally run `node examples/inspect-eds.js <path-to-eds>` first if
     you have the device's EDS file — it won't hand you the mapping, but it
     narrows down which instances exist and their declared sizes/paths
     before you go live-probing.
4. Write `device-types/<name>.js` with the same method shape as `sx3.js`/
   `es2.js` (methods with no confirmed mapping yet should throw clearly,
   not be omitted or silently wrong).
5. Register it in `device-types/index.js`.
6. Add a live example under `examples/` and note in this file's device-type
   table exactly what was confirmed vs. assumed.

## Open items

- **ES2 write path unconfirmed** — Instance 100 accepts
  `Set_Attribute_Single`, but nothing observed confirms what (if anything)
  it writes to in the PLC's own register table. Needs the device owner to
  cross-check a written marker pattern against their own register monitor.
- **ES2 X/Y/M/S/C/T/HC/SM/SR mapping** — only D has been found. Same
  known-pattern technique would work for the others; not yet done.
- **Bit-mode addressing formula** (`wordIndex * 16 + bitIndex`) — spot-checked,
  not exhaustively verified.
- **AH/AS mid-range family (AHCPU5xx-EN, AS200/AS100, etc.)** — per Delta's
  manual these share the same Vendor-Specific Register Objects and are
  likely `'sx3'`-compatible, but none has been tested; no profile registered
  for them yet.
