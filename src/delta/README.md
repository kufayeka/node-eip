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

Earlier revisions of this doc said this family didn't implement the vendor
Register Objects at all — that was wrong. It tested only the **word-mode**
instance (Instance 2), which this device genuinely doesn't support. The
**bit-mode** instance (Instance 1) works, for every register type it has —
fully reverse-engineered live (2026-09) by writing distinguishing patterns
into the PLC's own X/D/M/Y tables via WPLSoft/ISPSoft and reading them back
over CIP, and separately by writing over CIP and watching the physical
device's own live monitor confirm the change.

| Method | Register | Access | Confirmation |
|---|---|---|---|
| `readX(n)` | X (input) | read-only | ✅ live, byte-for-byte match against a WPLSoft-written pattern |
| `readY(n)` / `writeY(n, v)` | Y (output) | read/write | ✅ live — write confirmed by watching the physical output's state change in WPLSoft |
| `readM(n)` / `writeM(n, v)` | M (marker/coil) | read/write | ✅ live, same confirmation as Y |
| `readS(n)` / `writeS(n, v)` | S (step) | read/write | ✅ live, same confirmation as Y |
| `readT(n)` / `writeT(n, v)` | T (timer) | read/write, **contact/bit state only** | ✅ live (write); no numeric current-value access on this device (see below) |
| `readC(n)` / `writeC(n, v)` | C (counter) | read/write, **contact/bit state only** | ✅ live (write); no numeric current-value access on this device |
| `readD(n)` | D (data register) | **read-only** | ✅ live — via the Assembly-window mirror (Instance 101), NOT the vendor Register Object |
| `writeD(n, v)` | D | — | ❌ **no working path found** — see below |
| `readHC` / `writeHC` / `readSM` / `readSR` | HC/SM/SR | — | not implemented — these classes don't exist on this device at all |

**The D exception, explained:** Class `0x352`'s bit-mode instance is a
real, working read/write store on this device — but a completely
**separate one** from the PLC's actual D-table. Writes made through it
never show up in the Assembly-instance-101 mirror (which *is* proven
connected to the real D-table), even with a delay, or with an active
Forward_Open connection kept alive throughout, or through Assembly
Instance 100's explicit-write path. Every avenue tried came up empty — so
`readD` uses the Assembly mirror (word-level, efficient, real), and
`writeD` currently just fails clearly rather than silently writing to
nowhere.

**Word-level access:** X/Y/M/S/T/C are only accessible bit-by-bit on this
device (its word-mode instance doesn't exist) — `readX(0)`/`readY(3)`/etc.
return booleans, matching how these types are actually addressed in
practice (`X0`, `Y3`, one point at a time). D is the exception in the other
direction: it's only accessible as a full 16-bit word via the mirror, not
bit-by-bit through a working path (the bit-mode Class `0x352` exists and
works, but doesn't connect anywhere real, as above).

**T/C limitation:** this device's Register Objects only expose the
timer/counter's *contact* (on/off) state, not a numeric elapsed-time or
count value — there's no word-mode instance to carry that number, unlike
the `'sx3'` profile where `readT`/`readC` return the real current value.

**Octal addressing reminder (X/Y only):** Delta's own convention for X and
Y labels is octal, not decimal — `X0`-`X7`, then `X10`-`X17` (`X10` octal =
8 decimal), `X20`-`X27`, and so on; digits 8 and 9 never appear. The
attribute numbers this driver uses internally are plain sequential
integers (`readX(8)` addresses the CIP attribute `8`) — for X/Y labels
below 8 in each group these line up with the octal label directly (`X0`
through `X7` = attribute `0`-`7`), but **no octal-label-to-attribute
conversion is implemented yet** for the `X10`/`X20`/... groups. Passing a
raw attribute number works for any value confirmed reachable; translating
a WPLSoft-displayed octal label like `X10` to the correct attribute number
is on you until this is added — see Open items.

DVP26SE and DVP12SE share this table row in Delta's manual but haven't
been tested — don't assume the same mapping applies without re-confirming
(the known-pattern technique below).

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
  sx3.js                     Profile: thin passthrough to registers.js
                               (word-mode Register Objects).
  es2.js                      Profile: bit-mode Register Objects for
                               X/Y/M/S/T/C (registers.js's readXBit/readYBit/
                               writeYBit/readM/writeM/readS/writeS/readBit/
                               writeBit — word-mode isn't supported on this
                               device), D read via the assembly-window
                               fallback, D write and HC/SM/SR unsupported
                               (documented why in the file itself).

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
2. Try `registers.js`'s Class `0x350`-`0x359` directly — **both modes**,
   don't stop at the first failure: `readWord(session, RegisterClass.D, 0)`
   (Instance 2, word-mode) AND `readBit(session, RegisterClass.D, 0)`
   (Instance 1, bit-mode). The ES2 turned out to support only bit-mode; a
   `PathDestinationUnknown` on word-mode alone does **not** mean the class
   doesn't exist. If bit-mode read succeeds, immediately cross-check it's
   not an isolated scratch store (see the D lesson above) — write a known
   pattern via the device's own software into a *word-mode-readable* type
   if one exists on this device (or via a completely independent read
   path, like the assembly-window mirror), and confirm the CIP read
   matches before trusting it. If word-mode works too, your new type can
   likely just be a thin passthrough like `sx3.js`; if only bit-mode works,
   model it after `es2.js`.
3. If neither mode responds at all, fall back to the known-pattern
   technique that found the ES2's D mapping:
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

- **ES2 D write** — no working path found (Assembly Instance 100 explicit
  write, Assembly Instance 100 during an active connection, and Class
  `0x352` bit-mode write were all tried and don't reach the real D-table).
  May be a genuine firmware limitation on this device rather than something
  solvable from the CIP side; revisit if a new idea comes up.
- **X/Y octal-label addressing** — `readX`/`readY`/etc. take the raw CIP
  attribute number, not the octal-style label (`X10`, `X17`, `X20`, ...)
  WPLSoft/ISPSoft display. No conversion helper exists yet; needed before
  this is safe to use with labels above `X7`/`Y7` in each group.
- **`'sx3'` word-mode T/C/HC write** — read confirmed live, write not yet
  round-trip tested on that profile (unrelated to the ES2 findings above).
- **AH/AS mid-range family (AHCPU5xx-EN, AS200/AS100, etc.)** — per Delta's
  manual these share the same Vendor-Specific Register Objects and are
  likely `'sx3'`-compatible, but none has been tested; no profile registered
  for them yet.
- **EIPSession concurrency** — issuing multiple explicit requests on one
  session concurrently (e.g. `Promise.all([read(a), read(b)])` without
  awaiting sequentially) surfaced a real bug during this investigation
  (responses got mismatched to requests). Every example and profile method
  in this driver awaits sequentially, which works fine — just don't
  parallelize calls on a single `EIPSession`/`Scanner`/`DeltaDevice` until
  this is fixed.
