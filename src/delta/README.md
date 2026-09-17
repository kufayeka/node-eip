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
| `readXBit(n)` / `readXBitLabel(label)` | X bit | read-only | ✅ full round-trip incl. `'X377'` (top of range, 2026-09) |
| `readY(n)` / `writeY(n, v)` | Y (output) | read/write | ✅ |
| `readYBit(n)` / `writeYBit(n, v)` / `readYBitLabel(label)` / `writeYBitLabel(label, v)` | Y bit | read/write | ✅ full round-trip (2026-09) |
| `readD(n)` / `writeD(n, v)` | D (data register) | read/write | ✅ incl. round-trip write, incl. `D29999` (top of range) |
| `readM(n)` / `writeM(n, v)` | M (marker/coil) | read/write | ✅ incl. round-trip write, incl. `M8191` (top of range) |
| `readS(n)` / `writeS(n, v)` | S (step) | read/write | ✅ incl. round-trip write, incl. `S2047` (top of range) |
| `readT(n)` / `writeT(n, v)` | T (timer, current value) | read/write | ✅ round-trip (write→read-back→restore), incl. `T511` (top of range) |
| `readC(n)` / `writeC(n, v)` | C (counter, current value) | read/write | ✅ round-trip (write→read-back→restore), incl. `C511` (top of range) |
| `readHC(n)` / `writeHC(n, v)` | HC (high-speed counter, DINT) | read/write | ✅ round-trip (write→read-back→restore), incl. `HC255` (top of range) |
| `readSM(n)` | SM (system marker) | read-only | ✅ |
| `readSR(n)` | SR (system register) | read-only | ✅ |
| `readD32(n)` / `writeD32(n, v)` | D, 32-bit (Dn+Dn+1 paired) | read/write | ✅ full round-trip (`writeD32(200, 0x12345678)` → `D200=0x5678, D201=0x1234`) |
| `readC32(n)` / `writeC32(n, v)` | alias for `readHC`/`writeHC` | read/write | ✅ full round-trip (2026-09) |

Only the specific device actually tested (product code 3846, a real SX3) is
empirically confirmed. DVP-ES3/EX3/SV3 share the same manual table entry
("DVP-SV3/SX3 Series") and, as of 2026-09, are also registered as their own
explicit `'es3'` device type ([src/delta/device-types/es3.js](device-types/es3.js),
identical implementation, exists so callers can `new DeltaDevice(host, 'es3')`
instead of the less-obvious `'sx3'`) — its own EDS file was independently
confirmed structurally identical to the SX3's, but no physical ES3/EX3/SV3
has been tested against this driver. Treat `'es3'` as "expected to work, not
yet confirmed" until checked against real hardware of those exact models.

**Bit addressing caveat:** `D0.0`, `D0.1`, etc. use this driver's own
interpretation of the manual's enumeration pattern
(`attribute = wordIndex * 16 + bitIndex`) — spot-checked live but not
exhaustively verified across the full range.

**32-bit (DINT) access — two genuinely different mechanisms, confirmed
against Delta's own DVP-PLC Application Manual device-range tables
(ES/EX/EC series and EC3-8K series CPUs — full tables saved at
[docs/dvp-plc-device-ranges.md](../../docs/dvp-plc-device-ranges.md)):**

- **D** has no separate 32-bit device range at all — the manual lists it as
  one flat range (e.g. `D0`-`D407` general purpose on ES/EX/EC). 32-bit D
  access is purely a **ladder-programming convention**: pair `Dn` (low
  word) with `Dn+1` (high word), the same registers, addressed twice.
  `readD32`/`writeD32` (`src/delta/dword.js`) implement exactly this — two
  ordinary 16-bit operations combined, not a separate CIP object. Available
  on `DeltaDevice` directly (not per-profile), since it's just composed
  from `readD`/`writeD` and inherits whatever those already support for
  the active profile.
