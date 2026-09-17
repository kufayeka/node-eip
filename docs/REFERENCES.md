# EtherNet/IP & CIP — Reference Bibliography

Compiled resource list for implementing a spec-compliant ODVA EtherNet/IP (CIP)
driver. Organized by category; use the reading order at the bottom if starting
from zero.

## 1. Official ODVA specifications & public technical papers

Official access (requires ODVA "Licensed Vendor" membership, paid):
- Document Library — https://www.odva.org/technology-standards/document-library/
- Specifications subscription — https://www.odva.org/subscriptions-services/specifications/
- Spec/VID/CT order form — https://www.odva.org/spec-vid-ctsoftware-order-form/

Publicly mirrored full-text copies (no membership needed):
- Internet Archive "ODVA CIP Documentation" — https://archive.org/details/ovda_cip_docs
  (Vol 1 CIP Common, Vol 2 EtherNet/IP Adaptation, Vol 3 DeviceNet, Vol 5 CIP
  Safety, Vol 7 Modbus integration, plus the CIP Conformance Test Spec — the
  single best free source for normative text)
- dokumen.pub Vol 2 EtherNet/IP Adaptation — https://dokumen.pub/download/ethernet-ip-adaptation-of-cip-2-14nbsped.html
- dokumen.pub Vol 1 Common Industrial Protocol — https://dokumen.pub/common-industrial-protocol-cip-1-33nbsped.html

Free ODVA whitepapers/handbooks (no login):
- EtherNet/IP Quick Start for Vendors Handbook (PUB00213R0) — https://www.odva.org/wp-content/uploads/2020/05/PUB00213R0_EtherNetIP_Developers_Guide.pdf
- CIP on Ethernet Technology (PUB00138) — https://www.odva.org/wp-content/uploads/2024/04/PUB00138R8_Ethernet.pdf
- Common Industrial Protocol and Family of CIP Networks (PUB00123R1) — https://www.odva.org/wp-content/uploads/2020/06/PUB00123R1_Common-Industrial_Protocol_and_Family_of_CIP_Networks.pdf
- Recommended Functionality for EtherNet/IP Devices (PUB00070) — https://www.odva.org/wp-content/uploads/2020/05/PUB00070_Recommended-Functionality-for-EIP-Devices-v10.pdf
- CIP Security at a Glance (Pub 319) — https://www.odva.org/publication_download/cip-security-at-a-glance-pub-319/
- Spec errata / mandatory change list (PUB00317) — https://www.odva.org/wp-content/uploads/2025/12/PUB00317_ODVA-specification-mandatory-change-list_R22.pdf

Vendor (Rockwell) docs critical for wire-level detail:
- Communicating with RA Products Using EtherNet/IP Explicit Messaging — https://scadahacker.com/library/Documents/ICS_Protocols/Rockwell%20-%20Communicating%20with%20RA%20Products%20Using%20EtherNetIP%20Explicit%20Messaging.pdf
- Type Encoding of Logix Structures in CIP Data Table R/W — https://www.rockwellautomation.com/content/dam/rockwell-automation/sites/downloads/pdf/TypeEncode_CIPRW.pdf
  (essential for STRUCT/UDT/STRING type-code encoding)
- Logix5000 Data Access Programming Manual (1756-PM020) — https://literature.rockwellautomation.com/idc/groups/literature/documents/pm/1756-pm020_-en-p.pdf
  (Read/Write Tag Service 0x4C/0x4D, fragmented 0x52/0x53, symbolic addressing)
- Delivery of CIP Over RA Serial DF1 Links — https://www.rockwellautomation.com/content/dam/rockwell-automation/sites/downloads/pdf/CIPandPCCC_v1_1.pdf
  (PCCC/DF1 passthrough encapsulation)
- Rockwell "EtherNet/IP: Industrial Protocol" whitepaper — https://literature.rockwellautomation.com/idc/groups/literature/documents/wp/enet-wp001_-en-p.pdf

Orientation:
- Wikipedia: EtherNet/IP — https://en.wikipedia.org/wiki/EtherNet/IP
- Wikipedia: Common Industrial Protocol — https://en.wikipedia.org/wiki/Common_Industrial_Protocol

