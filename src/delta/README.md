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
| `readD(n)` | D (data register), `n` = 0-799 | **read-only** | ✅ live — via 8 Assembly-window mirrors (Instances 101/103/105/.../115), NOT the vendor Register Object — see below |
| `writeD(n, v)` | D | — | ❌ **no working path found**, exhaustively tried — see below |
| `readD32(n)` | D, 32-bit (Dn+Dn+1) | read-only | ✅ live, via two `readD` mirror reads |
| `writeD32(n, v)` | D, 32-bit | — | ❌ same dead end as `writeD` (it's built on top of it) |
| `readHC` / `writeHC` / `readSM` / `readSR` | HC/SM/SR | — | not implemented — these classes don't exist on this device at all |

**The D exception, explained:** Class `0x352`'s bit-mode instance is a
real, working read/write store on this device — but a completely
**separate one** from the PLC's actual D-table. Writes made through it
never show up in the Assembly-instance mirrors below (which *are* proven
connected to the real D-table), even with a delay, or with an active
Forward_Open connection kept alive throughout.

**D read range, and how it was found (2026-09):** Instance 101 was
originally assumed to be the *only* window and to cover the full readable
range — that assumption was wrong. The device owner separately configured
a real SX3 (as EtherNet/IP Scanner, via EIP Builder's exchange table) to
write its own D100 into this ES2's D100, and that write landed for real
(confirmed live in WPLSoft: ES2 D100 became `1111`). Searching every
Assembly instance afterward for the value `1111` found it not at Instance
101, but at **Instance 103, offset 0** — proving Instance 101 only covers
D0-D99 (its size, 200 bytes, is exactly 100 words), and D100 onward lives
in *separate* windows on the other Connections' T->O instances. Checking
the remaining instances on the same pattern confirmed all 8:

| D range | Assembly instance (T->O) |
|---|---|
| D0-D99 | 101 |
| D100-D199 | 103 |
| D200-D299 | 105 |
| D300-D399 | 107 |
| D400-D499 | 109 |
| D500-D599 | 111 |
| D600-D699 | 113 |
| D700-D799 | 115 |

D0-D99 and D100-D199 are confirmed via a written marker each (`10` and
`1111` respectively); D200-D299/D300-D399/D600-D699/D700-D799 read
all-zero on this device (nothing distinguishing to match yet, but follow
the identical per-Connection pattern); D400-D499 and D500-D599 are
confirmed by virtue of already containing genuine non-zero live PLC data
consistent with the same pattern (e.g. `D408=1800`, `D500=21`, `D502=62`),
without needing an additional written test marker. `readD(n)` for `n`
outside `0`-`799` throws a `RangeError` immediately rather than guessing.
This 8-window mapping is specific to **this one device's current I/O
configuration** — re-confirm with the known-pattern technique before
assuming it on another ES2.

Given this new instance mapping, two more write mechanisms were tried
specifically targeting D100/Instance 103's O->T counterpart (Instance
102, part of Connection2): an explicit `Set_Attribute_Single` write to
Instance 102 offset 0, and a full `Forward_Open` using Connection2's exact
path (`Config=129`, `O2T=102`, `T2O=103`) with cyclic UDP O->T data. Both
failed the same way as every earlier attempt — the target D100 stayed at
`1111` throughout. Combined with the earlier sweep (writing a distinct
marker to every O->T Assembly instance 100, 102, 104, 106, 108, 110, 112,
114 individually and scanning all 8 T->O instances plus the D-mirror for
it), no CIP-level technique tried so far reproduces what EIP Builder's
Scanner-side exchange table achieves. So: `readD` uses the Assembly
mirrors (word-level, efficient, real), and `writeD`/`writeD32` currently
just fail clearly rather than silently writing to nowhere. This looks
like it needs either a mechanism this driver hasn't tried yet (packet
capture of the real SX3-to-ES2 exchange would settle it definitively) or
is a genuine firmware/configuration limitation — see Open items.

**Re-checked specifically at D100 after the Instance 103 discovery
(2026-09):** the original "isolated scratch store" conclusion about
Class `0x352`'s bit-mode instance was reached before Instance 103 was
known to exist, so it had only ever been cross-checked against D0-D99
(Instance 101). Wrote a distinct 16-bit pattern (`0b0101010101010101`) to
D100 via 16 individual bit-mode writes (`bitAttribute(100, 0..15)`),
confirmed it landed correctly by reading the same bit-mode store back
(exact match), then re-read D100 through Instance 103 — unchanged. So the
isolation is confirmed at D100 too, not just D0-D99: genuinely two
separate stores, not a stale conclusion from checking the wrong window.
(Incidentally, D100 via Instance 103 read `3` during this test, not the
`1111` from the original write — the real SX3-to-ES2 exchange is still
cyclically live and D100's value keeps changing with whatever the SX3's
own D100 currently is.)

**Also checked: does the 32-bit counter range hide behind a similar
trick?** See the `'sx3'`/T-C-limitation discussion above (T/C limitation
paragraph) — no, `C`'s bit-mode is a flat one-bit-per-counter contact
enumeration with a hard ceiling at `C255`, and the `D`-style
`wordIndex*16+bitIndex` scheme doesn't respond at all for `C`. No hidden
32-bit access exists on this device via any addressing scheme tried.

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
This includes the 32-bit counter range (`C235`-`C254` on this CPU family,
docs/dvp-plc-device-ranges.md's ES/EX/EC table) — investigated 2026-09 on
the theory that since `HC` (Class `0x357`) doesn't exist on this device at
all, maybe the 32-bit *value* was still reachable through `C`'s own class
(`0x356`, which does exist) at those higher counter numbers. Live-tested
two ways: (1) the contact bit for `C230`-`C260` — all answer normally
(one flat bit per counter number, `C254` happened to read `true`, nothing
distinguishes the "32-bit" numbers from any other), and this device's real
`C` range hard-stops at `C255` (`C256`+ is `PathDestinationUnknown`); (2)
the `wordIndex*16+bitIndex` bit-enumeration scheme (the same one `D` uses)
applied to `C235` — every attribute in that range also came back
`PathDestinationUnknown`. So there's no hidden word-level access lurking
behind a different addressing scheme: the 32-bit counter *value* is simply
not reachable via CIP on this device, full stop — same underlying
limitation as `T`/`C`'s 16-bit current value, not a separate gap.

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

assembly-window.js       Generic fallback primitive: read/write a plain
                          word inside a generic Assembly instance's Data
                          attribute. Not Delta-specific in itself — reusable
                          for any device without Register Objects.

es2-fallback-profile.js   One confirmed device's assembly-window mapping:
                           D0-D799 read-only, across 8 windows (Instances
                           101/103/.../115, 100 words each). NOT a general
                           DVP-ES2 convention — re-confirm per device.

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

- **ES2 D write** — no working path found. Tried: explicit
  `Set_Attribute_Single` write to every O->T Assembly instance (100, 102,
  104, 106, 108, 110, 112, 114); a full `Forward_Open` + cyclic UDP write
  on Connection1 and specifically on Connection2 (whose T->O side,
  Instance 103, is proven to mirror D100-D199), with and without a 32-bit
  Run/Idle header and a Connection Configuration Data segment; and Class
  `0x352` bit-mode write (works, but writes to an isolated scratch store,
  not the real D-table). A real working mechanism is known to exist — EIP
  Builder's Scanner-side exchange table (configured on a real SX3) — so
  this is very likely solvable, just not yet reproduced at the CIP wire
  level by this driver. Packet capture of that real exchange (`pktmon` on
  Windows, run as Administrator) is the most concrete next step.
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
