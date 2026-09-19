# Roadmap

Prioritized from concrete gaps this project already knows about (found via real testing and the
ODVA compliance audit in `docs/ODVA_COMPLIANCE_REFERENCE.md`), not aspirational feature wishlisting.
Re-evaluate this list whenever `docs/ODVA_COMPLIANCE_REFERENCE.md` or the README's compliance
table changes — it should stay a living reflection of known gaps, not a fixed plan.

## Done

- **Connection-type semantics (Listen-Only / Input-Only vs. Exclusive-Owner).** ✅ Implemented —
  `connection-handler.js`'s `registerConnectionPoint()`/`_classifyConnectionType()`, ported from
  OpENer's `appcontype.c`. `DeviceBuilder.defineConnection()` auto-registers all three slot types
  per profile; a PLC can now own an Exclusive-Owner connection while an HMI/SCADA independently
  runs a Listen-Only connection to the same T→O data, with the real ODVA rejection rules enforced
  (Ownership Conflict `0x0106`, "no master yet" `0x0119`). See
  `docs/ODVA_COMPLIANCE_REFERENCE.md` §2 and `test/connection-handler_spec.js`'s "Connection-type
  classification" suite.

- **Multicast Class 1 I/O production.** ✅ Implemented — `TcpIpInterfaceObject.multicastAddress`/
  `calculateMulticastIp()` (CIP Vol 2 §3-5.3, OpENer's `CipTcpIpCalculateMulticastIp()` exactly),
  off-subnet rejection (`0x0813`), and an owner/follower model ported from OpENer's
  `OpenProducingMulticastConnection()`: the first multicast Forward_Open to a T→O instance starts
  the real producer; later ones share its stream and `toNetworkConnectionId` instead of each
  running a redundant unicast timer — the connection-type classification above is what made this
  possible to build correctly (a Listen-Only connection is exactly the kind of thing that should
  become a multicast follower). See `docs/ODVA_COMPLIANCE_REFERENCE.md` §2 and
  `test/connection-handler_spec.js`'s "Multicast Class 1 I/O production" suite. Known
  simplification: closing the owner closes its followers too, rather than OpENer's more elaborate
  master-handover-to-another-connection behavior — revisit if a real deployment needs a multicast
  stream to survive its original owner closing while followers remain.

## Near-term (concrete, scoped gaps)

1. **Performance measurement against PUB00070's actual tolerances** (§2.5, §5.6, §6.6 — RPI
   accuracy, jitter under background traffic, burst recovery). The tooling already exists
   (`analyze-eip-dump.js`) — this is a matter of running it against the documented test conditions
   (including simulated background ARP/DHCP/ICMP/NTP traffic) and reporting real numbers instead of
   leaving them as "not measured" in the compliance reference.
2. **Reverse-direction symbolic Tag Connection** (this library as Scanner, opening a Produced/
   Consumed tag connection against a real PLC's own produced tag). Currently rejected live with
   extended status `0x0127` against a real Delta PLC using a bare `encodeSymbolicPath()` connection
   path. Needs a real packet capture of two genuine Delta (or other ControlLogix-style) devices
   successfully doing this, to reverse-engineer the actual expected wire format — guessing further
   without a reference capture isn't worth the cycles.

## Medium-term

3. **Turn the ODVA compliance checklist into executable tests, not just documentation.**
   `docs/ODVA_COMPLIANCE_REFERENCE.md` transcribes PUB00070's Adapter/Scanner requirements with a
   done/gap breakdown maintained by hand. Where mechanically testable (e.g. "accept a Null key
   segment", "accept ≥2 simultaneous Class 1 connections", "reject the deprecated extended status
   codes"), each item should become a real `test/*_spec.js` case that fails loudly the moment a
   regression reintroduces the gap — this keeps the "kiblat" enforced by CI, not just by whichever
   AI/human last read the skill file.
4. **More vendor `DeviceProfile`s.** Only Delta (ES2/SX3/DVP12SE) and a starter Rockwell Logix
   profile exist today. Omron (NX/NJ Sysmac), Siemens (via their EtherNet/IP option modules), and
   Rockwell Micro800 are the next most commonly requested industrial PLC families. Follow
   `docs/VENDOR_GUIDE.md` §2's translation process — this is now a well-documented, repeatable task
   rather than research from scratch each time.
5. **Verify virtual-device interoperability beyond Delta EIP Builder.** Every real-hardware
   interoperability finding in this codebase so far (tag-connection quirks, revision caching, no
   Symbol Object) comes from testing against one vendor's config software. Testing the same
   `DeviceBuilder`-generated EDS against Rockwell Studio 5000 and/or Omron Sysmac Studio would
   either confirm these findings generalize or surface vendor-specific config-tool differences that
   need their own documented workarounds.

## Longer-term / larger investments

6. **CIP Security (TLS-secured EtherNet/IP).** A newer ODVA extension (EtherNet/IP Security
   Profile) layering TLS/DTLS onto explicit and implicit messaging. Relevant if this project is
   ever used in a context where OT network security posture matters beyond a lab/dev setting — a
   substantial, mostly-independent addition (certificate handling, secure session establishment) on
   top of the existing plaintext stack, not a small patch.
7. **CIP Safety.** Explicitly out of scope unless a concrete need arises — it's a separate,
   heavily-regulated protocol layer (redundant CRCs, time-stamped safety packets, functional safety
   certification implications) that would dominate the project's scope if taken on lightly.
8. **Symbol Object (Class 0x6B) / tag browsing — deliberately still not planned.** Real Delta SX3
    hardware doesn't implement this either, and implementing it here wouldn't fix the actual
    friction point (manual tag entry in third-party config software, which doesn't query it even
    when present on ControlLogix-style devices). Revisit only if a specific config tool is found
    that DOES query it and would benefit.

## How to use this document

When picking up a roadmap item: read the relevant section of
`docs/ODVA_COMPLIANCE_REFERENCE.md` and `.agents/skills/odva-cip-compliance/SKILL.md` first, write
or extend the test that should have caught the gap, then implement. Update the compliance
reference's done/gap table and this file in the same change — a roadmap item that's been shipped
but not removed here just becomes a second source of truth to keep in sync, which is exactly the
failure mode this whole documentation set exists to avoid.