## 2. Open-source reference implementations

- **OpENer** (C, ODVA's own reference stack, adapter-side, passes ODVA conformance) — https://github.com/EIPStackGroup/OpENer
- **CIPster** (C++ port of OpENer) — https://github.com/liftoff-sr/CIPster
- **EIPScanner** (C++, scanner/originator side) — https://github.com/nimbuscontrols/EIPScanner
- **libplctag** (C, production tag client) — https://github.com/libplctag/libplctag
  ([issue #518](https://github.com/libplctag/libplctag/issues/518) on Symbol Instance Addressing)
- **cpppo** (Python, persistent sessions, arbitrary CIP services) — https://github.com/pjkundert/cpppo
- **pycomm3** (Python, Rockwell tag client, strong type encoding) — https://github.com/ottowayi/pycomm3
- **eeip.py** (Python, generic non-Rockwell) — https://github.com/rossmann-engineering/eeip.py
- **EEIP.Java** (Java sibling of eeip.py) — https://github.com/rossmann-engineering/EEIP.Java
- **EthernetIpSharp** (C#, adapter+scanner, CIP Safety) — https://github.com/CristianMori/EthernetIpSharp
- **goindustrial** (Go, clean encapsulation/CIP split) — https://github.com/iceisfun/goindustrial
- **rust-ethernet-ip** (Rust, type-safe modern design) — https://github.com/sergiogallegos/rust-ethernet-ip
- **scala-ethernet-ip** (Scala, minimal encapsulation command classes) — https://github.com/kevinherron/scala-ethernet-ip
- **Wireshark `packet-enip.c`** (most rigorously tested wire-format parser) — https://fossies.org/linux/wireshark/epan/dissectors/packet-enip.c
- **scapy-cip-enip** (Python dissector + status/error code table) — https://github.com/scy-phy/scapy-cip-enip

## 3. Books

- *Industrial Ethernet* (3rd ed.), Perry S. Marshall & John S. Rinaldi, ISA —
  https://www.amazon.com/Industrial-Ethernet-Third-Perry-Marshall/dp/1945541040
  General industrial-Ethernet textbook (Modbus/EtherNet-IP/PROFINET comparison);
  no dedicated wire-protocol book exists outside the ODVA spec itself.

## 4. Forums, Reddit, PLCTalk, Stack Overflow

- PLCTalk: EtherNet/IP Forward Open — https://www.plctalk.net/forums/threads/ethernet-ip-forward-open.121936/
- PLCTalk: Open Source EtherNet/IP Driver (OpENer history) — https://www.plctalk.net/forums/threads/open-source-ethernet-ip-driver.51843/
- PLCTalk: Read Tags using CIP — https://www.plctalk.net/forums/threads/read-tags-using-cip.127247/
- PLCTalk: CIP message development — https://www.plctalk.net/forums/threads/cip-message-development.70514/
- Inductive Automation: Encapsulated DF1 over TCP — https://forum.inductiveautomation.com/t/rockwell-comms-encapsulated-df1-over-tcp/12598
- Inductive Automation: Logix Abbreviated Data Types (UDT CRC codes) — https://forum.inductiveautomation.com/t/logix-abbreviated-data-types/103527
- HMS: Forward Open Connection Failure — https://support.hms-networks.com/hc/en-us/community/posts/14783362572818-AB6674-Ethernet-IP-Forward-Open-Connection-Failure
- GitHub issue: libplctag #518, Symbol Instance Addressing — https://github.com/libplctag/libplctag/issues/518
- GitHub issue: etherip #7, "Unable to write STRUCT value" — https://github.com/EPICSTools/etherip/issues/7

r/PLC has little dedicated protocol-internals discussion (mostly ladder-logic
focused) — PLCTalk.net is the far richer forum source for this topic.

## 5. Protocol write-ups / blog posts / academic papers

- dev.to: "Abandoning Abstractions: Manually Crafting EtherNet/IP Packets Almost
  Broke Me" — https://dev.to/null_saint/abandoning-abstractions-manually-crafting-ethernetip-packets-almost-broke-me-1b2k
  (documents the "silent failure on malformed CPF/path" gotcha)
- scadaprotocols.com series:
  - CIP Object Model Explained — https://scadaprotocols.com/cip-object-model-classes-instances-attributes-services/
  - CIP Assembly Object Explained — https://scadaprotocols.com/cip-assembly-object-explained/
  - Wireshark for EtherNet/IP decode guide — https://scadaprotocols.com/wireshark-ethernet-ip-cip-decode-guide/
  - CIP General Status Codes Reference — https://scadaprotocols.com/cip-general-status-codes-reference/
- HackTricks: Pentesting EthernetIP (port 44818) — https://hacktricks.wiki/en/network-services-pentesting/44818-ethernetip.html
- idc-online.com: EtherNet/IP Multicasting Explained (PDF) — https://www.idc-online.com/technical_references/pdfs/data_communications/Ethernet_IP_Multicasting_Explained.pdf
- library.automationdirect.com: Implicit vs Explicit Messaging — https://library.automationdirect.com/ethernetip-implicit-vs-explicit-messaging/
- rtautomation.com: DeviceNet CIP Connections (shared Connection Manager model) — https://www.rtautomation.com/rtas-blog/devicenet-cip-connections/
- "Enhancing Industrial Communication with EtherNet/IP" (NCBI, from-scratch C++/Linux implementation write-up) — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10611002/

## 6. Node.js-specific (existing prior art — scope gaps to avoid repeating)

- **node-ethernet-ip** (unmaintained, author redirects to fork below) — https://github.com/cmseaton42/node-ethernet-ip
- **ST-node-ethernet-ip** (maintained fork, npm `st-ethernet-ip`) — https://github.com/SerafinTech/ST-node-ethernet-ip
  Known bug: [issue #83](https://github.com/SerafinTech/ST-node-ethernet-ip/issues/83) —
  fragmented tag read (Service 0x52) corrupts buffer at the 448-byte boundary
  (unstripped 2-byte fragment header).
- **ethernet-ip-cip** — https://github.com/hirokiht/ethernet-ip-cip
  Only atomic datatypes supported; STRING/ARRAY/UDT never landed.
- **node-red-contrib-cip-ethernet-ip / cip-suite** — https://flows.nodered.org/node/node-red-contrib-cip-ethernet-ip
  Same class of 448-byte fragmentation bug independently reported in
  [blanpa/node-red-contrib-cip-suite#15](https://github.com/blanpa/node-red-contrib-cip-suite/issues/15).

**Takeaway:** no existing Node.js library claims full CIP compliance (implicit
I/O + Class 3 explicit + generic ODVA object model). Every one is scoped to
Rockwell tag read/write, and at least two independent codebases hit the exact
same fragmentation-boundary bug — this is the gap this project fills, and a
concrete regression test to write early.

## Suggested reading order (starting from zero)

1. PUB00138 (CIP on Ethernet Technology) + PUB00123R1 (CIP & Family of Networks) — object-model mental model.
2. library.automationdirect.com implicit-vs-explicit primer — Class 1 vs Class 3 before touching bytes.
3. PUB00213R0 (EtherNet/IP Quick Start for Vendors) — encapsulation/session walkthrough.
4. CIP Networks Library Vol 1 & 2 (Internet Archive mirror) — the load-bearing normative text; keep open throughout.
5. Wireshark `packet-enip.c` next to a real capture (use the scadaprotocols Wireshark guide).
6. Read OpENer (adapter/Class 1) and cpppo or pycomm3 (client/explicit) — two independent working implementations of the same spec.
7. Rockwell type-encoding + explicit-messaging + Logix5000 Data Access docs — layer in Rockwell tag services (0x4C/0x4D/0x52/0x53) and UDT/STRING encoding.
8. libplctag #518 + ST-node-ethernet-ip #83 + cip-suite #15 — gotcha checklist before writing fragmented read/write logic.
9. idc-online.com multicast paper + Forward Open/Connection Manager material — implicit (I/O) connections, RPI, multicast.
10. dev.to "Abandoning Abstractions" — sanity-check narrative on packet-capture-driven debugging.
