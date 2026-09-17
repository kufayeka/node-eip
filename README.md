# @kufayeka/ethernet-ip

A vendor-neutral ODVA EtherNet/IP (CIP) driver for Node.js, built directly
from the CIP Networks Library (Vol 1 Common Industrial Protocol, Vol 2
EtherNet/IP Adaptation of CIP) — not reverse-engineered from a single
vendor's tool.

**Current focus: Delta EtherNet/IP devices** (`src/delta/` — see
[src/delta/README.md](src/delta/README.md) and
[docs/delta-cip-object-reference.md](docs/delta-cip-object-reference.md)).
Rockwell/Logix-specific extensions (Read/Write Tag, Symbol Object, Template
Object, UDT decoding) are **explicitly deferred** — they're a separate,
additive layer on top of the generic CIP core (see §22/24/26/27/32/54
below), not a prerequisite for anything this project needs right now.

This README tracks compliance against a full ODVA EtherNet/IP + CIP
checklist (`README_GOAL.md`), not just "can it read/write a Delta PLC" —
that project-specific status lives in `src/delta/README.md`. Status
markers below: ✅ done and live-validated, 🔶 implemented but not fully
validated/complete, ⬜ not started, ⏸ deferred (Rockwell-specific, out of
scope for now).

For the detailed, dated history of every live-hardware finding, bug, and
dead end behind these statuses, see
[docs/PROJECT_LOG.md](docs/PROJECT_LOG.md) (this file's predecessor,
preserved in full).

## Quick start

```js
const { Scanner } = require('./src/scanner');
const scanner = new Scanner('192.168.1.10');
await scanner.connect();
const vendorId = await scanner.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
await scanner.disconnect();
```

```js
// Delta vendor layer — explicit device-type profile (see src/delta/README.md)
const { DeltaDevice } = require('./src/delta/device');
const plc = new DeltaDevice('192.168.68.250', 'sx3');
await plc.connect();
const d100 = await plc.readD(100);
await plc.writeD(100, 1234);
await plc.disconnect();
```

## Test

```
npm test
```

229 tests (`test/*_spec.js`) — encoding/round-trip tests against synthetic
buffers, real Delta hardware captures, and loopback EIPAdapter.
Live-hardware validation is separate — see the `Live?` notes throughout
this checklist and [`examples/README.md`](examples/README.md) for runnable scripts
against a real device (all defaulting to `192.168.68.250`).

---

## 1. EtherNet/IP Encapsulation Layer

### 1.1 Encapsulation Header — ✅

24-byte header encode/decode: [src/encapsulation/header.js](src/encapsulation/header.js).
`decodeMessage()` validates length and returns `null` on an incomplete
buffer (correct TCP-stream framing, see §39) rather than throwing or
guessing. Sender Context (8 bytes) is actively generated as a 64-bit
monotonic sequence counter and used for **request/response correlation**
via an internal `Map` in `EIPSession` (see §40 — ✅ completed and live-validated).
Zero-length payload, malformed/truncated buffers, and unexpected session handles
are handled without crashing (`decodeHeader`/`decodeMessage` throw
`RangeError`/return `null` predictably).

### 1.2 Encapsulation Commands

| Command | Code | Status |
|---|---|---|
| `NOP` | 0x0000 | ⬜ constant only, never sent/handled |
| `ListServices` | 0x0004 | ✅ live — queries encapsulation services (`src/encapsulation/services.js`, `Scanner.listServices()`, `EIPAdapter`) |
| `ListIdentity` | 0x0063 | ✅ live — UDP broadcast, UDP unicast, TCP (`src/encapsulation/discovery.js`) |
| `ListInterfaces` | 0x0064 | ⬜ constant only |
| `RegisterSession` | 0x0065 | ✅ live (`src/encapsulation/session.js`, `src/client.js`) |
| `UnregisterSession` | 0x0066 | ✅ live |
| `SendRRData` | 0x006F | ✅ live — unconnected explicit messaging (`src/encapsulation/rrdata.js`) |
| `SendUnitData` | 0x0070 | ⬜ constant only — connected (Class 3) explicit messaging is not implemented on either client or server side |

Unknown/unsupported commands: the Adapter (`src/adapter.js`) answers
`ListServices` (0x0004) with capability flags and service name, and returns
`EncapsulationStatus.InvalidCommand` (0x0001) for unhandled commands (such as
`ListInterfaces` or `SendUnitData`) per ODVA specification.

---

## 2. Session Management

### 2.1 Register Session — ✅

`EIPSession.connect()` sends `RegisterSession`, parses the returned
session handle, stores it, and rejects on a nonzero response status
(`src/client.js`). Protocol version/options are fixed (version 1, options
0) — not configurable, but that's the only value any real device accepts
per spec.

### 2.2 Session Lifecycle — ✅ **live-validated**

