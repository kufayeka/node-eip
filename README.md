# @kufayeka/ethernet-ip

An ODVA EtherNet/IP (CIP) protocol driver for Node.js, built directly from the
CIP Networks Library (Vol 1 Common Industrial Protocol, Vol 2 EtherNet/IP
Adaptation of CIP) rather than reverse-engineered from existing clients.

Full source bibliography used to build this: [docs/REFERENCES.md](docs/REFERENCES.md).

## Why a new implementation

Existing Node.js EtherNet/IP libraries (`node-ethernet-ip` / `st-ethernet-ip`,
`ethernet-ip-cip`) are scoped narrowly to Rockwell tag read/write over Class 3
explicit messaging, and at least two independent codebases have the same
buffer-corruption bug in fragmented-response handling
([ST-node-ethernet-ip#83](https://github.com/SerafinTech/ST-node-ethernet-ip/issues/83),
[node-red-contrib-cip-suite#15](https://github.com/blanpa/node-red-contrib-cip-suite/issues/15)).
Goal here is a spec-driven stack that also covers the generic CIP object model
and implicit (I/O) messaging in both scanner and adapter roles, not just the
Logix tag-access subset.

## Compliance principle: vendor-neutral by design

**Rockwell/Logix support is mandatory, but it is not the whole target.** This
driver must talk to *any* device that implements EtherNet/IP per the ODVA
spec — Omron, Schneider/Modicon, Siemens (where EIP-capable), Turck, Banner,
Balluff, Hilscher/anybus adapters, third-party I/O blocks, and any adapter
this library itself builds (Phase 3) — not only ControlLogix/CompactLogix.

Concretely, that means:

- The **core path** (encapsulation, message router, generic CIP object
  model — Identity/Assembly/Connection Manager/TCP-IP Interface/Ethernet
  Link, generic `Get_Attribute_Single`/`Set_Attribute_Single`/explicit
  messaging, Forward Open/Close, implicit I/O) must work against any
  ODVA-conformant device using only the base CIP Vol 1/2 spec — no
  vendor-specific service codes required.
- **Vendor-specific extensions** — Rockwell/Logix (symbolic tag paths, Read/Write
  Tag services 0x4C/0x4D/0x52/0x53, abbreviated UDT structure handles, isolated
  in `src/logix/`) and Delta AH/AS-series (vendor-specific Register Objects
  0x350-0x359 for direct D/X/Y/M/etc. access, isolated in `src/delta/`) — are
  **additive compatibility layers** on top of that core, used only when
  talking to that specific vendor's controller. Both reuse the exact same
  generic `encodeEPath`/`buildRequest`/explicit-messaging code as the core —
  neither required any new wire-protocol primitives, only vendor-documented
  addressing conventions layered on top. They must never be a prerequisite
  for the generic scanner/adapter path to function.
- Phase 1 discovery/scan and Phase 3 adapter must be validated (or at least
  designed against the spec text) without assuming a Rockwell target/originator
  on the other end.

## Roadmap

Ordered by what's needed first. Each phase only starts once the previous
phase's checklist items it depends on are done — see the per-domain checklist
below for exact spec references and status.

| Phase | Goal | Status |
|---|---|---|
| 0 | Encapsulation header framing | ✅ Done |
| 1 | **Discovery & handshake** — scan a network for EIP devices, parse Identity, open/close a session | ✅ Done — validated live against a real, non-Rockwell device (Delta AS/SX-3 PLC, `192.168.68.250`) over UDP broadcast, UDP unicast, and TCP |
| 2 | **EIP Scanner** (originator) — vendor-neutral explicit messaging client (any CIP device) + implicit I/O scanning, with Rockwell tag services layered on top for Logix targets | 🔄 In progress — explicit messaging, Forward_Open/Forward_Close, live cyclic Class 1 I/O data, AND a public `Scanner` API wrapping all of it are done & validated live. Left: more common services (Multiple Service Packet), Rockwell/Logix tag services. |
| 3 | **EIP Adapter** (target/device/server) — accept sessions, serve CIP objects, produce/consume I/O; must interoperate with any conformant originator, not only a Rockwell PLC | 🔄 Core done & validated live (loopback, own Scanner as client) — ListIdentity, sessions, Identity/Assembly explicit messaging, Forward_Open/Forward_Close. Real UDP cyclic I/O to another host not yet cross-device tested. |
| 4 | **EDS file** — generate the device description file an adapter built with this library needs so Studio5000/RSLogix (or any EIP engineering tool) can import and configure it | ⬜ Planned |
| 5 | CIP Security (Vol 8), full conformance-test pass, advanced objects (QoS, Port, CIP Safety) | ⬜ Future |

Phase 1 deliverable is concretely: `scan(interfaceOrSubnet)` → list of
`{ address, vendorId, deviceType, productCode, revision, status, serialNumber,
productName }` for every device that answers `ListIdentity`, plus the ability
to `RegisterSession` / `UnRegisterSession` against any one of them (proves the
TCP handshake works before building anything on top of it).

**Live validation (2026-09):** confirmed against a real **Delta Electronics
AS/SX-3 series PLC** (`DVP-SX3`, vendor ID 799, device type 14 = PLC) at
`192.168.68.250` on the LAN — deliberately a non-Rockwell device, to prove the
vendor-neutral core immediately rather than only against a Logix controller:
- `examples/scan-network.js` — UDP broadcast `ListIdentity` found it and
  correctly decoded every Identity field including the big-endian embedded
  Socket Address.
- `scanUdpUnicast()` — UDP unicast `ListIdentity` direct to its IP, same result.
- `examples/probe-device.js` — TCP `ListIdentity` (no session) and then a full
  `RegisterSession` → `UnRegisterSession` handshake both completed cleanly.
- **Second real device found "for free" by the same broadcast scan
  (2026-09):** a `DVP32ES2-E` (`192.168.68.111`, product code 771 — a
  different, older DVP-family PLC, not AS/AH-series) showed up alongside the
  SX3 with zero extra code. Generic explicit messaging and Assembly discovery
  worked identically against it; see Domain J below for what did *not* carry
  over (Delta's vendor-specific Register Objects are AS/AH-series-only).

Two real bugs caught and fixed during this:

1. `EIP_UDP_PORT` was originally defined as `2222` (that's actually the
   separate UDP port used only for cyclic Class 0/1 I/O data) and used as
   the default port for `ListIdentity` UDP calls — which silently broke
   both UDP broadcast and unicast discovery against the real device (TCP
   still worked, since it used a different constant). Fixed by introducing
   `EIP_ENCAPSULATION_PORT = 44818`, the port actually shared by TCP *and*
   UDP for all encapsulation commands (`RegisterSession`, `ListIdentity`,
   `SendRRData`, `SendUnitData`, ...), and keeping `2222`
   (`EIP_IO_UDP_PORT`) reserved for its real, narrower purpose. See
   `src/constants.js` for the corrected, documented distinction.
2. `scanUdp()` defaulted to sending to the global limited-broadcast address
   `255.255.255.255`, which turned out to be unreliable on a host with more
   than one active network interface (this dev machine has two virtual
   adapters, e.g. VMware/Hyper-V, alongside the real LAN NIC) — Windows
   can't unambiguously resolve which interface to emit it from, so the
   packet never reached the device even though the socket call reported no
   error. Fixed by auto-detecting every active, non-internal IPv4
   interface (`ipv4DirectedBroadcasts()` in `src/encapsulation/discovery.js`)
   and sending a subnet-directed broadcast (e.g. `192.168.68.255` for a
   `/24`) on each one — the same approach real EIP scanner tools use.
   `examples/scan-network.js` now finds the Delta SX-3 with zero arguments.

Note on terminology: ODVA's device-description file is called an **EDS**
(Electronic Data Sheet), not ESI — ESI is EtherCAT's equivalent. EDS is what
Studio5000/RSLogix/other EIP engineering tools import to recognize a device
and its parameters/assemblies. Phase 4 targets generating a valid EDS for
devices built with this library's adapter mode.

## Compliance checklist by domain

Status legend: ✅ done · 🔄 in progress · ⬜ planned · ❓ needs research (spec
section not yet confirmed).

### A. Encapsulation Protocol — CIP Vol 2, Ch 2

| Item | Status | Notes |
|---|---|---|
| 24-byte header encode/decode | ✅ | [src/encapsulation/header.js](src/encapsulation/header.js) |
| Common Packet Format (CPF) item parsing | ✅ | [src/encapsulation/cpf.js](src/encapsulation/cpf.js) — generic item list encode/decode |
| ListIdentity (UDP broadcast :44818 + UDP unicast + TCP unicast) | ✅ | [src/encapsulation/discovery.js](src/encapsulation/discovery.js) — validated live against a Delta SX-3 PLC |
| RegisterSession / UnRegisterSession | ✅ | [src/encapsulation/session.js](src/encapsulation/session.js), [src/client.js](src/client.js) — validated live |
| SendRRData (unconnected explicit request) | ✅ | [src/encapsulation/rrdata.js](src/encapsulation/rrdata.js) — validated live against a Delta SX-3 (Get_Attribute_Single) |
| NOP | ⬜ | low priority, rarely used in practice |
| ListServices | ⬜ | phase 2 — reports supported encapsulation services/capability flags |
| ListInterfaces | ⬜ | phase 2 |
| SendUnitData (connected explicit/implicit request) | ⬜ | phase 2/3 — needed once Forward Open exists |

Reference code: [Wireshark `packet-enip.c`](https://fossies.org/linux/wireshark/epan/dissectors/packet-enip.c) for exact field layout; [OpENer](https://github.com/EIPStackGroup/OpENer) `source/src/cip/` for a working adapter-side encapsulation loop; [scala-ethernet-ip](https://github.com/kevinherron/scala-ethernet-ip) for a minimal, readable command-class layout.

### B. CIP Message Router, Path Segments, Common Services — CIP Vol 1, Ch 2 & Appx A/C

| Item | Status | Notes |
|---|---|---|
| Request/response message framing (service, path, data) | ✅ | [src/cip/message-router.js](src/cip/message-router.js) — validated live |
| Logical path segments (Class/Instance/Attribute/Member, 8/16/32-bit, padded EPATH) | ✅ | [src/cip/path.js](src/cip/path.js) |
| Port segments, Data segments, ANSI extended symbol segment | ⬜ | not Rockwell-exclusive as originally assumed — Delta SX-3's own EDS defines a `SYMBOL_ANSI` "Tag Connection" (Connection17), so this is a genuinely vendor-neutral CIP feature some non-Logix devices use too |
| Common services — Get_Attribute_Single (0x0E) | ✅ | used by the live validation below |
| Common services — Set_Attribute_Single (0x10) | ✅ | framing implemented, shares buildRequest()/parseResponse() with Get — [examples/set-attribute.js](examples/set-attribute.js), **validated live against the Delta SX-3** (see below) |
| Common services — Get/Set Attribute All/List, Reset, Create, Delete, ... | ⬜ | same framing, just more service codes to wire up |
| Multiple Service Packet (0x0A) | ⬜ | |
| CIP general status code table | ✅ | [src/constants.js](src/constants.js) `CipGeneralStatus` |

Reference code: [cpppo](https://github.com/pjkundert/cpppo) (arbitrary CIP service requests, clear parser design); [scapy-cip-enip](https://github.com/scy-phy/scapy-cip-enip) status/error code table.

**Investigation note (2026-09, resolved — not a safety concern):** attempted
`Set_Attribute_Single` on Assembly (Class 0x04) Instance 100 Attribute 3
(Data), writing back the exact same 200 zero bytes previously read via
`Get_Attribute_Single` — non-destructive by design. The device rejected it
(general status 0x15, "TooMuchData"), which on its own is an unremarkable,
correctly-decoded CIP error (the request/response framing itself is
validated — same code path as the already-proven Get). Separately, Attribute
4 (Size) on the same instance — previously stable at **200 bytes** across
every prior read — started reading **194 bytes** consistently afterward.
Paused live device-modifying tests at the time pending confirmation this
wasn't a production device; **confirmed by the device owner this is a
bench/test unit, not production** — the size drift is most likely this
PLC's own live ladder program (it was already observed producing a
live-incrementing counter in its T->O data, so it is not an idle/isolated
bench device either — just not a production line).

**Root cause of the original 0x15 rejection, confirmed:** the Assembly
Object's Attribute 3 (Data) write length must match its *current* Attribute
4 (Size) value exactly — 200 bytes was correct when first observed, but by
the time the write was attempted, Size had already drifted to 194 (per the
paragraph above), so the 200-byte write was rejected as `TooMuchData`. Retried
with a 194-byte all-zero write matching the live Size value — **accepted**,
and reading Attribute 3 back afterward confirmed 194 bytes, all zero,
unchanged. This is a real, useful CIP compliance finding, not a driver bug:
**always read Attribute 4 immediately before a Set_Attribute_Single on
Attribute 3**, don't assume a previously-observed size still holds.

### C. CIP Data Types — CIP Vol 1, Appx C

| Item | Status | Notes |
|---|---|---|
| Elementary types: BOOL, SINT/INT/DINT/LINT (+ unsigned), REAL/LREAL | ⬜ | vendor-neutral, CIP Vol 1 base |
| STRING / STRING2 / SHORT_STRING | ⬜ | vendor-neutral, CIP Vol 1 base |
| Arrays (fixed-size, BOOL-packed arrays) | ⬜ | vendor-neutral, CIP Vol 1 base |
| STRUCT / UDT encoding + Rockwell abbreviated structure handle (CRC) | ⬜ | **Logix-specific extension** (`src/logix/`) — see Rockwell "Type Encoding of Logix Structures" doc; generic CIP STRUCT (Vol 1 Appx C) is a separate, vendor-neutral concern |

Reference code: [Rockwell Type Encoding of Logix Structures (PDF)](https://www.rockwellautomation.com/content/dam/rockwell-automation/sites/downloads/pdf/TypeEncode_CIPRW.pdf); [pycomm3](https://github.com/ottowayi/pycomm3) type encoding source; [libplctag](https://github.com/libplctag/libplctag) UDT handling.

### D. CIP Object Model — required objects, CIP Vol 1 Ch 5 & Vol 2 Ch 5

| Object | Class | Status | Notes |
|---|---|---|---|
| Identity | 0x01 | ⬜ | phase 1 (read), phase 3 (serve) |
| Message Router | 0x02 | ⬜ | phase 2/3 |
| Assembly | 0x04 | ⬜ | phase 3 — carries I/O data |
| Connection Manager | 0x06 | ⬜ | phase 2/3 — Forward Open/Close |
| TCP/IP Interface | 0xF5 | ⬜ | phase 3 |
| Ethernet Link | 0xF6 | ⬜ | phase 3 |
| QoS | 0x48 | ⬜ | future |
| Port | 0xF4 | ⬜ | future |

Reference code: [OpENer](https://github.com/EIPStackGroup/OpENer) `cipidentity.c`, `cipassembly.c`, `cipconnectionmanager.c` — the canonical adapter-side object implementations, ODVA-conformance-tested.

### E. Connection Manager & Connections — CIP Vol 1, Ch 3

| Item | Status | Notes |
|---|---|---|
| Forward Open (classic, ≤511 bytes/direction) | ✅ | [src/cip/connection-manager.js](src/cip/connection-manager.js) — **validated live against the Delta SX-3**, see below |
| Forward Close | ✅ | same file — validated live |
| RPI negotiation | ✅ | requested 20,000 µs, device granted exactly that (O->T API = T->O API = 20,000 µs) |
| Class 1 I/O connections — point-to-point, full cyclic data (both O->T and T->O) | ✅ | [src/cip/io-connection.js](src/cip/io-connection.js) — **validated live against the Delta SX-3**, see below; "Modeless" real-time format only (no Run/Idle header) |
| Unconnected Send (Vol 1, 2-6) | ⬜ | needed once messages must be routed across a backplane/bridge, not required for a single-hop device like the Delta |
| Large Forward Open | ⬜ | not needed yet — every connection tested so far fits under 511 bytes |
| Class 1 I/O connections — multicast | ⬜ | phase 3+ |
| Class 3 explicit connections | ⬜ | phase 2 |
| Connection timeout multiplier | ✅ | encoded, default value 3 (×32) — not yet exercised by an actual timeout scenario |

Reference code: [PLCTalk: EtherNet/IP Forward Open thread](https://www.plctalk.net/forums/threads/ethernet-ip-forward-open.121936/) (real Wireshark-trace walkthrough); [rtautomation.com DeviceNet CIP Connections](https://www.rtautomation.com/rtas-blog/devicenet-cip-connections/) (shared Connection Manager model); [idc-online.com multicast paper](https://www.idc-online.com/technical_references/pdfs/data_communications/Ethernet_IP_Multicasting_Explained.pdf).

**Real Forward-Open target found on the Delta SX-3 (2026-09):** swept its
Assembly Object (Class 0x04) instances 1–254 via `Get_Attribute_Single`
Attribute 4 (Size) — [examples/discover-assemblies.js](examples/discover-assemblies.js), read-only, no writes.
Found instances **100–115**, each reporting **200 bytes** (Attribute 3/Data
confirmed as 200 zero bytes right now — device presumably idle/no live I/O
mapped), plus instance **199** at **0 bytes**.

**Confirmed against Delta's own EDS file** (`eds/031F000E0F0600010001.eds`,
ODVA/EZ-EDS format, `[File]`/`[Device]` fields match our live ListIdentity
exactly: VendCode 799, ProdCode 3846, Rev 1.1, "DVP-SX3"). Its
`[Connection Manager]` section defines 17 named connections with the exact
byte-level EPATH ODVA expects, e.g. Connection1:

```
Path = 20 04 24 80 2C 64 2C 65
       Class 0x04(Assembly) / Instance 0x80(128, Config) /
       ConnPoint 0x64(100, O->T) / ConnPoint 0x65(101, T->O)
```

Connections 1–8 follow the same pattern incrementing by one Config/O-T/T-O
triple each time (129/102/103, 130/104/105, ... 135/114/115) — exactly the
100–115 range the live probe found, now with a name and a role for each.
Connections 9–16 repeat the same 8 Config/T->O pairs but substitute
**instance 199 (0x C7) as O->T** — confirming 199 is indeed the "NULL"
placeholder used for listen-only/input-only connections (no data
originator→target). **Connection17 ("Tag Connection")** uses the literal
path token `SYMBOL_ANSI` instead of numeric segments — i.e. Delta *also*
implements the ANSI Extended Symbol Segment (Domain B) for tag-style
addressing, so that segment type is **not Rockwell/Logix-exclusive** as
initially assumed; worth re-checking Domain B's note once implemented.

Also pinned down the two connection parameters that were otherwise going to
require live trial-and-error:
- **RPI** (`Param1`): min 5,000 µs, max 1,000,000 µs, default **20,000 µs (20 ms)**.
- **I/O data size** (`Param18`): min 0, max 500, default **200 bytes** — this
  is exactly the 200 bytes the live probe measured, so the device is
  currently running its EDS-declared default configuration.

`[Capacity]`: `MaxIOConnections = 16` (matches Connections 1–16),
`MaxMsgConnections = 8`.

**Live validation (2026-09):** [examples/forward-open.js](examples/forward-open.js)
ran Forward_Open against the Delta SX-3 using exactly Connection1's path
(`20 04 24 80 2C 64 2C 65`) with RPI 20,000 µs and O->T/T->O size 200 bytes —
**succeeded on the first attempt**, no trial-and-error needed thanks to the
EDS ground truth above. The device granted the requested RPI exactly
(otApiUs = toApiUs = 20,000) and returned its own O->T Network Connection ID
(target-assigned, as expected) while echoing back our randomly-generated
T->O Network Connection ID unchanged (also as expected — that field is
authoritative from the originator, not the target). Forward_Close then
tore the connection down cleanly using the same connection
serial/vendor/originator-serial triple. This validates the full
Forward_Open/Forward_Close request/response framing end-to-end against a
real, non-Rockwell device.

**Cyclic I/O data — live validation (2026-09):**
[examples/io-listen.js](examples/io-listen.js) opened Connection1, bound a
UDP socket on port 2222 (`EIP_IO_UDP_PORT` — distinct from the TCP
encapsulation port used everywhere else so far), and:
- **Received real T->O data from the Target**: 219 datagrams in 5 seconds
  at the negotiated 20 ms RPI (≈250 expected; some loss is normal for
  best-effort UDP plus this being a first-pass, non-realtime-tuned Node.js
  timer loop). Every payload was distinct — the first 2 bytes are a live
  incrementing counter that matches the datagram's own CIP sequence number,
  almost certainly the device's demo/example ladder program mapping a scan
  counter into the first I/O word specifically so integrators can visually
  confirm a working connection.
- **Sent our own O->T data to the Target** at the same RPI, all-zero bytes
  (matching the value already observed via explicit messaging earlier, so
  this changed nothing on the device) — this is also what kept the
  connection from timing out for the full 5-second window, since a normal
  (non-listen-only) connection expects both directions to be produced.
- Filtered incoming datagrams by matching the T->O Network Connection ID
  the Target echoed back in the Forward_Open response, exactly as the spec
  intends — proven necessary in practice since the port is shared by any
  concurrent connection.

This is, concretely, the exact vendor-neutral CIP mechanism underneath what
Rockwell markets as "Produced/Consumed Tags" — proven end-to-end against a
non-Rockwell device via the device's generic Assembly Object rather than a
Logix Symbol path.

### F. Discovery & Scanning — practical feature layer (Phase 1 priority)

| Item | Status | Notes |
|---|---|---|
| UDP broadcast `ListIdentity` across a subnet/interface | ✅ | `scanUdp()` — [examples/scan-network.js](examples/scan-network.js), confirmed against a real Delta SX-3 |
| Parse Identity reply fields (vendor ID, device type, product code, revision, status word, serial number, product name, state) | ✅ | [src/encapsulation/identity.js](src/encapsulation/identity.js), incl. the big-endian embedded Socket Address quirk |
| Per-IP UDP unicast `ListIdentity` | ✅ | `scanUdpUnicast()` |
| Per-IP TCP unicast `ListIdentity` | ✅ | `probeTcp()` — [examples/probe-device.js](examples/probe-device.js) |
| `ListServices` follow-up (capability flags) | ⬜ | phase 2 |
| `RegisterSession` → `UnRegisterSession` round trip per discovered device | ✅ | `EIPSession` — confirmed against a real device |
| Device inventory API (`scanUdp()` returning a structured list) | ✅ | |

Reference code: [OpENer](https://github.com/EIPStackGroup/OpENer) (adapter-side ListIdentity response, useful to know exactly what fields a real device fills in); [scapy-cip-enip](https://github.com/scy-phy/scapy-cip-enip) for crafting/parsing discovery packets in isolation for testing.

### G. EIP Scanner (Originator / Client)

| Item | Status | Notes |
|---|---|---|
| Explicit messaging client (arbitrary CIP service to any class/instance/attribute) | ✅ | `EIPSession.sendUnconnected()` — **validated live against a real, non-Rockwell device** (Delta SX-3: read Identity Vendor ID=799 and Product Name="DVP-SX3" via Get_Attribute_Single, cross-checked against the Phase 1 ListIdentity values) |
| Generic Producer/Consumer (Class 0/1) I/O connections — Assembly-object based, vendor-neutral | ⬜ | phase 2/3 — see Domain E (Forward Open); this is what any two conformant devices (not only Logix) use for cyclic data exchange |
| Implicit I/O scanning (Forward Open + cyclic produce/consume) | ⬜ | phase 2 — vendor-neutral, Assembly-object based |
| *— Rockwell/Logix compatibility layer (additive, not required for the above) —* | | |
| Rockwell tag read/write (0x4C / 0x4D) | ⬜ | Logix-only convenience layer, lives in `src/logix/` |
| Fragmented tag read/write (0x52 / 0x53) | ⬜ | must not repeat the [448-byte boundary bug](https://github.com/SerafinTech/ST-node-ethernet-ip/issues/83) other Node libs hit |
| Rockwell "Produced Tag" / "Consumed Tag" (Symbol Object as the Forward Open connection point instead of an Assembly instance) | ⬜ | Logix-specific naming/application of the same generic Producer/Consumer connection mechanism above — `src/logix/`, not required for vendor-neutral I/O |

Reference code: [EIPScanner](https://github.com/nimbuscontrols/EIPScanner) (dedicated scanner/originator implementation); [pycomm3](https://github.com/ottowayi/pycomm3) / [libplctag](https://github.com/libplctag/libplctag) (mature tag clients); [cpppo](https://github.com/pjkundert/cpppo).

### H. EIP Adapter (Target / Device / Server)

| Item | Status | Notes |
|---|---|---|
| TCP + UDP encapsulation server (listen, accept, session table) | ✅ | [src/adapter.js](src/adapter.js) — **validated live (loopback)** |
| Session management (handle allocation, per-session state, timeout) | ✅ | handle allocation + cleanup on disconnect/UnRegisterSession; no idle-session timeout yet |
| CIP message router server-side dispatch to object instances | ✅ | class registry (`objects: Map<classId, handler>`), `getAttributeSingle`/`setAttributeSingle` |
| Configurable Identity object (vendor ID, product code, etc. supplied by the device author) | ✅ | [src/cip/objects/identity.js](src/cip/objects/identity.js) — validated live, incl. answering both TCP and UDP `ListIdentity` |
| Assembly object (Input/Output/Config assemblies backed by user data) | ✅ | [src/cip/objects/assembly.js](src/cip/objects/assembly.js) — validated live, including replicating the exact size-mismatch → `TooMuchData` behavior this driver found on real Delta hardware (Domain B) |
| Accept Forward Open as target, produce/consume cyclic I/O data | 🔄 | Forward_Open/Forward_Close request/response validated live over TCP; the resulting UDP cyclic data *production/consumption logic* is unit-tested ([test/connection-handler_spec.js](test/connection-handler_spec.js)) but not yet proven against a real second device — see note below |
| TCP/IP Interface Object, Ethernet Link Object | ⬜ | not started — lower priority, mostly matters for other engineering tools' diagnostics, not required for a scanner to do explicit/implicit messaging |

Must be built and tested against the generic CIP model only — an adapter
built here should be connectable from a Rockwell ControlLogix/CompactLogix,
an Omron NJ/NX, a Schneider M580, or any other conformant scanner without any
vendor-specific accommodation on the adapter side. Vendor interop quirks (if
any surface) get isolated per-vendor, not baked into the core object
implementations.

**Live validation (2026-09):** [examples/adapter-demo.js](examples/adapter-demo.js)
starts a real `EIPAdapter` and drives it with this driver's own client-side
code (`scanUdpUnicast`, `probeTcp`, `EIPSession`) over real TCP/UDP sockets
on localhost — every one of these passed: UDP unicast `ListIdentity`, TCP
`ListIdentity` (no session), `RegisterSession`, `Get_Attribute_Single`
(Identity Vendor ID), `Set_Attribute_Single` on an Assembly instance (with
the adapter's own in-memory buffer verified to actually change), a
deliberate wrong-size write correctly rejected with `0x15 TooMuchData`
(exactly mirroring the real Delta hardware behavior this driver discovered
independently in Phase 2), and a full `Forward_Open` → `Forward_Close`
round trip with the requested RPI granted as-is.

**Known test gap, and why:** this demo does not prove real UDP cyclic I/O
delivery end-to-end. EtherNet/IP I/O always uses the same fixed port (2222)
on both sides — on separate physical devices that's fine, but a Scanner and
an Adapter can't both bind port 2222 on the *same* machine to test the full
data path against each other locally (that's a fundamental protocol/OS
constraint, not an implementation gap). The cyclic-I/O logic itself
(producing the right bytes at the right RPI, consuming into the right
buffer, matching by connection ID) is fully covered by
`test/connection-handler_spec.js` with a mocked send function, and reuses
the exact `cip/io-connection.js` datagram format already proven live
against real Delta hardware in Phase 2 — but proving the *adapter* side of
that specific wire exchange needs a second real host, which wasn't
available for this pass.

Reference code: [OpENer](https://github.com/EIPStackGroup/OpENer) — THE reference adapter implementation (ODVA-authored, conformance-tested); [CIPster](https://github.com/liftoff-sr/CIPster) for a C++ read of the same logic; [EthernetIpSharp](https://github.com/CristianMori/EthernetIpSharp) (rare OSS example that does both adapter and scanner roles).

### I. EDS (Electronic Data Sheet) file generation

| Item | Status | Notes |
|---|---|---|
| Confirm authoritative EDS file-format spec source | ❓ | still not pinned to an ODVA doc/section number — but see below, we now have a real, working example to reverse-engineer the practical structure from in the meantime |
| Sample/reference `.eds` files from real devices for cross-checking output | ✅ | [eds/031F000E0F0600010001.eds](eds/031F000E0F0600010001.eds) — Delta SX-3's actual vendor-issued EDS (EZ-EDS format), fields cross-checked against our own live ListIdentity/explicit-messaging reads and matched exactly |
| EDS generator from an adapter's Identity + Assembly + Parameter definitions | ⬜ | phase 4 — now has a concrete real-world template (`[File]`/`[Device]`/`[Params]`/`[Assembly]`/`[Connection Manager]`/`[Capacity]`/`[TCP/IP Interface Class]`/`[Ethernet Link Class]` sections) to model output on |
| EDS parser (read 3rd-party `.eds`, for scanner-side device awareness) | ⬜ | future, not required for phase 4's "export our own device" goal |

Still flagging the authoritative spec citation honestly as unresolved — but
having a real vendor EDS in-repo means Phase 4 no longer starts from zero.
Key structural finding already worth recording: the `[Connection Manager]`
section's `ConnectionN` entries are the same ground truth used for the
Forward Open work above (Domain E) — an EDS is effectively a machine-readable
version of exactly the information a Forward Open path/RPI/size needs, for
every connection a device advertises support for.

### J. Delta AH/AS-Series Vendor-Specific Registers (additive, Delta-only)

Not ODVA CIP — Delta's own Vendor-Specific Objects, documented in Delta's
"EtherNet/IP Operation Manual" ([docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf](docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf),
Ch. 8.12) — confirmed applicable to the SX3 (AS300 CPU) by the device owner
("AS300 and AH are EIP scanner/adapter [implementations], so it should be
the same"). This is what delivers the **Modbus-like `readD(session, 100)`
direct-register experience** the driver was missing — the addressing
convention turned out to be dramatically simpler than the two options
originally proposed (byte-offset config, or unconfirmed symbolic tags):
**the CIP Attribute ID *is* the register number directly.** No tag database,
no per-device configuration needed — this works the same on any AH/AS-series
device.

**⚠️ Model-specific, not universal across all Delta PLCs (2026-09 finding):**
a network scan turned up a second real device on the same LAN, a
**DVP32ES2-E** (`192.168.68.111`, product code 771 — a different, older DVP
PLC family, not AS/AH-series). The vendor-neutral core worked identically
against it (Identity read confirmed `"DVP32ES2-E"`; Assembly sweep found the
*exact same* 17 instances at the *exact same* sizes as the SX3 — 100-115 at
200 bytes, 199 at 0 bytes), but **`readD()` failed** with general status
`0x05` (`PathDestinationUnknown`) — Class `0x352` simply isn't implemented on
this device. Its EDS (obtained separately, Delta's DVPES2E EIP package) has
no vendor-specific-object hints either way; EDS files don't declare vendor
classes regardless of whether they're supported, so this had to be confirmed
live. **Conclusion: the Register Objects in this domain are an AS/AH-series
feature, not a Delta-wide one** — exactly why this layer lives in `src/delta/`
as an *additive* concern on top of the vendor-neutral core rather than being
assumed universal. A driver caller should not assume `readD()` etc. works
against every Delta device without checking (e.g. read Vendor ID first
via generic `Get_Attribute_Single`, cross-reference the Product Code against
known AS/AH models, or simply try/catch the vendor-specific read and fall
back to generic Assembly I/O).

| Register | Class | Instance | Access | Word type | Status |
|---|---|---|---|---|---|
| X (input) | 0x350 | 1=bit, 2=word | **read-only** | INT | ✅ live-validated |
| Y (output) | 0x351 | 1=bit, 2=word | read/write | INT | ✅ live-validated (word) |
| D (data register) | 0x352 | 1=bit, 2=word | read/write | INT | ✅ live-validated (word read+write round-trip, and bit) |
| M (marker/coil) | 0x353 | 1=bit only | read/write | BOOL | ✅ live-validated (read+write round-trip) |
| S (step) | 0x354 | 1=bit only | read/write | BOOL | ✅ live-validated (read+write round-trip) |
| T (timer) | 0x355 | 1=bit(contact), 2=word(value) | read/write | INT | ✅ live-validated (word read) |
| C (counter) | 0x356 | 1=bit(contact), 2=word(value) | read/write | INT | ✅ live-validated (word read) |
| HC (high-speed counter) | 0x357 | 1=bit(contact), 2=word(value) | read/write | DINT | ✅ live-validated (word read) |
| SM (system marker) | 0x358 | 1=bit only | **read-only** | BOOL | ✅ live-validated |
| SR (system register) | 0x359 | **1**=word (its only instance) | **read-only** | INT | ✅ live-validated |

Implementation: [src/delta/registers.js](src/delta/registers.js) — reuses
the already-validated generic `encodeEPath`/`buildRequest`/`sendUnconnected`
path entirely; no new wire-protocol code was needed, only this addressing
convention. Live example: [examples/delta-registers.js](examples/delta-registers.js).

Bit-mode addressing (e.g. `D0.0`, `D0.1`) is this driver's own
interpretation of the manual's enumeration pattern — `attribute = wordIndex
* 16 + bitIndex` — spot-checked live (`D0` bit 0 read back `false`,
consistent with `D0`'s word value being `0`) but not exhaustively verified
across the full range; treat as provisional until checked against a
register with known nonzero bits.

One real bug caught during live testing: `readWord`/`writeWord` initially
hardcoded Instance 2 for word-mode access on every register type, which is
correct for the dual-mode types (D/X/Y/T/C/HC, which also have a bit mode
at Instance 1) but wrong for **SR**, whose manual entry documents its
*only* instance as Instance **1** (word-type) since it has no separate bit
mode to share numbering with. Fixed via a `wordInstance(classId)` helper
that special-cases word-only register types.

#### Fallback for devices without the Register Objects: Assembly-window (2026-09)

For the DVP32ES2-E (Domain J's "not universal" finding above), a
known-pattern technique found a *device-specific* (not Delta-wide) way to
still read registers directly, entirely through the generic Assembly
Object every CIP device already has:

1. The device owner wrote a distinguishing pattern into the PLC's own
   D-table via ISPSoft/WPLSoft (`D0=10, D1=0, D2=20, D3=0, D4=30, ...`).
2. [examples/discover-assemblies.js](examples/discover-assemblies.js)-style
   full-instance dump + byte-pattern search found an **exact match at
   Assembly Instance 101, byte offset 0** — Instance 101's Data attribute
   (the "Input"/T->O direction one) is a live, read-only mirror of `D0`
   onward, 2 bytes per register, matching Delta's own INT16-LE register
   width.
3. Write side tested and **not yet resolved**: `Set_Attribute_Single` on
   Instance 101 is rejected (general status `0x08 ServiceNotSupported` —
   expected, it's the read/produced direction). Instance 100 ("Output"/O->T)
   *does* accept `Set_Attribute_Single` (status `0x00 Success`), but a
   written marker pattern (`1000..1019` at word offsets 0-19) was **not**
   observed reflected back through the Instance 101 D-mirror — so Instance
   100 is writable at the CIP level, but what (if anything) it's actually
   wired to in the PLC's own register table is unconfirmed. Left in place
   for the device owner to cross-check against their own register monitor.

**Correction (2026-09):** the original version of this note suggested
checking ISPSoft's "I/O mapping table" to resolve the write-side and map
X/Y/M/S/C/T the same way — that assumed every Delta EIP device has one.
Per Delta's own product table (Ch.9 of the manual — see the profile system
below), that tool ("EIP Builder") configures the **Scanner** role, and the
DVP-ES2-E family is **Adapter-capable but NOT Scanner-capable** — so the
tool correctly doesn't exist for it in ISPSoft. That's not a dead end for
Adapter-side reading, though: it's exactly the role this driver already
uses the device in, and Instance 101's D-mirror above is real, working
Adapter-side data — just not something Delta exposes a GUI to configure or
document per-model (Ch.8.5 Assembly Object only documents the AH-series/
AHRTU families, not small PLCs), hence reverse-engineering it live was the
only path either way.

Implementation: [src/delta/assembly-window.js](src/delta/assembly-window.js)
(generic `readAssemblyData`/`writeAssemblyData`/`makeWordWindow` — reuses
the same `encodeEPath`/`buildRequest` core, nothing new at the wire level)
+ [src/delta/es2-fallback-profile.js](src/delta/es2-fallback-profile.js)
(this one confirmed device's mapping specifically — **not** a general
DVP-ES2 convention, must be reconfirmed per device). Live example:
[examples/delta-es2-fallback.js](examples/delta-es2-fallback.js).

#### Explicit device-type profiles: `DeltaDevice` (2026-09)

Given real capability turned out to vary per specific model rather than
along a clean tier boundary — confirmed via Delta's own product table
([docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf](docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf)
Ch.9, "9.1 Adapter Supported" vs "9.3 Scanner Supported"): the DVP-ES2-E/
DVP26SE/DVP12SE family is listed as Adapter-capable but *not*
Scanner-capable, while DVP-SV3/SX3 and DVP-ES3/EX3 are listed as both — a
device answering a generic CIP request successfully doesn't reliably tell
you which register-access strategy to use (the ES2 even accepts
`Set_Attribute_Single` on some Assembly instances, so "did this request
succeed" alone isn't a safe signal either).

So instead of auto-detecting, the caller states the device type explicitly:

```js
const { DeltaDevice } = require('./src/delta/device');

const sx3 = new DeltaDevice('192.168.68.250', 'sx3'); // vendor Register Objects (Class 0x350-0x359)
const es2 = new DeltaDevice('192.168.68.111', 'es2'); // Assembly-window fallback (Instance 101)
```

- [src/delta/device-types/index.js](src/delta/device-types/index.js) — a
  small registry (`register(key, profile)` / `get(key)` / `list()`); adding
  a new PLC type means adding one file here and registering it, nothing
  else changes.
- [src/delta/device-types/sx3.js](src/delta/device-types/sx3.js) — thin
  passthrough to `registers.js` (Delta manual-documented, vendor-wide for
  this family).
- [src/delta/device-types/es2.js](src/delta/device-types/es2.js) — `readD`
  via the Assembly-window fallback; every other method throws a clear
  "not supported for device type 'es2'" error rather than silently doing
  the wrong thing or being omitted (so every profile has the same method
  shape to code against).
- [src/delta/device.js](src/delta/device.js) — `DeltaDevice`, wraps a
  `Scanner` + a chosen profile behind one object.

**Live-validated (2026-09):** `DeltaDevice(sx3Host, 'sx3').readD(0)` and
`DeltaDevice(es2Host, 'es2').readD(0)` both work; `DeltaDevice(es2Host,
'sx3').readD(0)` — deliberately mismatched type — fails with the expected
`0x05 PathDestinationUnknown` from `registers.js`'s Class 0x352, rather than
silently returning garbage. This is the explicit failure mode the design
was chosen for.

**Profile-authoring assist (not auto-generation):**
[src/delta/eds-inspect.js](src/delta/eds-inspect.js) parses an EDS file's
`[Assembly]` and `[Connection Manager]` sections into a quick list of
candidate instance numbers/sizes/paths — a starting point for defining a
new profile, not a finished one, since EDS files don't document which byte
offset means which named register (the SX3 EDS's own Param names are
generic "Input_data0".."Input_dataN", not "D0".."D99" — see the earlier
D-mirror discovery, which needed live testing regardless of having the EDS
in hand). Try it: `node examples/inspect-eds.js eds/031F000E0F0600010001.eds`.

### K. Future — CIP Security & advanced conformance

| Item | Status | Notes |
|---|---|---|
| CIP Security (Vol 8) — TLS/DTLS secure sessions | ⬜ | future |
| Full ODVA Conformance Test (CT) pass | ⬜ | future — [CT spec mirror](https://archive.org/details/ovda_cip_docs) |
| CIP Safety objects | ⬜ | future |

## Source layout

```
src/
  constants.js                — encapsulation commands/status, CIP general
                                 status codes, common services, class codes  ✅
  encapsulation/
    header.js                 — 24-byte header encode/decode                ✅
    cpf.js                     — Common Packet Format item parsing          ✅
    identity.js                 — Identity item / Socket Address decode     ✅
    session.js                   — RegisterSession / UnRegisterSession      ✅
    discovery.js                  — ListIdentity (UDP broadcast/unicast +
                                     TCP), the network-scan entry point     ✅
    rrdata.js                       — SendRRData (unconnected explicit
                                       messaging) wrap/unwrap               ✅
  cip/
    path.js                    — padded EPATH / logical segment encoding,
                                  incl. encodeAssemblyConnectionPath()      ✅
    message-router.js           — request/response framing                ✅
    connection-manager.js         — Forward Open/Forward Close             ✅
    io-connection.js               — cyclic UDP I/O datagram (Sequenced
                                      Address + Connected Data items)       ✅
    objects/
      identity.js                    — server-side Identity Object          ✅
      assembly.js                     — server-side Assembly Object         ✅
      (TCP/IP Interface, Ethernet Link — not started)                       ⬜
    types.js                        — CIP data type encode/decode          ⬜ phase 2
  logix/
    tag-service.js               — Rockwell Read/Write Tag (0x4C/0x4D/0x52/0x53) ⬜ phase 2
  delta/
    registers.js                  — Delta vendor-specific Register Objects
                                     (X/Y/D/M/S/T/C/HC/SM/SR)                ✅
    assembly-window.js             — fallback: generic word-window into an
                                      Assembly instance, for devices without
                                      registers.js's Register Objects        ✅
    es2-fallback-profile.js         — one confirmed real device's mapping
                                       (D read-only via Instance 101)        ✅
    device-types/
      index.js                       — profile registry (register/get/list) ✅
      sx3.js                          — profile: vendor Register Objects    ✅
      es2.js                           — profile: Assembly-window fallback ✅
    device.js                          — DeltaDevice: Scanner + explicit
                                          device-type profile in one object ✅
    eds-inspect.js                      — parses an EDS's [Assembly]/
                                           [Connection Manager] sections, a
                                           profile-authoring assist tool     ✅
  eds/
    generator.js                  — EDS file generation for adapter devices ⬜ phase 4
  scanner.js                       — public Scanner API (discover, connect,
                                      getAttribute/setAttribute, Forward
                                      Open/Close, Delta register methods)    ✅
  adapter.js                        — public EIPAdapter (TCP+UDP server,
                                       session mgmt, object dispatch,
                                       Forward Open/Close acceptance)        ✅
  adapter/
    connection-handler.js             — Adapter-side Forward_Open/Close +
                                         cyclic UDP produce/consume          ✅
  client.js                          — low-level session/handshake client,
                                        generic explicit messaging,
                                        Forward Open/Close                  ✅
examples/
  scan-network.js                     — CLI: UDP broadcast device scan      ✅
  probe-device.js                      — CLI: TCP ListIdentity + handshake  ✅
  get-attribute.js                      — CLI: Get_Attribute_Single via
                                           SendRRData                       ✅
  set-attribute.js                       — CLI: Set_Attribute_Single via
                                            SendRRData                      ✅
  discover-assemblies.js                  — CLI: sweep Assembly Object
                                             instances on a real device      ✅
  forward-open.js                          — CLI: Forward_Open/Forward_Close
                                              against a real device          ✅
  io-listen.js                              — CLI: open a connection, exchange
                                               live cyclic I/O data           ✅
  delta-registers.js                         — CLI: readD/readX/readY/readM/
                                                readSR against a real device  ✅
  scanner-demo.js                             — CLI: end-to-end demo of the
                                                 public Scanner API           ✅
  delta-es2-fallback.js                        — CLI: readD via the Assembly-
                                                  window fallback (ES2)       ✅
  inspect-eds.js                                — CLI: profile-authoring
                                                   assist, dumps an EDS's
                                                   Assembly/Connection info   ✅
  adapter-demo.js                                — CLI: full Phase 3
                                                   loopback self-test         ✅
eds/
  031F000E0F0600010001.eds                 — Delta SX-3's vendor-issued EDS,
                                              used as ground truth above     ✅
docs/
  DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf — Delta's own EtherNet/IP
                                                 manual, source for Domain J  ✅
```

## Status

Phase 0 and Phase 1 complete. Phase 2's core risk — can this stack actually
do real-time producer/consumer I/O against a non-Rockwell device, not just
one-shot reads — is now cleared end-to-end, all validated live against the
real Delta SX-3 PLC:
- **Explicit messaging**: path encoding, CIP message router framing, and
  SendRRData — `Get_Attribute_Single` read back Identity Vendor ID (799) and
  Product Name ("DVP-SX3"), cross-checked against Phase 1's ListIdentity values.
- **Forward_Open / Forward_Close**: using ground truth pulled from Delta's
  own EDS file (`eds/031F000E0F0600010001.eds`) — succeeded on the first
  attempt, RPI granted exactly as requested (20 ms), connection torn down
  cleanly.
- **Live cyclic I/O data, both directions**: 219 real T->O datagrams
  received in a 5-second window (20 ms RPI) with distinct, changing
  payloads, while simultaneously producing our own O->T datagrams to keep
  the connection alive — see `examples/io-listen.js`.
- **Set_Attribute_Single** (write): validated live — a write was rejected
  (`0x15 TooMuchData`) until the root cause was found (Assembly data-write
  length must match the *current* Size attribute, which had drifted since
  it was last read), then succeeded with the correct length and was
  confirmed unchanged on readback.
- **Delta vendor-specific direct register access** (`src/delta/registers.js`,
  Domain J): all 10 register types (X/Y/D/M/S/T/C/HC/SM/SR) validated live
  against the SX3 — this is the Modbus-like "read D100 by name" capability
  the driver was originally missing, sourced from Delta's own EtherNet/IP
  manual rather than guessed at. Also discovered, via an ordinary network
  scan, that this layer is AS/AH-series-specific: a second real device (a
  DVP32ES2-E) answers generic CIP fine but doesn't implement these register
  classes at all — a genuinely useful finding about the limits of this
  vendor layer, not a driver bug.
- **Public `Scanner` API** (`src/scanner.js`): wraps everything above
  (discovery, `getAttribute`/`setAttribute`, Forward Open/Close, and all
  the Delta register methods bound to one session) into one object —
  live end-to-end smoke test in `examples/scanner-demo.js` (discover →
  connect → generic Vendor ID read → `readD(0)` → disconnect) passed
  against the real SX3.
- **Assembly-window fallback** (`src/delta/assembly-window.js` +
  `es2-fallback-profile.js`, Domain J): confirmed a device-specific way to
  read D-registers on the DVP32ES2-E even without the vendor Register
  Objects — via a known-value pattern written into the D-table externally,
  then found by scanning every Assembly instance's Data attribute for a
  byte-for-byte match (Instance 101, offset 0). Write side is validated at
  the wire level (Instance 100 accepts `Set_Attribute_Single`) but its
  real-world target is unconfirmed pending the device owner cross-checking
  their own register monitor — open item.
- **Explicit device-type profiles** (`src/delta/device.js` +
  `device-types/`): `DeltaDevice(host, 'sx3'|'es2')` picks the right
  register-access strategy up front rather than auto-detecting — confirmed
  live against both real devices, and a deliberately mismatched type
  (`DeltaDevice(es2Host, 'sx3')`) fails clearly instead of returning wrong
  data. Extensible: a new PLC type is one new file plus a registry entry.
  Includes a profile-authoring assist tool (`eds-inspect.js`) that reads an
  EDS's Assembly/Connection sections as a starting point.

Phase 2 is now essentially feature-complete for its core scope. **Phase 3
(EIP Adapter) is underway and its core is done**, validated live via full
loopback (`examples/adapter-demo.js`, this driver's own client code against
its own new `EIPAdapter`):
- TCP+UDP encapsulation server, session management, `ListIdentity` (both
  TCP and UDP unicast) all working.
- Server-side Identity Object and Assembly Object, dispatched through a
  generic class registry — `Get_Attribute_Single`/`Set_Attribute_Single`
  both validated, including the Assembly size-mismatch → `TooMuchData`
  behavior exactly matching what this driver found on **real Delta
  hardware** in Phase 2 (not assumed — replicated from an actual discovery).
- Server-side `Forward_Open`/`Forward_Close`: full request/response round
  trip validated live over TCP, RPI granted as requested.
- The resulting cyclic UDP I/O *logic* (production/consumption, connection
  ID matching) is unit-tested (`test/connection-handler_spec.js`) but not
  yet proven end-to-end against a second real host — same-machine loopback
  can't fully exercise it since both sides of EtherNet/IP I/O always use
  the fixed port 2222 (a protocol/OS constraint, not an implementation gap;
  see Domain H for the full explanation).

`npm test` (97 tests) covers the same logic with synthetic buffers for
regression safety. Still ahead: Multiple Service Packet and Rockwell/Logix
tag services (Phase 2 loose ends), TCP/IP Interface + Ethernet Link Objects
and real cross-device I/O validation (Phase 3 loose ends).

## Quick start

```js
const { Scanner } = require('@kufayeka/ethernet-ip/src');

const devices = await Scanner.discover(); // UDP broadcast ListIdentity

const scanner = new Scanner('192.168.68.250');
await scanner.connect();

const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
await scanner.readD(100);          // Delta: read D100
await scanner.writeD(100, 1234);   // Delta: write D100
const conn = await scanner.openConnection({ connectionPath, rpiUs: 20000, otSize: 200, toSize: 200 });
await scanner.closeConnection(conn);

await scanner.disconnect();
```

See `examples/` for complete, runnable scripts covering every piece above.

## Test

```
npm test
```