- **C is different: the manual gives 16-bit and 32-bit counters *separate
  number ranges within the same "C" letter*.** E.g. on ES/EX/EC:
  `C0`-`C127` are 16-bit counters, while `C235`-`C254` are the "32-bit
  counting up/down high-speed counter" range — a completely different
  sub-range of the same device type, not a register pair. (The exact
  boundary is CPU-model-dependent: EC3-8K instead splits it as `C0`-`C199`
  16-bit vs. `C200`-`C254` 32-bit.) This is exactly what the CIP manual's
  separate `HC` object (Class `0x357`) corresponds to — Delta's EtherNet/IP
  module exposes the 32-bit C sub-range as its own CIP class because it
  needs a different Instance/data width, even though from the ladder
  programmer's perspective it's still just "C". `readC32`/`writeC32` are
  plain aliases for `readHC`/`writeHC` reflecting this — **you must know
  which range your specific counter number falls in** and call `readC` or
  `readC32` accordingly; this driver doesn't auto-detect it (the boundary
  isn't fixed across Delta CPU models, so guessing would risk being wrong
  for a device other than the ones tested here).
- **T (timer) 32-bit does not exist, confirmed** — the manual's own device
  table lists timer present values as one flat range (e.g. `T0`-`T127` on
  ES/EX/EC, `T0`-`T255` on EC3-8K) with no 16-bit/32-bit split anywhere,
  unlike C. No `readT32`/`writeT32` is implemented, and none is planned
  unless new evidence turns up.
- **On the AS300/SX3 specifically, C and HC are fully separate ranges**
  (`C0`-`C511` 16-bit, `HC0`-`HC255` 32-bit — see the range table below),
  not a split *within* one number line the way ES/EX/EC's `C0`-`C127` vs.
  `C235`-`C254` is. Same CIP-level mechanism either way (`HC` is always its
  own class, `0x357`), just a reminder that the specific boundary numbers
  above are DVP-family-specific, not universal.

### Real device ranges (AS300/SX3) and octal I/O labels (2026-09)