Full session lifecycle state machine (`DISCONNECTED` ➔ `CONNECTING` ➔ `REGISTERED` ➔ `ACTIVE` ➔ `DESTROYED`)
in `src/client.js` and `src/scanner.js`. Includes:
- **Encapsulation NOP (0x0000) & Identity Keepalive**: periodic heartbeat timer (`heartbeatIntervalMs`)
  detecting silent network link dropouts. Supported in `src/encapsulation/services.js` and echoed by `src/adapter.js`.
- **Liveness probe**: fast 2ms Identity probe via `scanner.ping()`.
- **Auto-Reconnect Engine**: configurable exponential backoff (`reconnectDelayMs`, `maxReconnectAttempts`)
  when remote PLC disconnects, drops the socket, or reboots. Automatically re-registers the session and
  safely drains pending queues.
- Tested in `test/session-robustness_spec.js` and live against Delta SX3 in `examples/session-robustness.js`.

### 2.3 Thread Safety — N/A / ⬜ (see §40)

Node.js is single-threaded, so classic multi-thread races don't apply —
but the *concurrent request* version of this problem (§40) is a real,
confirmed gap: `EIPSession` has no per-request correlation at all.

---

## 3. SendRRData / Unconnected Explicit Messaging — ✅

`src/encapsulation/rrdata.js` builds/parses the full stack (Encapsulation
→ SendRRData → CPF → CIP Message). CPF parsing (§5) handles Null Address
Item + Unconnected Data Item; Connected Address/unknown items would
decode generically (CPF is type-agnostic) but aren't exercised on this
path since SendRRData is always unconnected. Live-validated extensively
against a real Delta SX3 (explicit reads/writes of hundreds of registers,
Forward_Open/Close, etc. — see `docs/PROJECT_LOG.md`).

## 4. SendUnitData / Connected Messaging — ⬜

Not implemented on either the client (`EIPSession`) or the server
(`EIPAdapter`) side — `grep SendUnitData src/` finds only the constant and
an explicit "not yet implemented" comment in `src/adapter.js`. This means
**Class 3 connected explicit messaging doesn't exist in this driver at
all** — every explicit request goes over unconnected `SendRRData`
instead, which works for everything tested so far but isn't spec-complete.

## 5. Common Packet Format (CPF) — ✅

Generic encoder/decoder: [src/encapsulation/cpf.js](src/encapsulation/cpf.js).
Item shape is `{ typeId, data }`, decoded generically — unknown item types
pass through without special-casing (nothing to reject), matching the
spec's "ignore what you don't recognize" intent. Validates item count and
truncated headers/data (`RangeError`, no buffer over-read). Supports Null
Address, Connected Address, Unconnected Data, Connected Data, and
Sequenced Address item type IDs (`CpfItemType`).

## 6. CIP Message Layer — ✅

`src/cip/message-router.js`: `buildRequest`/`parseResponse` (client) and
`parseRequest`/`buildResponse` (server, Phase 3) are exact inverses.
Response parsing structurally separates `generalStatus` from
`additionalStatus` (an array, not discarded — see §36) and `data`.
"Partial Success" isn't a distinct case in the general-status decode logic
(0x06 `PartialTransfer` is just another status value, not specially
branched), which is spec-accurate — CIP doesn't have a third
success/partial/error tier beyond checking `generalStatus === 0`.

## 7. CIP Service Framework — ✅

Not hardcoded — `buildRequest({ service, path, data })` accepts any
service code as a plain number, used identically for `Get_Attribute_Single`
(0x0E), `Set_Attribute_Single` (0x10), `Forward_Open` (0x54, via
`connection-manager.js`), and every Delta vendor service. `Scanner.getAttribute()`/`setAttribute()`
are the ergonomic wrapper (`src/scanner.js`), but the raw
`sendUnconnected(buildRequest(...))` path is always available for any
service/class/instance/attribute combination — including ones this driver
has no named wrapper for yet.

`Get_Attributes_All` (0x01): ✅ live — `scanner.getAttributesAll({ classId, instance })`
implements Get_Attribute_All and automatically decodes Identity Object (0x01).
The `EIPAdapter` server dispatches `GetAttributeAll` across Identity, TCP/IP, and
Ethernet Link objects. Live-validated against Delta SX3 PLC.

`Set_Attribute_All` (0x02), `Reset` (0x05), `Create` (0x08), `Delete` (0x09): ⬜ no
dedicated helper, though the generic `buildRequest` framework supports issuing
any of these manually today.

`Multiple_Service_Packet` (0x0A): ⬜ not implemented — no request-batching
support at all.

## 8. CIP Object Model — 🔶

Generic path builder: `encodeEPath({ classId, instance, attribute,
connectionPoint, member })` in [src/cip/path.js](src/cip/path.js), covering
Logical Segments only (see §21). No fluent builder API
(`CIPPath.class(x).instance(y)`) — it's a plain options object, functionally
equivalent but not the exact shape README_GOAL sketches.

