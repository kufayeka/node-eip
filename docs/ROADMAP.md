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
  classification" suite. Each connection's producer is still an independent unicast stream per
  listener — see Multicast below for the follow-up that would let them share one.

## Near-term (concrete, scoped gaps)

1. **Multicast Class 1 I/O production.** Datagrams are always sent unicast to the Originator
   regardless of the requested connection type. Blocks full compliance with PUB00070 §5.2.3d's
   required connection combinations. The address-allocation algorithm is already sourced (not a
   research task anymore) — OpENer's `CipTcpIpCalculateMulticastIp()` implements CIP Vol 2 §3-5.3:
   `239.192.1.0 + ((hostId - 1 & 0x3FF) << 5)` from the device's own IP/netmask. Remaining work:
   TCP/IP Object Multicast Configuration (Attribute 9), an actual multicast UDP send path, the
   off-subnet rejection check (`0x0813`, OpENer's TTL=1 assumption), and reworking Listen-Only
   connections (now that connection-type classification exists — see Done above) to share one
   multicast producer per T→O instance instead of each running its own unicast timer.
2. **Performance measurement against PUB00070's actual tolerances** (§2.5, §5.6, §6.6 — RPI
   accuracy, jitter under background traffic, burst recovery). The tooling already exists
   (`analyze-eip-dump.js`) — this is a matter of running it against the documented test conditions
   (including simulated background ARP/DHCP/ICMP/NTP traffic) and reporting real numbers instead of
   leaving them as "not measured" in the compliance reference.
3. **Reverse-direction symbolic Tag Connection** (this library as Scanner, opening a Produced/
   Consumed tag connection against a real PLC's own produced tag). Currently rejected live with
   extended status `0x0127` against a real Delta PLC using a bare `encodeSymbolicPath()` connection
   path. Needs a real packet capture of two genuine Delta (or other ControlLogix-style) devices
   successfully doing this, to reverse-engineer the actual expected wire format — guessing further
   without a reference capture isn't worth the cycles.

## Medium-term

4. **Turn the ODVA compliance checklist into executable tests, not just documentation.**
   `docs/ODVA_COMPLIANCE_REFERENCE.md` transcribes PUB00070's Adapter/Scanner requirements with a
   done/gap breakdown maintained by hand. Where mechanically testable (e.g. "accept a Null key
   segment", "accept ≥2 simultaneous Class 1 connections", "reject the deprecated extended status
   codes"), each item should become a real `test/*_spec.js` case that fails loudly the moment a
   regression reintroduces the gap — this keeps the "kiblat" enforced by CI, not just by whichever
   AI/human last read the skill file.
5. **More vendor `DeviceProfile`s.** Only Delta (ES2/SX3/DVP12SE) and a starter Rockwell Logix
   profile exist today. Omron (NX/NJ Sysmac), Siemens (via their EtherNet/IP option modules), and
   Rockwell Micro800 are the next most commonly requested industrial PLC families. Follow
   `docs/VENDOR_GUIDE.md` §2's translation process — this is now a well-documented, repeatable task
   rather than research from scratch each time.
6. **Verify virtual-device interoperability beyond Delta EIP Builder.** Every real-hardware
   interoperability finding in this codebase so far (tag-connection quirks, revision caching, no
   Symbol Object) comes from testing against one vendor's config software. Testing the same
   `DeviceBuilder`-generated EDS against Rockwell Studio 5000 and/or Omron Sysmac Studio would
   either confirm these findings generalize or surface vendor-specific config-tool differences that
   need their own documented workarounds.

## Longer-term / larger investments

7. **CIP Security (TLS-secured EtherNet/IP).** A newer ODVA extension (EtherNet/IP Security
   Profile) layering TLS/DTLS onto explicit and implicit messaging. Relevant if this project is
   ever used in a context where OT network security posture matters beyond a lab/dev setting — a
   substantial, mostly-independent addition (certificate handling, secure session establishment) on
   top of the existing plaintext stack, not a small patch.
8. **CIP Safety.** Explicitly out of scope unless a concrete need arises — it's a separate,
   heavily-regulated protocol layer (redundant CRCs, time-stamped safety packets, functional safety
   certification implications) that would dominate the project's scope if taken on lightly.
9. **Symbol Object (Class 0x6B) / tag browsing — deliberately still not planned.** Real Delta SX3
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
