# DVP-PLC device ranges (from Delta's DVP-PLC Application Manual)

Reference tables pasted by the project owner (2026-09), source: Delta's
*DVP-PLC Application Manual*, "2 Functions of Devices in DVP-PLC" chapter —
**not** the EtherNet/IP manual (`DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf`)
used elsewhere in `docs/`. This is the ladder-programming-side device model;
cross-referencing it against the CIP-side Vendor-Specific Register Objects
(`src/delta/registers.js`, `src/delta/README.md`) resolved two open
questions during that work:

- **C (counter) has separate 16-bit and 32-bit number ranges within the
  same letter** — not two different device types. This is exactly what
  the CIP manual's separate `HC` object (Class `0x357`) corresponds to.
- **T (timer) has no 32-bit range at all**, confirmed by the device table
  listing timer present values as one flat range with no bit-width split
  — unlike C. No 32-bit timer support exists in this driver as a result.

See `src/delta/README.md`'s "32-bit (DINT) access" section for how this
plays out in the driver's API (`readD32`/`writeD32` vs `readC32`/`writeC32`
vs. no `readT32`).

## ES/EX/EC Series CPU

(EC3-8K is a separate, newer CPU family with expanded ranges — see below.)

| Type | Device | Item | Range | Total | Function |
|---|---|---|---|---|---|
| X | External input relay | | `X0`-`X177`, 128 points, **octal** | 256 | Corresponds to external input points |
| Y | External output relay | | `Y0`-`Y177`, 128 points, **octal** | (with X) | Corresponds to external output points |
| M | Auxiliary relay | General purpose | `M0`-`M511`, `M768`-`M999`, 744 points | 1,280 | On/Off in the program |
| | | Latched* | `M512`-`M767`, 256 points | | |
| | | Special purpose | `M1000`-`M1279`, 280 points (some latched) | | |
| T | Timer | 100ms | `T0`-`T63`, 64 points | 128 | Contact turns On when target reached |
| | | 10ms (`M1028`=On) | `T64`-`T126`, 63 points (shares range with 100ms, selected by `M1028`) | | |
| | | 1ms | `T127`, 1 point | | |
| C | Counter | 16-bit up (general) | `C0`-`C111`, 112 points | 128 (16-bit) | Contact turns On when target reached |
| | | 16-bit up (latched*) | `C112`-`C127`, 16 points | | |
| | | 32-bit up/down, 1-phase 1 input (latched*) | `C235`-`C238`, `C241`, `C242`, `C244`, 7 points | 13 (32-bit) | |
| | | 32-bit up/down, 1-phase 2 inputs (latched*) | `C246`, `C247`, `C249`, 3 points | | |
| | | 32-bit up/down, 2-phase 2 inputs (latched*) | `C251`, `C252`, `C254`, 3 points | | |
| S | Step | Initial step (latched*) | `S0`-`S9`, 10 points | 128 | Used for SFC |
| | | Zero return (latched*, with `IST`) | `S10`-`S19`, 10 points | | |
| | | Latched* | `S20`-`S127`, 108 points | | |
| D | Data register | General purpose | `D0`-`D407`, 408 points | 600 | Data storage; `E`/`F` used for index indication |
| | | Latched* | `D408`-`D599`, 192 points | | |
| | | Special purpose | `D1000`-`D1311`, 312 points | (separate 312) | |

Register (word data) present-value ranges:
- **T** present value: `T0`-`T127`, 128 points (16-bit only — no 32-bit range).
- **C** present value: `C0`-`C127` = 16-bit counter, 128 points; `C235`-`C254` = 32-bit counter, 13 points.

Also present on this CPU family (not currently used by this driver):
Index registers `E`, `F` (2 points); Pointers `N0`-`N7` (master control
nesting), `P0`-`P63` (CJ/CALL); Interrupts `I001`/`I101`/`I201`/`I301`,
`I6□□` (timed), `I150` (communication); Constants `K` (decimal,
16-bit `-32768..32767` / 32-bit `-2147483648..2147483647`), `H`
(hexadecimal, 16-bit `0000-FFFF` / 32-bit `00000000-FFFFFFFF`).

## EC3-8K Series CPU (FW V8.60 or later)

Notably larger address space than ES/EX/EC, and the C 16-bit/32-bit
boundary is in a **different place** — concrete proof this split is
CPU-model-dependent, not a fixed convention to hardcode.