## 9. Standard CIP Objects

### Identity Object (0x01) — ✅

Client-side read confirmed live (Vendor ID, Product Name, cross-checked
against ListIdentity — `docs/PROJECT_LOG.md`). Server-side implementation:
[src/cip/objects/identity.js](src/cip/objects/identity.js) (Phase 3, loopback-validated).
`Reset` service: ⬜ not implemented.

### Message Router (0x02) — 🔶

Framing (§6) is complete and this **is** the message router in the sense
that every CIP request in this driver is dispatched through it — but there
is no explicit "Message Router Object" with its own queryable attributes
(Number Available/Number Active) on either client or server side.

### Connection Manager (0x06) — 🔶 (see §12 for detail)

### TCP/IP Interface Object (0xF5) / Ethernet Link Object (0xF6) — ✅

Fully implemented and live-validated (see §10 and §11 below). Served by `EIPAdapter`
and queryable via `Scanner.getTcpIpConfig()` and `Scanner.getEthernetLinkInfo()`.

---

## 10. TCP/IP Interface Object (0xF5) — ✅ **live-validated**

Implemented in [src/cip/objects/tcp-ip.js](src/cip/objects/tcp-ip.js):
- **Server side (`EIPAdapter`)**: Serves Instance 1 with Status (Attr 1, DWORD),
  Configuration Capability (Attr 2, DWORD), Configuration Control (Attr 3, DWORD),
  Physical Link Object EPATH pointing to Class 0xF6 (Attr 4, STRUCT), Interface
  Configuration (Attr 5, STRUCT with IP, Netmask, Gateway, Primary/Secondary DNS,
  Domain Name), Host Name (Attr 6, STRING), and Inactivity Timeout (Attr 13, UINT).
  Supports `setAttributeSingle` for settable attributes (3, 5, 13).
- **Client side (`Scanner.getTcpIpConfig()`)**: Reads and decodes raw attribute
  buffers into friendly JavaScript objects.
- **Live-validated** against real Delta SX3 hardware (`examples/read-network-objects.js`),
  successfully decoding IP `192.168.68.250`, Netmask `255.255.255.0`, and Host Name `"DVP-SX3"`.

## 11. Ethernet Link Object (0xF6) — ✅ **live-validated**

Implemented in [src/cip/objects/ethernet-link.js](src/cip/objects/ethernet-link.js):
- **Server side (`EIPAdapter`)**: Serves Instance 1 with Interface Speed (Attr 1, UDINT,
  e.g. 100 Mbps), Interface Flags (Attr 2, DWORD with Link Active bit 0 and Full Duplex bit 1),
  Physical MAC Address (Attr 3, USINT[6]), Interface Label (Attr 10, SHORT_STRING),
  and Interface Capability struct (Attr 11).
- **Client side (`Scanner.getEthernetLinkInfo()`)**: Formats MAC addresses into
  standard `XX:XX:XX:XX:XX:XX` strings and decodes duplex/link status flags.
- **Live-validated** against real Delta SX3 hardware (`examples/read-network-objects.js`),
  successfully reading Speed `100 Mbps`, Duplex `Full Duplex`, Link `Active`, and
  MAC Address `00:18:23:E4:61:2E`.

---

## 12. Connection Manager — ✅ **live-validated**

**Forward_Open (0x54):** ✅ full classic Forward_Open (≤511 bytes) build/parse on
both client (`src/cip/connection-manager.js` + `src/client.js`) and
server (`src/adapter/connection-handler.js`) — live-validated against real Delta SX3.

**Large_Forward_Open (0x5B):** ✅ **live-validated** per CIP Vol 1 Section 3-5.5.3.
Supports 32-bit Network Connection Parameters (Table 3-5.17) allowing connection sizes
up to 65,535 bytes. Includes `buildLargeForwardOpenRequest()`, `parseLargeForwardOpenRequest()`,
adapter handling in `src/adapter.js`, and transparent fallback to standard Forward_Open if
a legacy target rejects 0x5B. Empirically confirmed supported natively on real Delta DVP-SX3
hardware (`isLarge: true` in `examples/large-forward-open.js`).

**Forward_Close (0x4E):** ✅ same completeness/validation as Forward_Open.

**Extended status decoding:** 🔶 `ForwardOpenExtendedStatus` in
`connection-manager.js` covers ~25 common codes for debugging, explicitly
documented as non-exhaustive.

---

## 13. CIP Connection Lifecycle — ⬜

No explicit state machine (`NEW → OPENING → ESTABLISHED → RUNNING →
TIMED_OUT → CLOSING → CLOSED`) — a connection is just the plain object
`openConnection()` returns; its liveness is implicit (did the last I/O
packet arrive recently?), not tracked as formal state. Ownership conflict
and connection-not-found are detectable via the extended status table
above, but not raised as distinct, typed errors.

