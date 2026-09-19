# ODVA CIP / EtherNet/IP Compliance Reference

This document transcribes the actual normative and recommended requirements for EtherNet/IP
Scanner (Originator) and Adapter (Target) devices from **public, freely available ODVA
publications**, and cross-references them against this project's own implementation where that
has actually been verified. For the condensed orientation version and this project's architecture
map, see `.agents/skills/odva-cip-compliance/SKILL.md`. For the current, authoritative done/
partial/missing feature table, see the top-level `README.md` §1 — this document explains and
sources that table, it does not replace it.

**Sources** (all public, no ODVA membership required):
- [PUB00070R10 — Recommended Functionality for EtherNet/IP Devices](https://www.odva.org/wp-content/uploads/2020/05/PUB00070_Recommended-Functionality-for-EIP-Devices-v10.pdf) (ODVA Roundtable for EtherNet/IP Implementors, Nov 2018)
- [PUB00213R0 — EtherNet/IP Quick Start for Vendors Handbook](https://www.odva.org/wp-content/uploads/2020/05/PUB00213R0_EtherNetIP_Developers_Guide.pdf) (ODVA, 2008)
- [ODVA Conformance Testing](https://www.odva.org/technology-standards/conformance-testing/)
- [ODVA Document Library](https://www.odva.org/technology-standards/document-library/)
- [OpENer](https://github.com/EIPStackGroup/OpENer) — ODVA-conformance-tested open source reference stack (used throughout this project's own source as ground truth; see code comments in `src/adapter/connection-handler.js` and `src/adapter.js` for exact ported functions)
- The full **CIP Networks Library (Volume 1 & 2)** is the actual normative specification but requires
  an ODVA subscription (<https://www.odva.org/subscriptions-services/specifications/>) — not
  reproduced here; section numbers cited in this codebase's comments (e.g. "CIP Vol 1 §3-5.5.3")
  come from it and should be treated as a claim to verify if you have access, not re-derived from
  scratch.

> PUB00070's own framing (§1.2): these are *recommendations* from the EtherNet/IP Implementors
> Workshops, not hard requirements of the CIP/EtherNet/IP specification itself — a device can be a
> valid, spec-compliant EtherNet/IP device without meeting every item here. They are, however,
> exactly the checklist real interoperability testing (PlugFests) and real-world PLCs' config
> software (like Delta EIP Builder) implicitly assume. "shall" = the document's own mandatory
> language for a device to claim adherence to the recommendation; "recommended"/"should" = optional.

---

## 1. Common Device Requirements (PUB00070 §2)

Applies to every EtherNet/IP device regardless of class.

| # | Requirement | Section |
|---|---|---|
| 1 | Support ≥3 concurrent Encapsulation sessions | §2.1.1a |
| 2 | Support ≥6 concurrent Transport Class 3 (explicit) connections | §2.1.1b |
| 3 | Support >1 Class 3 connection per Encapsulation session | §2.1.1c |
| 4 | Support unconnected AND connected messaging concurrently in one session | §2.1.2 |
| 5 | Generic devices report Device Type `0x2B` (Device Type `0x00` is deprecated) | §2.1.3 |
| 6 | Class 3 connections support Low and High priority (servers only) | §2.1.4 |
| 7 | Support TCP/IP features per EtherNet/IP spec Vol 2 §9-3 | §2.2.1 |
| 8 | Follow PUB00028 IP addressing recommendations (BOOTP/DHCP at first boot, enable/disable via TCP/IP Object, settable/persistent IP via TCP/IP Object) | §2.2.2 |
| 9 | Reserve ≥3 concurrent TCP connections for CIP | §2.2.3 |
| 10 | Support UDP (ListIdentity is typically UDP broadcast) | §2.2.4 |
| 11 | Stop BOOTP/DHCP requests once an IP is obtained; never issue them when statically configured | §2.2.5-6 |
| 12 | Full Duplex, 10/100Mbps, auto-negotiation with manual override, persistent link settings | §2.3.1-3 |
| 13 | MAC address visible on the device (e.g. a label) | §2.3.4b |
| 14 | EtherNet/IP status LEDs (Module/Network Status) per Vol 2 §9.4 (industrial devices) | §2.3.5-6 |
| 15 | EDS shall include `[Capacity]` section (Vol 1 §7-3.6.13) | §2.4 |
| 16 | Response time targets: ListIdentity/ListServices <250ms; unconnected explicit (no TCP) <500ms; unconnected explicit (TCP up) / connected explicit <100ms; 2 back-to-back explicit requests without drop, 1ms apart | §2.5.1 |
| 17 | Duplicate IP Address (ACD) detection per Vol 2 Appendix F | §2.6 |

**This project:** #5 is satisfied (`DeviceBuilder` defaults `deviceType` to `0x002B`). #15 is
satisfied (`eds-exporter.js` always emits `[Capacity]`). #8/#12/#13 are largely **not applicable** —
this is a software process, not a physical NIC; it doesn't control BOOTP/DHCP client behavior,
auto-negotiation, or carry a physical label. #16 (response-time targets) and #17 (ACD) have not
been measured/implemented; treat as open items, not silently assumed compliant.

## 2. Adapter (Target) Device Requirements (PUB00070 §5)

Applies to devices that *accept* Class 1 I/O connections — this project's `src/adapter.js` +
`src/adapter/connection-handler.js`. Example devices per the spec: Block I/O, Weigh Scale, AC
Variable Frequency Drive — i.e. exactly the kind of device `DeviceBuilder` is meant to simulate.

| # | Requirement | Section |
|---|---|---|
| 1 | All Common Device recommendations (§2.1) | §5.2.1 |
| 2 | Accept ≥2 simultaneous Class 1 connections (1 Exclusive-Owner-or-Input-Only for a controller + 1 Input-Only-or-Listen-Only for a monitor, same T→O point), *simultaneously with* 6 Class 3 (8 total) | §5.2.2 |
| 3a | Support bi-directional connections (non-null O→T and T→O); uni-directional (null one side) is optional | §5.2.3a |
| 3b | Support Cyclic trigger type | §5.2.3b |
| 3c | Support Change of State (COS) trigger type — mandatory except optional for non-discrete devices and rack connections | §5.2.3c |
| 3d | Support ALL FOUR combinations of {multicast/unicast T→O} × {multicast/unicast Input-Only-or-Listen-Only alongside a unicast O→T Exclusive Owner} for the same T→O connection point simultaneously | §5.2.3d |
| 3e | Support an Exclusive Owner connection if the device has output data | §5.2.3e |
| 3f | Support a Listen-Only or Input-Only connection with >1 listener if the device has input data | §5.2.3f |
| 3g | Provide a "heartbeat" connection path (0 data length, no Run/Idle header) for one-directional pairs | §5.2.3g |
| 3h | Support Electronic Key segments in Forward_Open, AND a Null key segment, AND no key segment at all | §5.2.3h |
| 3i | Support the 32-bit Real-Time Header (Run/Idle Header) on O→T data | §5.2.3i |
| 3j | Support priorities High and Scheduled | §5.2.3j |
| 4 | Accept a Configuration path in Forward_Open (None/Null/Non-Null data segment handling); retain configuration across all-connections-closed | §5.2.4 |
| 5 | Assembly-based connections: path segment order = Configuration instance, Consumed (O→T) point, Produced (T→O) point | §5.2.5 |
| 6 | Configuration parameters accessible via Explicit Messaging (not web-only) | §5.2.6 |
| 7 | I/O Data attribute accessible via explicit messaging (Assembly instance attribute 3); writes to Output data rejected while an active I/O connection owns it; Real-Time Header excluded from the attribute | §5.2.7 |
| 8 | Must NOT report deprecated Connection Manager extended status codes | §5.2.8 |
| 9 | EDS `[Assem]`/`[Params]` sections detail I/O and configuration data format; `[Connection Manager]` section present | §5.5 |
| 10 | Performance: min supported RPI 100ms; mean/stdev/jitter of measured packet interval within specific tolerances under no-traffic, steady background traffic, and traffic bursts | §5.6 |

**This project — verified this session:**
- #3b/#3c (Cyclic + Change-of-State trigger): **done**. `connection-handler.js`'s `_startProducer()`
  decodes the Scanner's chosen trigger and drives production accordingly; `eds-exporter.js`
  advertises both bits (`0x04030002`) for Exclusive-Owner connections, matching a real Delta SX3's
  own EDS.
- #3h (Electronic Key incl. Null/no key): **done**, ported from OpENer's `CheckElectronicKeyData()`;
  `_checkElectronicKey()` no-ops when no key segment is present.
- #3i (Run/Idle Header): **done** — `buildIoDatagram`/`handleIncomingDatagram` support it.
- #7 (I/O Data via explicit messaging, size-mismatch rejection): **done** — `AssemblyObject`
  enforces exact size match, matching real Delta hardware's own observed behavior.
- #6 (config via explicit messaging): **done** for `ParameterObject`/tags, always (Get/Set_Attribute_Single).
- #2/#3f (simultaneous Exclusive-Owner + Listen-Only/Input-Only to the SAME connection point):
  **done**. `connection-handler.js` now classifies a Forward_Open's (O→T, T→O) pair against
  explicitly registered slots — `registerConnectionPoint()` / `_classifyConnectionType()`, ported
  from OpENer's `appcontype.c` (`GetIoConnectionForConnectionData()` and its per-type helpers), the
  actual reference-stack algorithm: classification is by which pre-declared slot pair the path
  matches, NOT by O→T size. `DeviceBuilder.defineConnection()` auto-registers all three slot types
  per profile (Exclusive-Owner at the real Assembly instances; Input-Only/Listen-Only at reserved
  placeholder O→T instances, `0xC0`+ by convention, one pair per profile — matching this project's
  own real Delta SX3 EDS's own placeholder-instance convention), and `eds-exporter.js` emits all
  three as separate EDS `ConnectionN` entries. Enforced at runtime: a Listen-Only Forward_Open is
  rejected with extended status `0x0119` if no Exclusive-Owner/Input-Only "master" connection
  exists yet for that T→O instance (OpENer's own rule); a second Exclusive-Owner Forward_Open to
  an already-owned T→O instance from a *different* originator is rejected with `0x0106` (Ownership
  Conflict); multiple simultaneous Listen-Only connections from different originators to the same
  T→O instance coexist correctly. A connection profile that never registers slots (e.g. every
  pre-existing test predating this feature) keeps the original generic/legacy behavior unchanged —
  this was an additive change, not a breaking one.

**Not yet audited/implemented — flagged here rather than assumed:**
- #3d (multicast T→O): **not implemented yet, but the exact algorithm is now sourced**: OpENer's
  `CipTcpIpCalculateMulticastIp()` (`ciptcpipinterface.c`) implements CIP Vol 2 §3-5.3 "Multicast
  Address Allocation for EtherNet/IP" — `base 239.192.1.0 + ((hostId - 1 & 0x3FF) << 5)`, where
  `hostId` is the device's own IP masked to its host portion. Implementing this fully means: TCP/IP
  Interface Object Multicast Configuration (Attribute 9), an actual UDP multicast send path, an
  off-subnet rejection check (OpENer's `kConnectionManagerExtendedStatusCodeNotConfiguredForOffSubnetMulticast`
  = `0x0813`, TTL=1 assumption), and — for real bandwidth benefit — reworking Listen-Only
  connections to share one multicast producer per T→O instance instead of each running its own
  independent unicast timer (which they currently still do; connection-type classification above
  is orthogonal to and doesn't block this). Scoped out of this pass; see `docs/ROADMAP.md`.
- #3g (heartbeat connection path with 0-length, no-header): not specifically modeled as a distinct
  path; the Listen-Only/Input-Only EDS fallback branches in `eds-exporter.js` declare `0x02010002`
  transport types but this hasn't been cross-checked against §3g's exact framing.
- #10 (performance numbers): not measured against these specific tolerances. Related: this
  project's own `analyze-eip-dump.js` tool (see `packages/node_modules/analyze-eip-dump.js` in
  the parent workspace) computes mean/stdev/jitter from a live capture and can be pointed at
  these exact PUB00070 §5.6 tolerances for a real measurement, if this is ever prioritized.

## 3. Scanner (Originator) Device Requirements (PUB00070 §6)

Applies to devices that *originate* Class 1 I/O connections — this project's `src/scanner.js` +
`src/client.js`. Example devices per the spec: Programmable Controller, Soft Controller, Robot.

| # | Requirement | Section |
|---|---|---|
| 1 | All Common Device recommendations | §6.2.1 |
| 2 | Originate ≥8 Class 1 I/O connections minimum (64+ recommended) | §6.2.2 |
| 3a | Recommended: support COS trigger with Production Inhibit Timer (PIT) | §6.2.3a |
| 3b | Support Cyclic trigger type | §6.2.3b |
| 3c | Support Listen-Only and Input-Only connection types | §6.2.3c |
| 3d | Support Exclusive-Owner connection type | §6.2.3d |
| 3e | Support multicast T→O with unicast O→T, AND unicast T→O | §6.2.3e |
| 3f | Support 32-bit Real-Time Header on O→T; support connections WITHOUT it too (per target EDS) | §6.2.3f |
| 4 | Deliver a device Configuration Assembly (≤400 bytes) with Forward_Open/Large_Forward_Open | §6.2.4 |
| 5 | Provide scan-list I/O data via Explicit Messaging | §6.2.5 |
| 6 | Recommended: support the Connection Configuration Object | §6.2.6 |
| 7 | Recommended: accept (be a target of) ≥2 Class 1 connections itself, with full Adapter-class behavior if so | §6.2.7 |
| 8 | Recommended: support the Extended Symbolic path segment as BOTH originator and target, for interoperable tag-based peer-to-peer communication | §6.2.8 |
| 9 | IGMPv2: join multicast group on Forward_Open response, leave on close | §6.3.2 |
| 10 | EDS `[Connection Manager]` section if the device also accepts Class 1 connections | §6.5.2 |
| 11 | Performance: all Common + (if also an Adapter) all Adapter performance requirements | §6.6 |

**This project:**
- #3b-d (Cyclic, Listen-Only/Input-Only, Exclusive-Owner as originated connection types): the
  encode side (`cip/connection-manager.js`'s `buildForwardOpenRequest`, `ConnectionType` enum) has
  no structural restriction on which combination a caller builds; not independently exercised via a
  dedicated Scanner-side test suite the way the Adapter side is.
- #8 (Extended Symbolic path as originator): **partially explored, not working yet** — this session
  attempted exactly this (Scanner originating a Forward_Open with `encodeSymbolicPath()` against a
  real Delta PLC's own produced tag) and it was rejected with extended status `0x0127`. The gap is
  the exact wire format Delta's own Connection Manager expects for a Scanner-originated symbolic
  Forward_Open — not yet reverse-engineered. See `.agents/skills/odva-cip-compliance/SKILL.md` §5.
- #9 (IGMPv2 join/leave): **not implemented** — this project's Scanner does not currently manage
  multicast group membership; relevant only once multicast Forward_Opens are actually originated.
- The remaining items (#2, #4, #5, #6, #7) have not been specifically audited against this codebase
  in this pass; treat as open questions rather than assumed pass/fail.

## 4. EDS Authoring Guidance (from PUB00213R0 Appendix A)

Practical rules ODVA's own vendor handbook gives for writing a good EDS — cross-checked against
what `src/device/eds-exporter.js` actually does:

- **`[File]`**: administrative; use the URL keyword so users can find the latest EDS version.
  *(Not currently emitted by `eds-exporter.js` — the `HomeURL` field is hardcoded to this project's
  own repo, which is correct for this project's own device, but a generated device's `[File]`
  section doesn't expose a per-device configurable URL — minor, low priority.)*
- **`[Device]`**: identification is done by matching the Identity Object's first 4 attributes —
  **Minor Revision is explicitly excluded from this matching.** Devices needing different runtime
  options must have different EDS files with different Identity attributes. *(Matches this
  project's revision-clamping fix — see SKILL.md §5 — though note ODVA's own text confirms Minor
  isn't part of the device-matching key, only Major/VendorID/ProductCode/DeviceType are; the
  Revision mismatch this project hit live was at the Electronic-Key-compatible-keying layer, a
  related but distinct check from EDS-based device identification.)*
- **`[Connection Manager]`**: "highly recommended to support the full set of three application
  paths (configuration, consumed, produced) ... **Connections that are made to symbolic entities
  (tags) typically do not require a configuration path**." *(This project's Tag Connection
  deliberately omits a configuration path — this directly confirms that choice was correct, not
  an oversight.)*
- RPI/Size/Format guidance: "In most cases, it is best to use a ParamN entry inside the EDS to
  define the min/max/default values for RPI... For size and format, at least one of the two fields
  must be filled... It is strongly recommended to define the format." *(This directly motivated —
  and validates — this project's fix to reference a synthetic Param-backed Assembly in the Tag
  Connection's Format field, since leaving both Size and Format blank left real config software,
  specifically Delta EIP Builder, with no way to resolve a typed-in tag name's byte length.)*
- **`[Capacity]`**: connection count AND connection speed (frames/sec) should both be described.

## 5. Conformance Testing Process (from PUB00213R0)

For context on what "ODVA compliant" formally means, since this codebase can't itself submit to
ODVA testing but should describe its own compliance claims accurately:

1. **In-house testing** — exercise the implementation against real devices/software the eventual
   users will use; explicitly include exception testing (cable disconnects, high network load).
2. **EtherNet/IP Conformance Testing** — mandatory under ODVA's Terms of Usage Agreement for a
   commercial product to use the EtherNet/IP name/logo; run at an ODVA-authorized Test Service
   Provider; a pass yields a **Declaration of Conformity (DOC)**, published by ODVA.
3. **EtherNet/IP Interoperability Testing ("PlugFest")** — optional/advisory, tests against the
   PUB00070 recommendations transcribed above, run ~twice yearly (NA + Europe).
4. **Performance testing** — optional, against the tolerances in PUB00070 §2.5/§5.6/§6.6.

This project has never been submitted to ODVA and holds no DOC — "ODVA compliant" claims in this
codebase's own docs mean "implements the referenced behavior from the cited public spec/reference
stack/real device," verified by this project's own test suite and, where noted, live testing
against real Delta hardware — not a formal ODVA conformance pass. State it that way; don't imply
certification that doesn't exist.
