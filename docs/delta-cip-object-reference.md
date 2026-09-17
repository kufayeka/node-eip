# Delta EtherNet/IP CIP object reference — for development, not usage

This is a literal transcription of the manuals' own CIP object tables, per
PLC family, for driver development reference. It is **not** a usage guide
(see `src/delta/README.md` for that) — it exists so the exact
Class/Instance/Attribute/Access/Data Type contract from Delta's own
documentation is in one place, per device family, instead of scattered
across investigation notes. Every table below is transcribed as-is from
the source PDF; nothing is paraphrased. A **Live?** column is added where
this driver has actually confirmed the row against real hardware.

- **Source A** — `docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf`, Chapter
  8. Covers **DVP-SV3/SX3, DVP-ES3/EX3, AHCPU5x1-EN, AH10EN-5A,
  AHRTU-ETHN-5A** → this driver's `'sx3'`/`'es3'` profiles.
- **Source B** — `docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021 - ES2E- EX2
  - SE2 - SE - {1,2}.pdf` ("DVP-ES2/EX2/EC5/SS2/SA2/SX2/SE&TP Operation
  Manual - Programming", Appendix B.5). Covers **DVP-SE, DVP-SE2,
  DVP26SE, DVP-ES2-E, DVP12SE** → this driver's `'es2'` profile.

---

## Source B — B.5.1 EtherNet/IP Information Supported by DVP-SE / ES2-E Series PLCs

### (1) Object list

| Object Name | DVP12SE Class Code | DVP12SE #of Instance | ES2-E & DVP26SE Class Code | #of ES2-E Instance | #of 26SE Instance |
|---|---|---|---|---|---|
| Identity | 0x01 | 7 | 0x01 | 8 | 8 |
| Message Router | 0x02 | NA | 0x02 | 2 | 2 |
| Assembly | 0x04 | 7 | 0x04 | 8 | 8 |
| Connection Manager | 0x06 | NA | 0x06 | NA | NA |
| X input | 0x64 | 256 | 0x350 | 256 | 256 |
| Y output | 0x65 | 256 | 0x351 | 256 | 256 |
| T Timer | 0x66 | 256 | 0x355 | 256 | 256 |
| M Relay | 0x67 | 4096 | 0x353 | 4096 | 4096 |
| C Counter | 0x68 | 256 | 0x356 | 256 | 256 |
| D Register | 0x69 | 12000 | 0x352 | 10000 | 12000 |
| S Relay | - | - | 0x354 | 1024 | 1024 |
| TCP/IP Interface | 0xF5 | 6 | 0xF5 | 7 | 7 |
| Ethernet Link | 0xF6 | 3 | 0xF6 | 5 | 5 |

### (2) Data types

| 8-bit | 16-bit | 32-bit | 64-bit |
|---|---|---|---|
| USINT | WORD | UDINT | ULINT |
| SINT | UINT | DWORD | LINT |
| BYTE | INT | DINT | |

### (3) Error codes

| Value | Name | Description |
|---|---|---|
| 0 | Success | Success |
| 0x01 | Connection Failure | The forwarding function can not be enabled. |
| 0x04 | Path Segment Error | The segment type is not supported. (ref. V1 C-1.4) |
| 0x05 | Path Destination Unknown | The instance is not supported. |
| 0x08 | Service Not Supported | The service (Get or Set) is not supported. |
| 0x09 | Invalid Attribute Value | The value written is incorrect. |
| 0x0E | Attribute Not Settable | The setting of the attribute is not allowed. |
| 0x13 | Not Enough Data | The length of the data written is too short. |
| 0x14 | Attribute Not Supported | The attribute is not supported. |
| 0x15 | Too Much Data | The length of the data written is too long. |
| 0x16 | Object Not Exist | The object is not supported. |
| 0x20 | Invalid Parameter | The service parameter is not supported. (ref. V1 5-2.3.1) |
| 0x26 | Path Size Invalid | Incorrect item length |

## Source B — B.5.2 EtherNet/IP Objects Supported by DVP-SE / ES2-E Series PLCs

### (1) Identity Object (0x01)

Instance: 0x01

| Attribute | Name | Access | Data Type | Value | Live? |
|---|---|---|---|---|---|
| 0x01 | Vendor ID | Get | UINT | 799 (Delta Electronics, inc.) | ✅ read on real ES2E |
| 0x02 | Device Type | Get | UINT | 14 (Programmable Logic Controller) | ✅ |
| 0x03 | Product Code | Get | UINT | Product code | ✅ (771 on the real ES2E) |
| 0x04 | Revision | Get | STRUCT of: Major USINT, Minor USINT | Device version, Major.Minor | not individually read |
| 0x05 | Status | Get | WORD | 0 (Owned) | not read |
| 0x06 | Serial Number | Get | UDINT | last 4 digits of the MAC address, ab:cd | not read |
| 0x07 | Product Name | Get | SHORT_STRING | Module Name | not read |
| 0x08 | State | Get | UINT | 0x03 (ES2-E & DVP26SE Only) | not read |

### (2) Message Router (0x02)

Instance: 0x01

| Attribute | Name | Access | Data Type | Value | Live? |
|---|---|---|---|---|---|
| 0x02 | Number Available | Get | UINT | 0 | not read |
| 0x03 | Number Active | Get | UINT | 0 | not read |

### (3) Assembly (0x04) — Explicit message

DVP12SE: Conformance Test is not supported.

**DVP12SE — "D Block" instances:**

| Instance | Attribute | Name | Access | Data Type | Data |
|---|---|---|---|---|---|
| 0x65 | 0x03 | D Block 1 | Set | 10 words | D500~D509 |
| 0x66 | 0x03 | D Block 2 | Set | 30 words | D510~D539 |
| 0x67 | 0x03 | D Block 3 | Set | 60 words | D540~D599 |
| 0x68 | 0x03 | D Block 4 | Set | 100 words | D600~D699 |
| 0x69 | 0x03 | D Block 5 | Set | 100 words | D700~D799 |
| 0x6A | 0x03 | D Block 6 | Set | 100 words | D800~D899 |
| 0x6B | 0x03 | D Block 7 | Set | 100 words | D900~D999 |

**ES2-E & DVP26SE — full connection table:**

| Connection No. | Name | Instance | Data Length | Default |
|---|---|---|---|---|
| Connection 1 | Input | 0x65 | 100 words | D0 ~ D99 |
| Connection 1 | Output | 0x64 | 100 words | D3000 ~ D3099 |
| Connection 1 | Configuration | 0x80 | 8 words | Refer to Config Data below |
| Connection 2 | Input | 0x67 | 100 words | D100 ~ D199 |
| Connection 2 | Output | 0x66 | 100 words | D3100 ~ D3199 |
| Connection 2 | Configuration | 0x81 | 8 words | Refer to Config Data below |
| Connection 3 | Input | 0x69 | 100 words | D200 ~ D299 |
| Connection 3 | Output | 0x68 | 100 words | D3200 ~ D3299 |
| Connection 3 | Configuration | 0x82 | 8 words | Refer to Config Data below |
| Connection 4 | Input | 0x6B | 100 words | D300 ~ D399 |
| Connection 4 | Output | 0x6A | 100 words | D3300 ~ D3399 |
| Connection 4 | Configuration | 0x83 | 8 words | Refer to Config Data below |
| Connection 5 | Input | 0x6D | 100 words | D400 ~ D499 |
| Connection 5 | Output | 0x6C | 100 words | D3400 ~ D3499 |
| Connection 5 | Configuration | 0x84 | 8 words | Refer to Config Data below |
| Connection 6 | Input | 0x6F | 100 words | D500 ~ D599 |
| Connection 6 | Output | 0x6E | 100 words | D3500 ~ D3599 |
| Connection 6 | Configuration | 0x85 | 8 words | Refer to Config Data below |
| Connection 7 | Input | 0x71 | 100 words | D600 ~ D699 |
| Connection 7 | Output | 0x70 | 100 words | D3600 ~ D3699 |
| Connection 7 | Configuration | 0x86 | 8 words | Refer to Config Data below |
| Connection 8 | Input | 0x73 | 100 words | D700 ~ D799 |
| Connection 8 | Output | 0x72 | 100 words | D3700 ~ D3799 |
| Connection 8 | Configuration | 0x87 | 8 words | Refer to Config Data below |

**Live?** Input (T->O) instances 101/103/105/107/109/111/113/115 (decimal
for 0x65/0x67/0x69/0x6B/0x6D/0x6F/0x71/0x73) — ✅ confirmed live, this is
this driver's `readD` mechanism until the 2026-09 correction below. Output
(O->T) instances and the D3000-D3799 range — read/write attempted at the
CIP level (Set_Attribute_Single succeeds) but **never independently
verified** (D3000+ is outside every range this driver can currently read),
so whether it really lands there is unconfirmed either way.

**Config Data** (the 8-word Configuration instance for each connection):

| Parameter | Data Type | Data | Default |
|---|---|---|---|
| Input Device Type | INT | Input (T to O) device type: 0 = D register | 0 |
| Input Device Quantity | INT | Input (T to O) device quantity | 100 |
| Input Device Address | DINT | Input (T to O) device address: 0=D0, 1=D1... | Refer to Connection 1~8 |
| Output Device Type | INT | Output (O to T) device type: 0 = D register | 0 |
| Output Device Quantity | INT | Output (O to T) device quantity | 100 |
| Output Device Address | DINT | Output (O to T) device address: 0=D0, 1=D1... | Refer to Connection 1~8 |

**Live?** Read attempted (Instance 129/0x81 = Connection2's Configuration)
→ `PathDestinationUnknown`, not independently queryable via plain
`Get_Attribute_Single`. Override attempted via a Forward_Open Data
Segment carrying this exact structure with Output Device Address = 100 →
accepted, no observable effect. Unresolved.

### (4) X input

**DVP12SE: (0x64)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | X0 | Get | BYTE |
| 2 | 0x64 | X1 | Get | BYTE |
| ... | ... | ... | ... | ... |
| 256 | 0x64 | X377 | Get | BYTE |

**ES2-E & DVP26SE: (0x350)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | X0 | Get | BOOL | ✅ |
| 1 | 1 | X1 | Get | BOOL | ✅ |
| ... | ... | ... | ... | ... | |
| 1 | 255 | X377 | Get | BOOL | range confirmed via octal-label helper |

### (5) Y output

**DVP12SE: (0x65)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | Y0 | Set | BYTE (0x00 or 0x01) |
| 2 | 0x64 | Y1 | Set | BYTE (0x00 or 0x01) |
| ... | ... | ... | ... | ... |
| 256 | 0x64 | Y377 | Set | BYTE (0x00 or 0x01) |

**ES2-E & DVP26SE: (0x351)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | Y0 | Set | BOOL | ✅ write confirmed via WPLSoft live monitor |
| 1 | 1 | Y1 | Set | BOOL | ✅ |
| ... | ... | ... | ... | ... | |
| 1 | 255 | Y377 | Set | BOOL | |

### (6) T timer

**DVP12SE: (0x66)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | T0 | Set | INT |
| 2 | 0x64 | T1 | Set | INT |
| ... | ... | ... | ... | ... |
| 256 | 0x64 | T255 | Set | INT |

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x65 | T0 | Set | BYTE (0x00 or 0x01) |
| 2 | 0x65 | T1 | Set | BYTE (0x00 or 0x01) |
| ... | ... | ... | ... | ... |
| 256 | 0x65 | T255 | Set | BYTE (0x00 or 0x01) |

**ES2-E & DVP26SE: (0x355)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | T0 Bit | Set | BOOL | ✅ contact write confirmed live |
| 1 | 1 | T1 Bit | Set | BOOL | ✅ |
| ... | ... | ... | ... | ... | |
| 1 | 255 | T255 Bit | Set | BOOL | |

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 2 | 0 | T0 Register | Set | INT | 🔶 implemented 2026-09, not yet live-tested |
| 2 | 1 | T1 Register | Set | INT | 🔶 |
| ... | ... | ... | ... | ... | |
| 2 | 255 | T255 Register | Set | INT | 🔶 |

### (7) M Relay

**DVP12SE: (0x67)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | M0 | Set | BYTE |
| 2 | 0x64 | M1 | Set | BYTE |
| ... | ... | ... | ... | ... |
| 4096 | 0x64 | M4095 | Set | BYTE |

**ES2-E & DVP26SE: (0x353)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | M0 | Set | BOOL | ✅ write confirmed via WPLSoft live monitor |
| 1 | 1 | M1 | Set | BOOL | ✅ |
| ... | ... | ... | ... | ... | |
| 1 | 4095 | M4095 | Set | BOOL | |

### (8) C counter

**DVP12SE: (0x68)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | C0 | Set | INT |
| 2 | 0x64 | C1 | Set | INT |
| ... | ... | ... | ... | ... |
| 200 | 0x64 | C199 | Set | INT |

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 201 | 0x64 | C200 | Set | DINT |
| 202 | 0x64 | C201 | Set | DINT |
| ... | ... | ... | ... | ... |
| 256 | 0x64 | C255 | Set | DINT |

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x65 | C0 | Set | BYTE (0x00 or 0x01) |
| 2 | 0x65 | C1 | Set | BYTE (0x00 or 0x01) |
| ... | ... | ... | ... | ... |
| 256 | 0x65 | C255 | Set | BYTE (0x00 or 0x01) |

**ES2-E: (0x356)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | C0 Bit | Set | BOOL | ✅ contact write confirmed live |
| 1 | 1 | C1 Bit | Set | BOOL | ✅ |
| ... | ... | ... | ... | ... | |
| 1 | 255 | C255 Bit | Set | BOOL | ✅ range-swept live, hard ceiling confirmed at 255 |

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 2 | 0 | C0 Register | Set | INT | 🔶 implemented 2026-09, not yet live-tested |
| 2 | 1 | C1 Register | Set | INT | 🔶 |
| ... | ... | ... | ... | ... | |
| 2 | 199 | C199 Register | Set | INT | 🔶 |
| 2 | 200 | C200 Register | Set | DINT | 🔶 32-bit boundary |
| ... | ... | ... | ... | ... | |
| 2 | 255 | C255 Register | Set | DINT | 🔶 |

### (9) D Register

**DVP12SE: (0x69)**

| Instance | Attribute | Name | Access | Data Type |
|---|---|---|---|---|
| 1 | 0x64 | D0 | Set | INT |
| 2 | 0x64 | D1 | Set | INT |
| ... | ... | ... | ... | ... |
| 12000 | 0x64 | D11999 | Set | INT |

**ES2-E: (0x352)**

| Instance | Attribute | Name | Access | Data Type | Live? |
|---|---|---|---|---|---|
| 1 | 0 | D0 | Set | INT | 🔶 implemented 2026-09 (this driver's PREVIOUS implementation used the wrong formula here — see below), not yet live-tested |
| 1 | 1 | D1 | Set | INT | 🔶 |
| ... | ... | ... | ... | ... | |
| 1 | 9999 | D9999 | Set | INT | 🔶 |

**DVP26SE: (0x352)** — same, Attribute range extends to 0-11999.

**⚠️ Development note:** this driver's `'es2'` profile originally modeled
D's Instance 1 on **Source A's own convention** (a bit-enumeration,
`attribute = wordIndex*16+bitIndex`), because Source B wasn't available
yet when it was written. Under that wrong formula, `attribute 1600`
(from `wordIndex=100, bitIndex=0`) is actually **D1600** under Source B's
real, flat-Attribute scheme above — a genuine, valid, writable register,
just not "bit 0 of D100". Writes made that way never appeared in the
Assembly Input mirror (D0-D799) because D1600 is outside that range, not
because it was an isolated scratch store. Corrected 2026-09 in
`src/delta/device-types/es2.js`, pending live re-confirmation.

### (10) TCP/IP Interface Object (0xF5)

Instance: 0x01

| Attribute | Name | Access | Data Type | Value |
|---|---|---|---|---|
| 0x01 | Status | Get | DWORD | 0x00000001UL |
| 0x02 | Configuration Capability | Get | DWORD | DVP12SE = 0x00000014UL (DHCP client, Configuration Settable); ES2-E & DVP26SE = 0x00000015UL (DHCP client, BOOTP Client, Configuration Settable) |
| 0x03 | Configuration Control | Get | DWORD | Static IP: 0U; BOOTP: 0x01U (ES2-E Only); DHCP: 0x02U |
| 0x04 | Physical Link Object | Get | STRUCT of: Path Size UINT, Path Padded EPATH | |
| 0x05 | Interface Configuration | Set | STRUCT of: IP Address UDINT, Network Mask UDINT, Gateway Address UDINT, Name Server UDINT, Name Server 2 UDINT, Domain Name STRING | |
| 0x06 | Host Name | Get | STRING | DVP12SE or ES2-E |
| 0x0D | Encapsulation Inactivity Timeout | Set | UINT | Keep Alive Timeout, 120s |

### (11) Ethernet Link Object (0xF6)

Instance: 0x01

| Attribute | Name | Access | Data Type | Value |
|---|---|---|---|---|
| 0x01 | Interface Speed | Get | UDINT | 10 or 100 Mbps |
| 0x02 | Interface Flag | Get | UDINT | Bit 0: Link Status; Bit 1: Half/Full Duplex |
| 0x03 | MAC Address | Get | USINT[6] | |
| 0x0A | Interface Label | Get | SHORT_STRING | Define Ethernet port name |
| 0x0B | Interface Capability | Get | STRUCT of: | |

Attribute 0x0B ("Interface Capability") struct fields, verbatim example
values from the manual:

| Field | Data Type | Example Value |
|---|---|---|
| Capability Bits | DWORD | 01 31 00 00 00 07 |
| Speed/Duplex Array Count | USINT | 04 |
| Interface Speed 1 | UINT | 00 0A |
| Interface Duplex Mode 1 | USINT | 00 |
| Interface Speed 2 | UINT | 00 0A |
| Interface Duplex Mode 2 | USINT | 01 |
| Interface Speed 3 | UINT | 00 64 |
| Interface Duplex Mode 3 | USINT | 00 |
| Interface Speed 4 | UINT | 00 64 |
| Interface Duplex Mode 4 | USINT | 01 |

**Live?** Not implemented/read by this driver (Port/TCP-IP/Ethernet Link
objects are generic CIP objects this driver hasn't needed yet for the
Delta-specific work — see main README Phase 3 status).

---

## Source A — DVP-SV3/SX3, DVP-ES3/EX3, AHCPU5x1-EN, AH10EN-5A, AHRTU-ETHN-5A

### 8.1 Object list

| Object Name | Class ID | Available for |
|---|---|---|
| Identity Object | 1 (0x01) | All series |
| Message Router Object | 2 (0x02) | All series |
| Assembly Object | 4 (0x04) | All series |
| Connection Manager Object | 6 (0x06) | All series |
| Device Level Ring Object | 71 (0x47) | AHCPU5X1-EN |
| QoS Object | 72 (0x48) | All series |
| Port Object | 244 (0xF4) | AHCPU5X1-EN |
| TCP/IP Interface Object | 245 (0xF5) | AHCPU560-EN2 |
| Ethernet Link Object | 246 (0xF6) | AHCPU560-EN2 |
| X Register | 848 (0x350) | AH10EN-5A |
| Y Register | 849 (0x351) | |
| D Register | 850 (0x352) | |
| M Register | 851 (0x353) | |
| S Register | 852 (0x354) | AH10EN-5A |
| T Register | 853 (0x355) | AHRTU-ETHN-5A |
| C Register | 854 (0x356) | |
| HC Register | 855 (0x357) | AH10EN-5A |
| SM Register | 856 (0x358) | AHRTU-ETHN-5A |
| SR Register | 857 (0x359) | |
| Control Register | 858 (0x370) | AHRTU-ETHN-5A |
| Status Register | 859 (0x371) | |
| Input Register | 882 (0x372) | |
| Output Register | 883 (0x373) | |
| RTU AI Register | 884 (0x374) | |
| RTU AO Register | 885 (0x375) | |
| RTU DI Register | 886 (0x376) | |
| RTU DO Register | | |

(0x370-0x376 are AHRTU-ETHN-5A remote I/O module registers, not part of
`'sx3'`/`'es2'` scope — not transcribed in full here.)

### 8.3 Identity Object (Class ID: 0x01)

Instance 1:

| Attribute | Name | Access | Data Type | Value |
|---|---|---|---|---|
| 0x01 | Vendor ID | Get | UINT | 0x31F = Delta Electronics, inc. |
| 0x02 | Device Type | Get | UINT | 0x0C Communication Adapter (AH10EN-5A/AHRTU-ETHN-5A) or 0x0E PLC (AHCPU5x1-EN) |
| 0x03 | Product Code | Get | UINT | AH10EN-5A: 0x4000; AHRTU-ETHN-5A: 0x4001; AHCPU511-EN: 0x0101; AHCPU521-EN: 0x0102; AHCPU531-EN: 0x0103 |
| 0x04/0x05 | Revision (Major/Minor) | Get | STRUCT of USINT/USINT | Major 0x01-0x7F, Minor 0x01-0xFF |
| 0x05 | Status | Get | WORD | see Status bit table in the manual |
| 0x06 | Serial Number | Get | UDINT | last 4 hex chars of MAC address |
| 0x07 | Product Name | Get | STRING | e.g. "AH10EN-5A", "AHCPU511-EN" |

**Live?** ✅ Vendor ID (799) and Product Name ("DVP-SX3") read and
cross-checked against Phase 1's ListIdentity, against the real SX3
(README Domain B/F).

### 8.5 Assembly Object (Class ID: 0x04)

**8.5.1 AHCPU5x1-EN and AH10EN-5A** — this is the instance numbering
`'sx3'`/`'es2'` both use for their Connection tables:

Class Attribute 0x01 Revision = 0x2; 0x02 Max Instance = 0xC7 (199).

Instance numbers: 0x00 Class Attribute; 0x64/0x66/.../0x72 = I/O
Connection Output 1-8; 0x65/0x67/.../0x73 = I/O Connection Input 1-8;
0x74-0x7A Reserved; 0x80-0x87 = Configuration 1-8.

Instance Attributes (for Instance 0x64-0x87): 0x03 Data (ARRAY of BYTE,
Get/Set), 0x04 Size (UINT, Get).

| Connection No. | Function | Instance | Length |
|---|---|---|---|
| Connection 1 | Output | 0x64 | 100 words |
| Connection 1 | Input | 0x65 | 100 words |
| Connection 1 | Configuration | 0x80 | 6 words |
| Connection 2 | Output | 0x66 | 100 words |
| Connection 2 | Input | 0x67 | 100 words |
| Connection 2 | Configuration | 0x81 | 6 words |
| Connection 3 | Output | 0x68 | 100 words |
| Connection 3 | Input | 0x69 | 100 words |
| Connection 3 | Configuration | 0x82 | 6 words |
| Connection 4 | Output | 0x6A | 100 words |
| Connection 4 | Input | 0x6B | 100 words |
| Connection 4 | Configuration | 0x83 | 6 words |
| Connection 5 | Output | 0x6C | 100 words |
| Connection 5 | Input | 0x6D | 100 words |
| Connection 5 | Configuration | 0x84 | 6 words |
| Connection 6 | Output | 0x6E | 100 words |
| Connection 6 | Input | 0x6F | 100 words |
| Connection 6 | Configuration | 0x85 | 6 words |
| Connection 7 | Output | 0x70 | 100 words |
| Connection 7 | Input | 0x71 | 100 words |
| Connection 7 | Configuration | 0x86 | 6 words |
| Connection 8 | Output | 0x72 | 100 words |
| Connection 8 | Input | 0x73 | 100 words |
| Connection 8 | Configuration | 0x87 | 6 words |

**Live?** ✅ Connection1 (Instance 0x80/0x64/0x65) Forward_Open, explicit
Get/Set_Attribute_Single, and cyclic UDP I/O all confirmed against the
real SX3 (README Domain G/H).

**8.5.2 AHRTU-ETHN-5A** — a different, fixed instance set (0x64 Owner
Output, 0x65 Owner Input/Listen-only Input, 0x80 Owner Configuration,
0xC7 Listen-only Output) — not used by `'sx3'`/`'es2'`, included for
completeness only.

### 8.12 Vendor Specific Objects — full Instance/Attribute tables

Already implemented in
[src/delta/registers.js](../src/delta/registers.js).

| Class | Register | Instance 1 (bit) | Instance 2 (word) | Live? |
|---|---|---|---|---|
| 0x350 | X | Attr = `wordIndex*16+bitIndex` (X0.0=0 ... XMax.15=max), Get, BOOL | Attr = word index directly, Get, INT | ✅ read (word mode) |
| 0x351 | Y | same bit-enumeration, Get, BOOL | Attr = word index, Get, INT | ✅ read/write (word mode) |
| 0x352 | D | Attr = `wordIndex*16+bitIndex` (D0.0=0 ... D4096.15), Get, INT | Attr = D number directly (D0-D65535, device-dependent max), Get, INT | ✅ read/write (word mode), incl. round-trip write |
| 0x353 | M | Attr = M number directly, Get, BOOL | — (bit-only) | ✅ read/write |
| 0x354 | S | Attr = S number directly, Get, BOOL | — (bit-only) | ✅ read/write |
| 0x355 | T | Attr = T number directly (T0-T510), Get, BOOL | Attr = T number directly, Get, INT | ✅ word mode (current value) read/write |
| 0x356 | C | Attr = C number directly (C0-C510), Get, BOOL | Attr = C number directly, Get, INT | ✅ word mode read/write |
| 0x357 | HC | Attr = HC number directly (HC0-HC254), Get, BOOL | Attr = HC number directly, Get, DINT (32-bit) | ✅ word mode read/write, full round-trip |
| 0x358 | SM | Attr = SM number directly (SM0-SM4094), Get, BOOL | — (bit-only) | ✅ read |
| 0x359 | SR | (word-only) | Instance documented as **1** for this word-only type, Get, INT | ✅ read |

Every "Get" above is what the manual's own per-attribute tables print;
`Set_Attribute_Single` (service 0x10) is separately confirmed supported
in each object's own Service Code table and live-validated by this
driver's round-trip write tests
(`test/sx3-full-roundtrip_spec.js`, `examples/delta-sx3-full-roundtrip.js`)
— 153/157 of this project's test suite passing, including full write
coverage for every register type and range boundary.

## Key difference between the two sources (why `'es2'` needed correcting)

| | Source A (SX3/ES3/AH-series) | Source B (SE/SE2/26SE/ES2-E) |
|---|---|---|
| D word access | Instance 2, Attribute = D number | **Instance 1** (no Instance 2 at all), Attribute = D number |
| D bit access | Instance 1, Attribute = `wordIndex*16+bitIndex` | not documented / not applicable — D has no separate bit mode |
| T/C numeric value | Instance 2, Attribute = number | Instance 2, Attribute = number (same — this part was previously, incorrectly, assumed absent on ES2-E) |
| T/C contact | Instance 1, Attribute = number | Instance 1, Attribute = number (same) |
| 32-bit counter | separate HC class (0x357) | inside C's own Instance 2, Attribute 200+, as DINT |

Confusing the two conventions on the same-looking Class ID 0x352 is
exactly what happened in this project's original `'es2'` implementation:
it borrowed Source A's bit-enumeration formula for D's Instance 1, which
produces syntactically valid, successfully-writable requests — just to
the wrong register number under Source B's real, flat-Attribute scheme.