## 14. Real-Time I/O — UDP/2222 — ✅ (as Originator)

`src/cip/io-connection.js` builds/parses the Sequenced Address Item +
Connected Data Item datagram. Full path (Forward_Open → UDP I/O → parse)
live-validated against the real SX3 (`examples/io-listen.js`). Only the
"Modeless" real-time format (no 32-bit Run/Idle header) is implemented —
documented explicitly as a known gap for O→T data that requires one.

## 15. I/O Connection Types — 🔶

Point-to-point ✅ (the only type tested). Unicast ✅. Multicast ⬜ not
implemented (no `IP_ADD_MEMBERSHIP`/multicast socket handling anywhere).
Cyclic ✅ (the only trigger type used — `transportTypeTrigger = 0x01`
default). Change-of-State / Application-triggered: ⬜ not implemented
(the trigger byte is a raw parameter you *could* set manually, but nothing
in this driver builds the different data-exchange behavior COS/App
triggering implies).

## 16. RPI — 🔶

Treated as a real connection parameter (`rpiUs`/`otApiUs`/`toApiUs` are
distinct requested-vs-actual values returned by the device, not a local
`setInterval` guess) — see `examples/io-listen.js`, which derives its send
interval from the negotiated `otApiUs`. RPI rejection/renegotiation
handling: ⬜ not specially detected (a rejected RPI just surfaces as a
Forward_Open failure via the extended status table, not a
"renegotiate and retry" flow).

## 17. Sequence Number — 🔶

`io-connection.js` encodes/parses the 32-bit sequence number on every I/O
datagram, and increments it correctly when producing. **Not implemented:**
gap/loss/reorder/duplicate detection on the *consuming* side — an
out-of-order or dropped packet is not currently flagged, just processed
(or not) as it arrives.

## 18. Multicast Handling — ⬜

Not implemented at all — no multicast IP handling, no `IGMP`, no
`IP_ADD_MEMBERSHIP`/`IP_MULTICAST_IF`. Every I/O connection tested so far
is point-to-point unicast.

## 19. CIP Routing — ✅

Full multi-hop routing support via Port Segments in `src/cip/path.js`.
`encodeRoutePath(hops, target)` and `encodeEPath({ portSegments, ... })` enable
multi-hop routing (e.g. Ethernet Port 2 → remote IP → Backplane Port 1 → Slot 0
processor → target CIP object). Fully round-trips through `decodeEPath()`.

## 20. Port Segment — ✅

Implemented in `src/cip/path.js` (`encodePortSegment` / `decodePortSegment`).
Supports standard ports (0-14) and extended ports (>= 15), numeric link addresses
(e.g. backplane slot), and extended link addresses (string IP or node addresses)
with strict 16-bit word padding per CIP Vol 1 Appendix C (C-1.3). Validated in
`test/port-segment_spec.js` and `examples/routing-and-types.js`.

## 21. Logical Segments — 🔶

`src/cip/path.js`'s `encodeLogicalSegment`/`decodeLogicalSegment` support
Class, Instance, Attribute, Connection Point, and Member logical types,
correctly switching between 8-bit/16-bit/32-bit padded encoding based on
value size (`test/path_spec.js` covers all three widths). **Extended
Logical** (Logical Type values 5-7: Special, Service ID, reserved) is not
implemented — not needed by anything targeted so far.

---

## 22. Symbolic Segment — ⏸ deferred (Rockwell/Logix-specific)

Not implemented. This is Logix tag-name addressing (`0x91`-prefixed ASCII
paths) — out of scope while this project focuses on Delta, which uses
Logical Segments exclusively (Class/Instance/Attribute, no symbolic tags).

## 23. Array Indexing — ⏸ deferred (depends on §22/§24, Rockwell-specific)

Not applicable without Symbolic Segment support / Logix tag services.

## 24. Logix Tag Services (Read/Write Tag 0x4C/0x4D, Fragmented 0x52/0x53) — ⏸ deferred

Explicitly out of scope — `src/logix/tag-service.js` is a placeholder
(⬜, "phase 2" in the source layout) with nothing implemented. Delta
devices don't use these services at all (confirmed via a full CIP class
sweep on real hardware — see `docs/delta-cip-object-reference.md`).

## 25. Multiple Service Packet (0x0A) — ✅ **live-validated**

Implemented in `src/cip/multiple-service.js` per CIP Vol 1 Section 3-5.5.
Packages multiple CIP requests into a single Message Router request (`0x02/1, 0x0A`)
with offset tables and sub-response extraction. Includes automatic transparent fallback
to individual pipelined requests if a target device returns `0x08 ServiceNotSupported`.
Supported natively on real Delta DVP-SX3 hardware (resolves 5+ batched requests
in <10 ms). Tested in `test/multiple-service_spec.js` and `examples/multiple-service.js`.