The real, official register ranges for the AS300 CPU (the SX3 test unit)
are saved at
[docs/dvp-plc-device-ranges.md](../../docs/dvp-plc-device-ranges.md#as-series--sx3-as300-cpu):
`X`/`Y` 0-377 octal (256 points each), `M` 0-8191, `SM` 0-2047, `S`
0-2047, `T` 0-511, `C` 0-511, `HC` 0-255, `D` 0-29999, `SR` 0-2047. Every
type this driver implements was live round-trip tested at the top of its
real range against the real SX3 (2026-09) — see
[examples/delta-sx3-full-roundtrip.js](../../examples/delta-sx3-full-roundtrip.js),
which passed cleanly end to end.

**`X`/`Y` labels are literal octal digits**, confirmed against that same
table (`X10` = octal `10` = decimal `8`, not decimal ten — digits `8`/`9`
never appear because it's genuinely base-8 formatting). This resolves the
long-standing "no octal conversion implemented" open item:
`octalLabelToIndex(label)` / `indexToOctalLabel(index)`
([src/delta/registers.js](registers.js)) do the conversion
(`parseInt(label, 8)` / `index.toString(8)`, nothing more), and
`readXBitLabel(label)` / `readYBitLabel(label)` / `writeYBitLabel(label, v)`
wrap it so you can pass a label directly instead of converting by hand:

```js
await plc.readXBitLabel('X10');       // same point as plc.readXBit(8)
await plc.writeYBitLabel('Y17', true); // Y17 octal = decimal 15
```

**`W` and `FR` (and the index register `E`) have no known CIP mapping.**
They exist as ladder-programming device types on the AS-series
(`W0`-`W29999`, `FR0`-`FR65535`, `E0`-`E14`) but Ch. 8.12 of the manual
doesn't document a CIP class for any of them, and a live sweep of classes
`0x35A`-`0x360` (right after `SR`'s `0x359`) on the real SX3 found nothing
— every one answered `PathDestinationUnknown`. Not implemented; see
[docs/dvp-plc-device-ranges.md](../../docs/dvp-plc-device-ranges.md#as-series--sx3-as300-cpu)
for the full writeup and Open items below.

### `'es2'` — DVP-ES2-E (confirmed on a real DVP32ES2-E)

**2026-09 correction — the D/T/C addressing was wrong, now fixed pending
live re-confirmation.** Everything below Domain J previously described was
based on the AS/AH-series manual's addressing convention (Ch 8.12), which
turned out to be the **wrong manual** for this device family. A second
Delta manual — the DVP-SE/ES2-E/DVP26SE Operation Manual's own Appendix
B.5.2 — documents a genuinely different Instance/Attribute scheme for the
same Class IDs. Full side-by-side transcription:
[docs/delta-cip-object-reference.md](../../docs/delta-cip-object-reference.md).

The short version: `D` (Class `0x352`) has **no Instance 2 at all** — its
one and only instance (**Instance 1**) already carries the numeric 16-bit
value directly, at a **flat Attribute = D number** (D0=attribute 0,
D9999=attribute 9999). The old implementation treated Instance 1 as a
*bit*-enumeration view (`wordIndex*16+bitIndex`, the convention D actually
uses on `'sx3'`) and used a separate Assembly-window mirror just to read D
at all, having concluded write was an unsolved mystery. That formula was
simply the wrong addressing for this family: `bitAttribute(100, 0)` = 1600
targets **D1600** under this device's real scheme — a genuine, valid,
writable register, just not the one being aimed at. It never showed up in
the Assembly mirror (which only covers D0-D799) because D1600 is outside
that range, not because it's an isolated scratch store. Separately, the
manual's own 8-connection Assembly table explains why writes through the
Assembly O->T instances went nowhere visible either: Connection2's
Output/O->T side defaults to **D3100-D3199**, not D100-D199 — a
completely different range than what this driver was reading back to
check. Full detail on both findings, plus the still-unresolved Forward_Open
config-override attempt, is preserved in git history (see
`docs/delta-cip-object-reference.md`'s "Key takeaway" section for the
short version).

Also corrected: `T`/`C`'s **numeric current value** lives at **Instance
2** (Attribute = T/C number directly) — previously assumed absent
entirely, based on limited early testing done before this manual was
found. `C`'s 32-bit range (`C200`-`C255` on this device) lives **inside
that same Instance 2**, just as a 4-byte DINT instead of a 2-byte INT —
not a separate `HC` class (`HC`/`0x357` is confirmed absent via a full
class sweep, unchanged from before).

To keep naming consistent with the `'sx3'` profile (where `readT`/`readC`
have always meant the numeric value), the old contact-bit-only
`readT`/`writeT`/`readC`/`writeC` are now `readTBit`/`writeTBit`/
`readCBit`/`writeCBit`.

| Method | Register | Access | Status |
|---|---|---|---|
| `readX(n)` | X (input) | read-only | ✅ live |
| `readY(n)` / `writeY(n, v)` | Y (output) | read/write | ✅ live |
| `readM(n)` / `writeM(n, v)` | M (marker/coil) | read/write | ✅ live |
| `readS(n)` / `writeS(n, v)` | S (step) | read/write | ✅ live |
| `readTBit(n)` / `writeTBit(n, v)` | T contact | read/write | ✅ live (was `readT`/`writeT`) |
| `readCBit(n)` / `writeCBit(n, v)` | C contact | read/write | ✅ live (was `readC`/`writeC`) |
| `readD(n)` / `writeD(n, v)` | D, `n` = 0-9999 | read/write | 🔶 **corrected 2026-09, per manual, not yet live-re-tested** (device offline) |
| `readD32(n)` / `writeD32(n, v)` | D, 32-bit (Dn+Dn+1) | read/write | 🔶 rides on `readD`/`writeD`, same status |
| `readT(n)` / `writeT(n, v)` | T numeric value | read/write | 🔶 **new, per manual, not yet live-tested** |
| `readC(n)` / `writeC(n, v)` | C numeric value (DINT at `n>=200`) | read/write | 🔶 **new, per manual, not yet live-tested** |
| `readC32(n)` / `writeC32(n, v)` | alias for `readC`/`writeC` | read/write | 🔶 same status — no separate HC class on this device |
| `readHC` / `writeHC` / `readSM` / `readSR` | HC/SM/SR | — | not implemented — these classes don't exist on this device at all (confirmed via a full class sweep) |

**Next step:** run `node examples/delta-es2.js <host>` (and a dedicated
D/T/C round-trip check) against the real ES2E once it's back on the
network, and update this table's 🔶 rows to ✅ or document what actually
happened if it doesn't match the manual.

**Octal addressing (X/Y only):** unchanged from before — `readXBitLabel`/
`readYBitLabel`/`writeYBitLabel` accept a label like `'X10'` directly. See
the `'sx3'` section above for the conversion details.

**Octal addressing (X/Y only), resolved 2026-09:** Delta's own convention
for X and Y labels is octal, not decimal — `X0`-`X7`, then `X10`-`X17`
(`X10` octal = 8 decimal), `X20`-`X27`, and so on; digits 8 and 9 never
appear. `readXBitLabel(label)` / `readYBitLabel(label)` /
`writeYBitLabel(label, v)` accept the label directly (`plc.readXBitLabel('X10')`
is the same point as `plc.readXBit(8)`) — see the `'sx3'` section above for
the conversion details, which apply identically here since both profiles
share the same underlying bit-mode addressing.

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

assembly-window.js       Generic primitive: read/write a plain word inside
                          a generic Assembly instance's Data attribute. Not
                          Delta-specific in itself — reusable for any device
                          without Register Objects.

device-types/
  index.js                 Profile registry: register(key, profile) /
                            get(key) / list(). Adding a new PLC type means
                            adding one file here and registering it.
  sx3.js                     Profile: thin passthrough to registers.js
                               (word-mode Register Objects).
  es3.js                      Profile: identical to sx3.js (spreads it),
                               registered under its own name for clarity —
                               DVP-ES3/EX3 share sx3's manual entry and EDS
                               structure but are unconfirmed on real hardware.
  es2.js                      Profile: bit-mode Register Objects for
                               X/Y/M/S (Instance 1, flat attribute) plus
                               T/C contact bit (readTBit/readCBit); D/T/C
                               numeric value per manual Appendix B.5.2 —
                               D at Instance 1 (flat attribute = D number),
                               T/C numeric at Instance 2 (see
                               docs/delta-cip-object-reference.md).
                               Corrected 2026-09, pending live
                               re-confirmation. HC/SM/SR unsupported
                               (class doesn't exist on this device).

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
   `getAttribute()` against Identity) to confirm basic connectivity. Then
   run `node examples/discover-cip-classes.js <host>` — a full class sweep
   (0x0001-0x03FF by default, covering every standard CIP object and
   Delta's whole vendor range in one pass) that tells you up front which
   classes the device implements at all, so you're not guessing blind.
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

- **ES2 D/T/C — live re-confirmation needed.** 2026-09: found a second
  Delta manual (Appendix B.5.2, see
  [docs/delta-cip-object-reference.md](../../docs/delta-cip-object-reference.md))
  documenting a different, and much simpler, addressing scheme than what
  this profile originally implemented: D is Instance 1 (not 2) with a flat
  Attribute = D number (explaining why every previous write attempt landed
  nowhere checkable — see the reference doc's "Key takeaway"), and T/C's
  numeric value is at Instance 2 (previously assumed absent). `es2.js` has
  been rewritten to match the manual, but the real ES2E was offline when
  this was done — **nothing in the corrected `readD`/`writeD`/`readT`/
  `writeT`/`readC`/`writeC` has been live-tested yet.** Run
  `examples/delta-es2.js` (and a D/T/C round-trip) against the real device
  next and update src/delta/README.md's `'es2'` table accordingly. If the
  manual turns out not to match this exact device after all, the old
  Assembly-window D-mirror approach and the Forward_Open
  Configuration-Instance investigation are both preserved in git history
  (`git log -- src/delta/device-types/es2.js`) as a fallback starting
  point.
- **`W`/`FR`/`E` (AS300/SX3) have no known CIP mapping** — they exist as
  ladder-programming device types (`W0`-`W29999`, `FR0`-`FR65535`,
  `E0`-`E14`) but no CIP class is documented for any of them in Ch. 8.12,
  and a live sweep of classes `0x35A`-`0x360` on the real SX3 found nothing
  (`PathDestinationUnknown` on all of them). Needs either a manual
  reference this project doesn't have yet, or a different investigative
  approach (e.g. checking whether they're exposed as a sub-range of some
  other class's attribute space rather than their own class).
- **C 16-bit/32-bit range boundary is not enforced or auto-detected** —
  intentionally, since it differs by CPU model (confirmed `C235` on
  ES/EX/EC vs. `C200` on EC3-8K — see
  [docs/dvp-plc-device-ranges.md](../../docs/dvp-plc-device-ranges.md)).
  Calling `readC`/`writeC` on a counter number that's actually in the
  32-bit range for your specific PLC (or vice versa) will silently read/
  write the wrong CIP object rather than erroring — know your device's
  range before choosing `readC` vs. `readC32`.
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
