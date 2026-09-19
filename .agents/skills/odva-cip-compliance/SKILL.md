---
name: odva-cip-compliance
description: Authoritative ODVA CIP / EtherNet/IP protocol reference and architecture map for the @kufayeka/ethernet-ip package — the Scanner (Originator), Adapter (Target), and EDS compliance ground truth. Trigger before modifying, upgrading, or extending any code under packages/node_modules/@kufayeka/ethernet-ip (src/cip, src/adapter*, src/device, src/scanner.js, src/client.js, EDS import/export), before claiming something is "ODVA compliant," and before adding any new CIP object, service, or connection behavior.
---

# ODVA CIP / EtherNet/IP Compliance — Reference for `@kufayeka/ethernet-ip`

This is the orientation document for anyone (human or AI) about to touch this package. Read
this before writing protocol-level code, not after — the two costliest mistakes in this codebase's
history were (1) implementing CIP behavior from "how the spec text reads" instead of a
conformance-tested reference, and (2) declaring something compliant without a citation. Both are
now avoidable; the sources below are free, public, and already used throughout this codebase.

## 1. What this package is

`@kufayeka/ethernet-ip` is a vendor-neutral Node.js implementation of ODVA's EtherNet/IP (the
Common Industrial Protocol adapted to Ethernet/TCP/UDP). It has two roles, implemented as two
separate code paths that must both stay spec-compliant independently:

- **Scanner / Originator** (`src/scanner.js`, `src/client.js`) — this process initiates sessions,
  explicit messages, and Forward_Opens against a real target device (a PLC, drive, I/O block).
- **Adapter / Target** (`src/adapter.js`, `src/adapter/connection-handler.js`, `src/device/builder.js`)
  — this process *is* the target device: it answers sessions, serves CIP objects, and accepts
  Forward_Opens from a real Scanner (a PLC, SCADA, or another EtherNet/IP master).

See the top-level `README.md` for the user-facing feature/compliance table and tutorials. This
document is the *why* and the *ground truth* behind that table.

## 2. Authoritative sources (in priority order)