## 26. Logix Symbol Object (0x6B) — ⏸ deferred (Rockwell-specific)

Not implemented, not needed for Delta.

## 27. Template Object (0x6C) — ⏸ deferred (Rockwell-specific, depends on §26)

Not implemented, not needed for Delta.

---

## 28. Data Type System — ✅

Implemented in `src/cip/types.js`. Contains centralized metadata and codecs
(`CIP_DATA_TYPES`, `encodeType`, `decodeType`) for all ODVA elementary data types:
`BOOL`, `SINT`, `INT`, `DINT`, `LINT`, `USINT`, `UINT`, `UDINT`, `ULINT`, `REAL`,
`LREAL`, `BYTE`, `WORD`, `DWORD`, `LWORD`, `SHORT_STRING`, `STRING`.
Fully tested with boundary and truncation assertions in `test/types_spec.js`.

## 29. Endianness — ✅

Every multi-byte field in this codebase is read/written explicitly
little-endian (`readUInt16LE`, `writeInt32LE`, etc.) — `grep -rn
"readUInt\|writeUInt\|readInt\|writeInt" src/` shows zero native-endian
(`readUInt16`/`writeUInt16` without the `LE`/`BE` suffix) calls. No
native-CPU-endian dependency anywhere.

## 30. BOOL / Bit-Level Access — ✅

Implemented in `src/cip/types.js` (`readBit`, `writeBit`, `resolveBitMember`).
Supports bit indexing (0-7), bit setting/clearing, and packed boolean member
resolution by mask or byte/bit offset inside any structured attribute buffer.
Complementary to Delta's per-bit CIP instances in `src/delta/registers.js`.

## 31. String Handling — ✅

Implemented in `src/cip/types.js` (`encodeShortString`, `decodeShortString`,
`encodeCipString`, `decodeCipString`). Supports ODVA standard `SHORT_STRING`
(UINT8 length + ASCII characters) and `STRING` (UINT16 length + ASCII characters).

## 32. UDT Decoder — ⏸ deferred (Rockwell/Logix-specific, depends on §27)

Not implemented, not needed for Delta (no UDTs involved in anything
targeted so far).

## 33. Fragmentation — ⬜

No generic fragmentation engine. Every explicit request/response in this
driver is assumed to fit in one unconnected message — untested against
any payload large enough to require `Service Fragmentation` (general
status 0x06 `PartialTransfer`/0x17
`ServiceFragmentationSequenceNotInProgress` are defined in
`CipGeneralStatus` but never specifically handled with a re-request loop).

## 34. CIP Error Handling — ✅

`parseResponse()` (`src/cip/message-router.js`) always returns a
structured `{ service, generalStatus, additionalStatus, data }` — never
just a boolean/thrown string. Callers (`Scanner.getAttribute`, Delta's
`registers.js`, etc.) build a descriptive `Error` from the *whole*
structure (general status name + hex additional status words), not a bare
`if (status !== 0) throw`.

## 35. General Status Codes — ✅ (exceeds the checklist)

`CipGeneralStatus` in [src/constants.js](src/constants.js) covers the
full CIP Vol 1 Appendix B table through `0x2E`
(`ServiceNotSupportedForSpecifiedPath`) — every code README_GOAL lists
plus ~15 more (Routing Failure variants, Embedded Service Error,
Vendor Specific Error, Member/Attribute-list errors, etc.).

## 36. Additional Status — ✅

Never discarded — `parseResponse()` returns it as a plain array of
16-bit words on every response, and every error path in this driver
(`assertGetSuccess` in `registers.js`, `_forwardOpenError` in
`client.js`) includes it in the thrown error's message. `Forward_Open`
specifically decodes the first additional status word against a
~25-entry lookup table for a human-readable reason.

---

## 37. Timeout Management — 🔶

One `timeoutMs` (default 5000ms) per `EIPSession`, applied to *both* the
initial TCP connect and every subsequent request/response transaction —
not the differentiated set README_GOAL wants (separate TCP connect /
session / CIP request / Forward Open / I/O connection / fragment
timeouts). Works fine for this driver's current sequential-request usage
pattern, but is a single global knob, not per-operation-type.

## 38. Retry Policy — ⬜

No retry logic anywhere in this codebase. A failed/timed-out request
simply rejects its promise; the caller decides whether to retry.
Retryable-vs-non-retryable classification (TCP reset vs. Invalid
Attribute) doesn't exist.

## 39. TCP Stream Handling — ✅

`EIPSession._onData()` (`src/client.js`) buffers incoming chunks
(`Buffer.concat`) and loops `decodeMessage()` until it returns `null`
(incomplete message, keep buffering) — correctly handles both a single
TCP read containing multiple encapsulation messages back-to-back, and one
message split across multiple reads. This is exactly the framing
README_GOAL calls "one of the most important parts for robustness," and
it's implemented correctly.