| Type | Device | Item | Range | Total |
|---|---|---|---|---|
| X | External input relay | | `X0`-`X177`, 128 points, **octal** | 256 |
| Y | External output relay | | `Y0`-`Y177`, 128 points, **octal** | (with X) |
| M | Auxiliary relay | General purpose | `M0`-`M511`, `M768`-`M999`, `M2000`-`M2047` | 4,096 |
| | | Latched | `M512`-`M767`, `M2048`-`M4095` | | |
| | | Special purpose | `M1000`-`M1999`, 1,000 points | | |
| T | Timer | 100ms/10ms/1ms (several sub-ranges) | `T0`-`T255` overall | 256 |
| C | Counter | 16-bit up | `C200`-`C234` (35 pts) + `C235`-`C254` (13 pts) | 248 |
| | | 32-bit up/down | `C200`-`C215` (16 pts) + `C216`-`C234` (19 pts) | | |
| S | Step | | `S0`-`S1023` (several sub-ranges) | 1,024 |
| D | Data register | General purpose | `D0`-`D407`, `D600`-`D999`, `D3920`-`D4999` | 5,000 |
| | | Latched | `D408`-`D599`, `D2000`-`D3919` | | |
| | | Special purpose | `D1000`-`D1999`, 1,000 points | | |

Present-value ranges on this CPU: **T** `T0`-`T255` (256 points, 16-bit
only); **C** `C0`-`C199` = 16-bit (200 points), `C200`-`C254` = 32-bit (48
points) — note this boundary (`C200`) differs from the ES/EX/EC table's
`C235` boundary above.

## AS-series / SX3 (AS300 CPU)

Pasted by the project owner (2026-09) for the real SX3 test unit (AS300
CPU). Notably larger than every DVP-family table above, and adds two
device types (`W`, `FR`) that don't appear anywhere in this driver's `D`/`M`/
etc. list.

| Type | Range | Notes |
|---|---|---|
| `X` | `X0`-`X377` | **Octal** — 256 points (`X377` octal = decimal 255), same convention as the DVP tables above |
| `Y` | `Y0`-`Y377` | **Octal** — 256 points |
| `M` | `M0`-`M8191` | |
| `SM` | `SM0`-`SM2047` | |
| `S` | `S0`-`S2047` | |
| `T` | `T0`-`T511` | |
| `C` | `C0`-`C511` | |
| `HC` | `HC0`-`HC255` | |
| `D` | `D0`-`D29999` | |
| `W` | `W0`-`W29999` | no CIP mapping found — see below |
| `FR` | `FR0`-`FR65535` | no CIP mapping found — see below |
| `SR` | `SR0`-`SR2047` | |
| `E` | `E0`-`E14` | index register — no CIP mapping found, not implemented |

**Octal addressing, confirmed:** `X`/`Y` labels are literal octal digits —
`X10` is octal `10` = decimal `8`, not decimal ten. The conversion is
exactly `parseInt(label, 8)` / `index.toString(8)`, nothing more elaborate;
implemented as `octalLabelToIndex()`/`indexToOctalLabel()` in
[src/delta/registers.js](../src/delta/registers.js), with `readXBitLabel`/
`readYBitLabel`/`writeYBitLabel` wrappers that take a label like `'X10'`
directly. This closes the long-standing "octal addressing" open item in
[src/delta/README.md](../src/delta/README.md).

**`W` and `FR` — no known CIP mapping.** These exist as ladder-programming
device types on the AS-series (per this table) but Ch. 8.12 of
[docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf](DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf)
only documents CIP classes for `X`/`Y`/`D`/`M`/`S`/`T`/`C`/`HC`/`SM`/`SR`
(`0x350`-`0x359`) — no entry for `W` or `FR` anywhere in that chapter. A
live sweep of the real SX3 for CIP classes `0x35A`-`0x360` (the sequential
range right after `SR`) found nothing — every one responded
`PathDestinationUnknown`. So either `W`/`FR` aren't exposed over CIP at
all on this device, or they're reachable through some other means not yet
found (e.g. a non-sequential class ID, or as a sub-range of the `D`
object's own attribute space rather than a separate class). Not
implemented; revisit if a manual reference or a new idea turns up. Same
status for `E` (index register) — no CIP class documented or found.

## Practical takeaway for this driver

Given the C 16-bit/32-bit boundary moves between CPU models (`C235` vs.
`C200` in just these two tables), `readC`/`readC32` in this driver
deliberately do **not** try to auto-select based on the counter number —
the caller must know which range applies to their specific PLC model and
call the right method. Hardcoding either boundary would silently produce
wrong results on the other CPU family.