1. **CIP Networks Library, Volume 1 (Common Industrial Protocol) and Volume 2 (EtherNet/IP
   Adaptation of CIP)** — the actual normative specification. Section numbers already cited
   throughout this codebase (e.g. "CIP Vol 1 §3-5.5.3") come from here. **Not freely downloadable**
   — ODVA sells it as an annual subscription (<https://www.odva.org/subscriptions-services/specifications/>).
   Treat any in-code citation to a Vol 1/Vol 2 section number as a claim that should eventually be
   checked against the real text if you have access; don't invent new section numbers without it.
2. **[OpENer](https://github.com/EIPStackGroup/OpENer)** — ODVA-conformance-tested (passes CT-14/CT-15
   and ODVA PlugFest Common+Adapter tests) open-source C reference stack. **This is the primary
   ground truth this codebase actually uses**, because it's free, readable, and behaviorally
   authoritative. When in doubt about exact wire behavior (error codes, keying rules, session
   validation, reset semantics), fetch the relevant OpENer source file and port the *algorithm*, not
   just the shape — see §5 for examples of where "reasoning from the spec" alone produced bugs
   that reading OpENer's actual code caught.
3. **[PUB00070 — Recommended Functionality for EtherNet/IP Devices](https://www.odva.org/wp-content/uploads/2020/05/PUB00070_Recommended-Functionality-for-EIP-Devices-v10.pdf)**
   (ODVA Roundtable for EtherNet/IP Implementors, "R10", public PDF). Free, public, and the single
   best condensed checklist of what a conformant Scanner/Adapter *should* do beyond the bare
   minimum. Full requirement text is transcribed in `docs/ODVA_COMPLIANCE_REFERENCE.md`.
4. **[PUB00213 — EtherNet/IP Quick Start for Vendors Handbook](https://www.odva.org/wp-content/uploads/2020/05/PUB00213R0_EtherNetIP_Developers_Guide.pdf)**
   (ODVA, public PDF). Practical EDS-authoring guidance and the conformance-testing process,
   straight from ODVA. Relevant sections transcribed in `docs/ODVA_COMPLIANCE_REFERENCE.md`.
5. **[ODVA Conformance Testing](https://www.odva.org/technology-standards/conformance-testing/)**
   and **[ODVA Document Library](https://www.odva.org/technology-standards/document-library/)** —
   for anything not covered by 1-4, start here rather than guessing.
6. **Real vendor EDS files and manuals already in this repo** — `eds/031F000E0F0600010001.eds`
   (a real Delta SX3's own EDS, used repeatedly as ground truth for exact EDS field formats),
   `docs/delta_manual.txt`, `docs/delta-cip-object-reference.md` (literal transcription of Delta's own
   CIP object tables), `docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_*.pdf`. When this project's own
   generated EDS or CIP behavior disagrees with a real device's own EDS/manual, the real device
   wins — reverse-engineered ground truth beats a guess at spec intent every time.

## 3. Architecture map

```
src/
├── encapsulation/     Session (Register/UnregisterSession), SendRRData/SendUnitData,
│                      ListIdentity/ListServices discovery, CPF (Common Packet Format)
├── cip/
│   ├── path.js         EPATH encode/decode: Logical/Port/Data segments, Electronic Key,
│   │                   ANSI Extended Symbol (symbolic tag) addressing
│   ├── message-router.js   CIP request/response framing (service, path, data)
│   ├── connection-manager.js  Forward_Open/Forward_Close/Large_Forward_Open build+parse,
│   │                          TransportTrigger constants
│   ├── multiple-service.js    Multiple Service Packet (0x0A)
│   ├── fragmentation.js       Partial Transfer (0x06) chunked read/write
│   ├── eds.js / eds-generator.js  EDS *parsing* (client side: EdsFile, createProfileFromEds)
│   ├── io-connection.js       Class 1 datagram build/parse, IOConnection client helper
│   ├── types.js               CIP elementary data type encode/decode
│   └── objects/                One file per CIP object CLASS the Adapter can serve:
│                               identity.js, assembly.js, connection-manager-object.js,
│                               tcp-ip.js, ethernet-link.js, message-router.js, qos.js,
│                               port.js, dlr.js, parameter.js, delta-registers.js (vendor-specific),
│                               generic-object.js (build-your-own custom class)
├── scanner.js          Public Scanner/client API (wraps client.js + cip/*)
├── client.js           EIPSession: TCP socket, session state machine, auto-reconnect
├── adapter.js           Public EIPAdapter API: TCP+UDP servers, session table, CIP dispatch
├── adapter/
│   └── connection-handler.js   Server-side Connection Manager: Forward_Open/Close,
│                                Electronic Key validation, Class 1 cyclic production
│                                (Cyclic/Change-of-State), symbolic Tag Connections
├── device/
│   ├── builder.js       DeviceBuilder — declarative virtual-device construction
│   ├── eds-exporter.js  EDS *generation* (server side: turns a DeviceBuilder model into .eds text)
│   ├── profile.js / device.js / batch-builder.js / registry.js   Client-side DeviceProfile layer
│   └── eds-generator.js  Builds a DeviceProfile FROM a parsed EDS (reverse of eds-exporter.js)
├── vendors/             Pluggable DeviceProfile definitions (delta/, rockwell/, ...)
└── subscription.js      Real-time tag watcher (polling TCP or Class 1 UDP), Change-of-State events
```

Two directions to keep straight, always:
- **`cip/eds.js`/`eds-generator.js`** (parse an EDS *someone else* wrote, to drive this library as a
  Scanner against *their* device) vs **`device/eds-exporter.js`** (generate an EDS describing *this*
  virtual device, for a real Scanner to import). Don't confuse which one a bug report is about.
- **`connection-handler.js`** (this process as Adapter/Target, answering a real Scanner's
  Forward_Open) vs **`client.js`'s `openConnection()`** (this process as Scanner/Originator, sending
  a Forward_Open to a real Adapter). A gap in one is not automatically a gap in the other — see the
  Produced Tag direction note in §5.

## 4. Condensed ODVA requirement checklist (from PUB00070R10)

Full transcription with section numbers: `docs/ODVA_COMPLIANCE_REFERENCE.md`. Highlights most
relevant to this codebase:

**Common to every device:**
- ≥3 concurrent Encapsulation sessions, ≥6 concurrent Class 3 connections, >1 Class 3 connection
  per session (§2.1).
- Generic devices report Device Type `0x2B` (Device Type `0x00` is deprecated) (§2.1.3).
- EDS shall include `[Capacity]` (§2.4).

**Adapter (Target) devices** (§5) — this is `connection-handler.js`'s job:
- Accept ≥2 simultaneous Class 1 connections (1 Exclusive Owner/Input-Only + 1 Input-Only/Listen-Only)
  *plus* 6 Class 3 simultaneously = 8 total (§5.2.2).
- Support Cyclic trigger (mandatory); support Change-of-State (mandatory for discrete devices,
  optional for non-discrete/rack connections) (§5.2.3.b-c).
- Support Electronic Key segments in Forward_Open, *and* a Null key segment, *and* no key segment
  at all (§5.2.3.h) — this codebase's `_checkElectronicKey()` handles the keyed cases; verify it
  still no-ops correctly when `path.electronicKey` is undefined.
- Support the 32-bit Run/Idle Header on O→T data (§5.2.3.i).
- Provide a "heartbeat" connection path (0 data length, no Run/Idle header) for one-directional
  connection pairs (§5.2.3.g).
- Retain configuration across all-connections-closed; may lose it on reset (§5.2.4 note).
- Assembly-based connections must order path segments as: Configuration instance, Consumed
  (O→T) connection point, Produced (T→O) connection point (§5.2.5).
- Must NOT report the deprecated Connection Manager extended status codes (§5.2.8).
- EDS `[Connection Manager]` section required if the device accepts Class 1 connections (§5.5.3).

**Scanner (Originator) devices** (§6) — this is `client.js`/`scanner.js`'s job:
- Originate ≥8 Class 1 I/O connections minimum (64+ recommended) (§6.2.2).
- Support both Cyclic and (recommended) Change-of-State with Production Inhibit Timer (§6.2.3.a-b).
- Support Listen-Only, Input-Only, and Exclusive-Owner connection types (§6.2.3.c-d).
- Support multicast T→O with unicast O→T, *and* unicast T→O (§6.2.3.e).
- IGMPv2: join on Forward_Open response to a multicast connection, leave on close (§6.3.2).
- Recommended: support the Extended Symbolic path segment as both originator and target, for
  interoperable peer-to-peer (tag-based) communication (§6.2.8) — directly relevant to this
  project's Produced/Consumed Tag Connection work (see §5 below).

## 5. This project's own compliance state and known gaps

The full, currently-accurate table lives in the top-level `README.md` (§1, "Fitur & Status
Compliance ODVA") — read that for the up-to-date done/partial/missing breakdown before assuming
anything here is still true; README is the source of truth for *current* status, this file is for
*orientation and sourcing*. As of this writing, notable points an implementer should know before
touching related code:

- **Electronic Key validation** (`connection-handler.js`'s `_checkElectronicKey()`) was ported
  field-for-field from OpENer's `CheckElectronicKeyData()` after an initial spec-reading attempt got
  the compatible-keying rules subtly wrong (Major must match *exactly*, not `>=`; Minor=0 is a
  wildcard in strict mode but NOT in compatible mode). Do not "simplify" this function without
  re-reading OpENer's version first.
- **EDS Revision must be clamped to 1-255 at construction, not just at export.** `DeviceBuilder`
  and `IdentityObject` both clamp `revision.major`/`revision.minor` to `[1,255]` for exactly this
  reason: if the *live* Identity's revision and the *generated EDS*'s declared revision ever diverge
  (e.g. one side defaults to 0, the other clamps to 1), a real Scanner using compatible keying reads
  the EDS's revision, asks for exactly that at Forward_Open, and gets rejected against the live
  device with a Revision mismatch (0x0116) — reproduced live against a real Delta PLC before the
  fix. If you add another path that constructs an Identity or generates an EDS, make sure both
  still agree.
- **Produced/Consumed Tag Class 1 Connections** work in the tested direction (a real Scanner/PLC
  opening a symbolic-tag Forward_Open against this library's Adapter) but the *reverse* direction
  (this library's Scanner opening a symbolic Forward_Open against a real PLC's own produced tag)
  is untested and was rejected live with extended status `0x0127` ("configuration path parameters
  mismatch" per Delta's own manual) using this project's `encodeSymbolicPath()`-only connectionPath
  — the real wire format a Delta PLC's own Connection Manager expects for that direction is not
  yet known. Don't assume symmetry between the two directions without a real capture.
- **No Symbol Object (Class 0x6B)** — deliberately not implemented; confirmed a real Delta SX3
  doesn't have one either (its own EDS has no `[Symbol Class]`/0x6B section). Tag names in a
  Scanner's config tool are typed manually, not browsed. Don't add browsing/discovery for tag
  names expecting it to match a real Delta workflow — it wouldn't.
- **No Multicast I/O production** — `connection-handler.js` decodes the requested connection type
  bit but always produces unicast to the Originator's address, which is a real, currently-unaddressed
  gap against §6.2.3.e above (relevant if this Adapter's connections are ever exercised by a Scanner
  requiring multicast — e.g. per §5.2.3.d's connection combinations, which assume the Adapter CAN
  multicast). The address-allocation algorithm is already sourced — OpENer's
  `CipTcpIpCalculateMulticastIp()` implements CIP Vol 2 §3-5.3 exactly — see
  `docs/ODVA_COMPLIANCE_REFERENCE.md` §2's Adapter gap list for the full formula and what's left
  to wire up (TCP/IP Object Multicast Configuration, an actual multicast UDP send path, off-subnet
  rejection, and sharing one producer per T→O instance instead of one per connection).
- **Exclusive-Owner / Input-Only / Listen-Only connection-type classification is now implemented**
  (`registerConnectionPoint()`/`_classifyConnectionType()` in `connection-handler.js`, ported from
  OpENer's `appcontype.c`) — classification is by which pre-registered (O→T, T→O) slot pair a
  Forward_Open's path matches, NOT by O→T size being zero. `DeviceBuilder.defineConnection()`
  auto-registers all three slot types per profile. If you touch connection acceptance logic, run
  `test/connection-handler_spec.js`'s "Connection-type classification" suite — it encodes the exact
  OpENer rules (Ownership Conflict `0x0106`, "no master yet" `0x0119`) as executable tests, not just
  documentation.

## 6. Ground rules before changing protocol-level code

1. **Run `npm test` before and after.** 300+ tests exist specifically to catch protocol regressions;
   a change that "should" work but breaks tests is wrong until proven otherwise, not the tests.
2. **New CIP behavior needs a citation, not a rationalization.** If you're implementing a new
   service, error code, or connection rule, either point to the exact OpENer function you ported it
   from, the exact PUB00070/PUB00213 section, or a real device's own EDS/manual. "This seems like
   what the spec would want" is how the Electronic Key and EDS-revision bugs above happened.
3. **Never claim "ODVA compliant" or "fixed" for a real-hardware issue without live verification**
   against either a real device or the actual reference stack. This project has direct access to a real
   Delta SX3 PLC for exactly this reason — use it before asserting a fix works.
4. **Keep Tier 1 (protocol core, `src/cip/`, `src/encapsulation/`) vendor-neutral.** Vendor-specific
   behavior belongs in `src/vendors/` (client-side DeviceProfiles) or as an additive, opt-in registered
   object (server-side, e.g. `src/cip/objects/delta-registers.js`) — never as an `if (vendor === ...)`
   branch inside the core protocol code.
5. **See also**: `docs/VIRTUAL_DEVICE_GUIDE.md` (building an Adapter/virtual device),
   `docs/VENDOR_GUIDE.md` (adding a Scanner-side DeviceProfile for a new PLC vendor/model),
   `docs/ODVA_COMPLIANCE_REFERENCE.md` (full transcribed requirement text), `docs/ROADMAP.md`
   (where this project is headed next), `.agents/rules/ethernet-ip-standards.md` (concrete
   commit/testing conventions for this repo).