## 40. Concurrency — ✅ **live-validated**

`EIPSession` implements request/response correlation using the 8-byte
**Sender Context** field specified by ODVA CIP Vol 2 §2-3.1. Each outgoing
encapsulation request is tagged with a unique 64-bit monotonic sequence number
stored in a `Map<string, Entry>`. When an encapsulation response arrives off the
wire, `_onData()` matches `msg.header.senderContext` against the active transactions:
- Responses that arrive out-of-order are matched to their exact original promise
  without cross-talk.
- Timed-out requests are purged cleanly; if the server later sends a delayed
  response, it is safely dropped without desynchronizing subsequent requests.
- Live-tested on a real Delta SX3 (`examples/test-concurrency-live.js`), resolving
  7 simultaneous `Promise.all` reads in ~41ms without error.

## 41. Request Queue / Backpressure — ✅ **live-validated**

Embedded industrial PLCs often have shallow TCP socket buffers and drop
or stall incoming bursts if multiple encapsulation packets are written in the
same millisecond. `EIPSession` features an internal request queue with a
configurable `maxInFlight` setting (default `1` for maximum device compatibility,
can be set higher for capable gateways or PC-based targets). When callers issue
bursts like `Promise.all([read(1), read(2), ...])`, `EIPSession` queues and
pipelines them cleanly across the single TCP session.

## 42. Connection Pooling — 🔶

One `EIPSession` = one persistent TCP session, reused across multiple
`read`/`write` calls without re-registering per call (`connect()` once,
then any number of `sendUnconnected()`/`openConnection()` calls, then
`close()`) — matches the "connect → persistent session → read/write →
disconnect" pattern README_GOAL wants. What's missing: any explicit
tracking of *multiple simultaneous* Class 1/Class 3 connections per
session as a managed pool (each `openConnection()` call is independent;
nothing enumerates or manages "all connections currently open on this
session" as a collection).

---

## 43. Discovery — ✅

`ListIdentity` via UDP broadcast (auto-detecting every active local IPv4
interface and sending a subnet-directed broadcast on each —
`ipv4DirectedBroadcasts()`), UDP unicast, and TCP — all three
live-validated against two real, different Delta PLCs found on the same
LAN with zero device-specific code (`src/encapsulation/discovery.js`,
`examples/scan-network.js`). Output shape matches README_GOAL's ideal
exactly: `{ address, vendorId, deviceType, productCode, revision, status,
serialNumber, productName }`.

## 44. Device Identity Cache — ⬜

Discovery results aren't cached anywhere — each `scan()` call re-queries
the network fresh. No persistent device/capability cache exists.

## 45. Device Capability Detection — ⬜

This driver deliberately does the *opposite* of auto-detection for the
Delta layer — see `src/delta/README.md`'s "Why two strategies?": a device
answering generic CIP successfully doesn't reliably indicate which
register-access strategy it supports, so the caller states the device
type explicitly (`new DeltaDevice(host, 'sx3')`) rather than the driver
probing capabilities at connect time. Generic capability flags (Supports
Class 1/Class 3/Large Forward Open/Multiple Service Packet/Fragmentation/
Symbolic Addressing/Unconnected Send) aren't tracked at all.

## 46. Generic CIP Path Builder — 🔶

`encodeEPath({ classId, instance, attribute, connectionPoint, member })`
in `src/cip/path.js` is generic and reusable (used identically by the
core CIP layer and every Delta vendor register) — but it's a plain
options object, not the fluent builder class (`new CIPPath().class(x)...`)
README_GOAL sketches. Functionally equivalent; API shape differs.

## 47. Generic Binary Codec — ⬜ (informal, not a real subsystem)

There is no `ByteReader`/`ByteWriter` abstraction — every module reads
Node's `Buffer` methods directly at the call site (`buf.readUInt16LE(0)`,
etc.). This has worked without incident so far because every payload this
driver handles is small and fixed-shape, but it means byte-parsing logic
is inline everywhere rather than centralized, which is exactly what
README_GOAL warns produces protocol bugs at scale (e.g. Data Type System,
§28, would need this as a foundation).

## 48. Packet Validation — 🔶

Each layer validates its own framing and throws a clear, typed error on
malformation rather than crashing or reading out of bounds: encapsulation
header length (`header.js`), CPF item/length bounds (`cpf.js`), CIP
request/response minimum length (`message-router.js`), EPATH segment
type/length (`path.js`). **Not verified:** no fuzz-testing has been done
to prove there's no buffer-over-read edge case anywhere; this is "looks
correct on inspection and passes 157 targeted unit tests," not "proven
safe against adversarial input."

## 49. Security / Robustness — 🔶

Malformed-packet handling per §48 above. **Not implemented:** any
explicit protection against oversized packets, integer overflow on
attacker-controlled length fields beyond what `Buffer`'s own bounds
checking provides, resource exhaustion from a flood of
connections/requests, or rate limiting. This driver has never been
adversarially tested — treat it as "correct against well-formed and
moderately malformed input from real devices," not "hardened against a
malicious peer."

## 50. Logging & Diagnostics — ⬜

No logging subsystem at all — no log levels (ERROR/WARN/INFO/DEBUG/
TRACE/PACKET), no built-in TX/RX packet tracing. Diagnostic output during
development has been ad-hoc `console.log` in one-off scripts
(`examples/*.js`), never a reusable logger.

## 51. Wireshark Compatibility — 🔶 (informally verified, not tooled)

Every byte-level format in this driver has been manually cross-checked
against real hardware behavior (request sent → expected response
received, correct values read back matching independently-known ground
truth) extensively throughout `docs/PROJECT_LOG.md` — but this was done
by direct protocol testing against real PLCs, not by capturing traffic in
Wireshark and diff'ing byte-for-byte against a reference implementation.
No Wireshark-based verification workflow exists in this repo.

## 52. Protocol Test Suite — 🔶

`npm test` — 157 tests covering encapsulation, CPF, CIP framing, path
encoding, connection manager, Delta register objects (full read/write
matrix, every type, 16-bit and 32-bit, boundary values), and device-type
profiles. **Missing categories** README_GOAL calls for: malformed-input
fuzz tests, concurrency tests (would currently fail — see §40), reconnect
tests, and fragmentation tests (nothing to test, §33 isn't implemented).

## 53. Interoperability Testing — 🔶 (two real devices, one vendor)

Live-tested against two genuinely different real PLCs (a DVP-SX3 and a
DVP32ES2-E — different CPU families, different CIP object models) on the
same LAN, which is more than "one Rockwell PLC," but both are Delta.
Zero testing against Schneider/Omron/Mitsubishi/Keyence/other vendors —
the vendor-neutral core (encapsulation, CPF, CIP framing, Forward_Open)
has no Delta-specific assumptions baked in, but that claim is
"structurally true by code inspection," not "verified against a second
vendor's hardware."

---

## 54. Rockwell-Specific Compatibility Layer — ⏸ deferred

Not built. The architectural intent (`src/logix/` as an additive layer
above the generic CIP core, mirroring `src/delta/`) is already reflected
in the source layout, but nothing inside it is implemented yet
(`src/logix/tag-service.js` is a placeholder). Revisit once Delta work
reaches a stable point — not a priority per current project direction.

## 55. Conformance-Oriented Final Checklist

```text
[x] TCP 44818
[x] UDP 44818
[ ] UDP 2222 (produced I/O only, not general-purpose bind/consume beyond examples)

[x] Encapsulation Header
[x] RegisterSession
[x] UnregisterSession
[x] SendRRData
[ ] SendUnitData
[x] ListIdentity
[ ] ListInterfaces
[x] ListServices
[ ] NOP

[x] CPF
[x] CIP Request
[x] CIP Response
[x] General Status
[x] Additional Status

[~] Object Model              (generic path builder yes, no dedicated Message Router object attributes)
[x] Identity Object           (client read + server serve, live-validated)
[~] Message Router            (framing complete; no Number Available/Active attributes)
[~] Connection Manager        (Forward_Open/Close yes; Large_Forward_Open no)
[x] TCP/IP Interface          (Class 0xF5, client decode + adapter serve, live-validated)
[x] Ethernet Link             (Class 0xF6, client decode + adapter serve, live-validated)

[x] GetAttributesAll
[x] GetAttributeSingle
[ ] SetAttributesAll
[x] SetAttributeSingle
[ ] Reset
[x] Multiple Service Packet

[x] ForwardOpen
[ ] LargeForwardOpen
[x] ForwardClose

[x] Connection IDs
[x] Connection Serial
[x] Originator Vendor ID
[x] Originator Serial
[x] RPI
[x] Timeout Multiplier
[x] Connection Path

[ ] Class 1                   -- see note: implemented as raw UDP I/O, not via SendUnitData/Class 3
[x] Class 1 (raw UDP produce/consume, Originator role, live-validated)
[ ] Class 3 (SendUnitData-based connected explicit messaging)
[x] Unicast
[ ] Multicast
[x] Cyclic
[ ] CoS
[~] Sequence Counter          (encode/parse yes, gap/reorder detection no)
[~] I/O Timeout                (single global timeoutMs, not I/O-connection-specific)
[ ] IGMP

[x] Port Segment
[x] Logical Segment
[ ] Symbolic Segment           (deferred, Rockwell-specific)
[ ] Data Segment                (used once, ad hoc, not a formal path.js primitive)
[ ] Extended Segment
[x] Multi-hop Routing          (encodeRoutePath with port hops, live round-trip)

[x] BOOL                       (generic bit indexing & packed-bit mask resolver, src/cip/types.js)
[x] SINT / INT / DINT / LINT / USINT / UINT / UDINT / ULINT / REAL / LREAL
       (centralized Data Type System, src/cip/types.js)
[x] STRING                     (SHORT_STRING & CIP STRING, src/cip/types.js)
[ ] ARRAY
[ ] STRUCT

[ ] Fragmentation
[ ] Partial Transfer
[ ] Large Data

[x] TCP stream reassembly
[x] Concurrent requests        -- live-validated, see §40
[x] Request correlation        -- 8-byte Sender Context Map
[~] Timeout                    (single global knob, see §37)
[ ] Retry
[ ] Reconnect
[x] Backpressure               -- maxInFlight pipeline queue, see §41
[ ] Resource limits

[x] Malformed packet handling   (per-layer, not fuzz-proven)
[x] Invalid path handling
[x] Invalid service handling
[x] Invalid length handling
[x] Additional status handling

[ ] Packet logging
[ ] Wireshark verification      (informal manual verification only)
[x] Automated conformance tests (211 unit tests across 13 suites)
[~] Interoperability tests      (2 real devices, 1 vendor)
[ ] Long-running stability tests

--- Rockwell Extension (deferred, not a current priority) ---

[ ] Read Tag 0x4C
[ ] Write Tag 0x4D
[ ] Read Tag Fragmented 0x52
[ ] Write Tag Fragmented 0x53
[ ] Symbol Object 0x6B
[ ] Template Object 0x6C
[ ] UDT decoding
[ ] Symbol browsing
[ ] Program-scoped tags
[ ] Controller-scoped tags
[ ] Array indexing
[ ] Structure member addressing
```

### What this means in practice

The vendor-neutral **core is solid for its current scope**: encapsulation,
discovery, unconnected explicit messaging, Forward_Open/Close, and Class 1
UDP I/O are all real, live-validated against genuinely different hardware.
Sender Context correlation (§40) and request queueing with `maxInFlight`
backpressure (§41) are fully implemented and live-verified on real hardware.

The primary structural features remaining for full ODVA compliance are:
1. **§7/§25/§33 (Get_Attributes_All 0x01, Multiple Service Packet 0x0A, Fragmentation 0x06)** —
   request batching and standard multi-attribute querying.
2. **§4 (SendUnitData 0x0070)** — connected explicit messaging (Class 3).
3. **§19/§20 (Port Segment & Multi-hop Routing)** — routing across backplanes and bridges.

Everything Rockwell-specific (§22/24/26/27/32/54, and the Rockwell
Extension block above) is intentionally untouched — not a gap in the
current plan, a deliberate scope boundary while Delta work is the
priority.

## Source layout

```
src/
  constants.js                — encapsulation commands/status, CIP general
                                 status codes (full Vol 1 Appx B table),
                                 common services, class codes            ✅
  encapsulation/
    header.js                 — 24-byte header encode/decode, TCP-safe
                                 framing (decodeMessage returns null on
                                 an incomplete buffer)                   ✅
    cpf.js                     — Common Packet Format, generic item list ✅
    identity.js                 — Identity item / Socket Address decode  ✅
    session.js                   — RegisterSession / UnRegisterSession   ✅
    discovery.js                  — ListIdentity (UDP broadcast/unicast
                                     + TCP)                              ✅
    rrdata.js                       — SendRRData wrap/unwrap             ✅
  cip/
    path.js                    — padded EPATH / Logical Segments only
                                  (no Port/Data/Symbolic segments)      🔶
    message-router.js           — request/response framing              ✅
    connection-manager.js         — Forward_Open/Forward_Close (classic
                                     only, no Large_Forward_Open)        🔶
    io-connection.js               — cyclic UDP I/O datagram             ✅
    objects/
      identity.js                    — server-side Identity Object       ✅
      assembly.js                     — server-side Assembly Object      ✅
      tcp-ip.js                       — TCP/IP Interface Object (0xF5)   ✅
      ethernet-link.js                — Ethernet Link Object (0xF6)      ✅
      (Message Router attributes, Reset service — not started)           ⬜
    types.js                        — does not exist (Data Type System) ⬜
  logix/
    tag-service.js               — placeholder, nothing implemented    ⏸
  delta/                        — see src/delta/README.md              ✅ (current focus)
adapter.js, adapter/            — Phase 3 EIP Adapter (server side):
                                   sessions, CIP dispatch, Forward_Open
                                   acceptance — loopback-validated       ✅
```

## Compliance principle: vendor-neutral by design

The core (encapsulation, message router, generic CIP object model,
Forward Open/Close, implicit I/O) is built to work with **any**
ODVA-conformant device, verified against two genuinely different real
PLCs, not assumed from one vendor's behavior. Rockwell/Logix extensions
belong in `src/logix/` as an additive layer, never a prerequisite for the
generic path — Delta's own vendor layer (`src/delta/`) proves this split
already works in practice for a non-Rockwell vendor.
