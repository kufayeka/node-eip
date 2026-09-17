Bisa babe. Tapi ada satu hal penting: draft kamu sekarang **mencampur “EtherNet/IP compliance” dengan “Rockwell Logix tag driver features”**. Kalau targetnya benar-benar **ODVA Conformance**, sebaiknya checklist-nya dibikin jauh lebih dalam dan dipisah antara **EtherNet/IP Encapsulation, CIP, Connection Management, I/O, Object Model, Data Types, Routing, Diagnostics, dan vendor-specific Logix services**.

Aku lengkapi jadi semacam **master compliance checklist**:

---

# EtherNet/IP (EIP) Fully-Compliant Driver — Comprehensive Compliance Checklist

Untuk membuat driver **EtherNet/IP (EIP)** yang sepenuhnya patuh terhadap spesifikasi **ODVA EtherNet/IP + CIP**, implementasi tidak cukup hanya mampu membaca/menulis tag PLC. Driver harus mampu menangani struktur protokol, object model, connection lifecycle, routing, explicit messaging, implicit I/O messaging, error handling, serta berbagai edge case yang diuji dalam **ODVA Conformance Testing**.

> **Catatan:** beberapa fitur seperti `Read Tag (0x4C)`, `Write Tag (0x4D)`, Symbol Object `0x6B`, dan Template Object `0x6C` merupakan **CIP extensions/vendor-specific yang terutama terkait ControlLogix/CompactLogix**, bukan requirement universal untuk setiap EtherNet/IP device.

---

## 1. EtherNet/IP Encapsulation Layer

### 1.1 Encapsulation Header

Implementasi harus mampu encode/decode **24-byte Encapsulation Header**:

```text
Offset  Size
0       2       Command
2       2       Length
4       4       Session Handle
8       4       Status
12      8       Sender Context
20      4       Options
```

Driver harus:

* Validate command code
* Validate payload length
* Validate Session Handle
* Validate Status
* Preserve Sender Context
* Validate Options
* Reject malformed packet
* Handle zero-length payload
* Handle unexpected session handles
* Handle packet fragmentation at TCP level

### 1.2 Encapsulation Commands

Minimal implementasi:

| Command             |     Code | Purpose                                |
| ------------------- | -------: | -------------------------------------- |
| `ListServices`      | `0x0004` | Query supported encapsulation services |
| `ListIdentity`      | `0x0063` | Device discovery                       |
| `ListInterfaces`    | `0x0064` | Interface discovery                    |
| `RegisterSession`   | `0x0065` | Establish session                      |
| `UnregisterSession` | `0x0066` | Terminate session                      |
| `SendRRData`        | `0x006F` | Unconnected explicit messaging         |
| `SendUnitData`      | `0x0070` | Connected messaging                    |
| `NOP`               | `0x0000` | No operation                           |

Driver juga harus gracefully menangani **unknown/unsupported encapsulation commands**.

---

# 2. Session Management

### 2.1 Register Session

Driver harus:

* Mengirim `RegisterSession`
* Menentukan protocol version
* Menentukan options
* Parse returned Session Handle
* Menyimpan session state
* Reject invalid registration response

State machine misalnya:

```text
DISCONNECTED
     ↓
CONNECTING
     ↓
REGISTERING
     ↓
REGISTERED
     ↓
ACTIVE
     ↓
UNREGISTERING
     ↓
DISCONNECTED
```

### 2.2 Session Lifecycle

Harus menangani:

* TCP connection lost
* Session timeout
* Remote device restart
* Session invalidation
* Reconnect
* Duplicate connection
* Graceful disconnect
* Unexpected disconnect
* Session handle reuse

### 2.3 Thread Safety

Jika driver concurrent:

```text
Session
 ├── TCP connection
 ├── Request queue
 ├── Response dispatcher
 ├── Connection manager
 └── Timeout manager
```

harus thread-safe.

Jangan sampai dua thread secara tidak sengaja:

```text
RegisterSession
RegisterSession
```

pada socket/session yang sama.

---

# 3. SendRRData / Unconnected Explicit Messaging

`SendRRData (0x006F)` digunakan untuk explicit messaging yang tidak menggunakan CIP connection.

Driver harus mendukung:

```text
Encapsulation
   ↓
SendRRData
   ↓
Common Packet Format (CPF)
   ↓
CIP Message
```

### 3.1 CPF

Harus mampu parse:

* Item Count
* Null Address Item
* Unconnected Data Item
* Connected Address Item jika applicable
* Connected Data Item
* Unknown CPF items

Typical:

```text
CPF
 ├── Item Count
 ├── Null Address Item
 └── Unconnected Data Item
       └── CIP Request
```

---

# 4. SendUnitData / Connected Messaging

`SendUnitData (0x0070)` digunakan untuk connected messaging.

Driver harus:

* Parse Connection ID
* Parse CPF
* Parse connected data
* Handle sequence numbers
* Associate packet dengan connection instance
* Detect stale connection
* Handle connection timeout

Architecture:

```text
SendUnitData
      ↓
CPF
      ↓
Connected Address
      ↓
Connection ID
      ↓
Connected Data
      ↓
CIP
```

---

# 5. Common Packet Format (CPF)

CPF adalah bagian penting dari EtherNet/IP.

Driver harus memiliki generic CPF encoder/decoder.

Contoh abstraction:

```text
CPF
 ├── Item[]
 │    ├── Type ID
 │    ├── Length
 │    └── Data
```

Harus mendukung:

* Null Address
* Connected Address
* Unconnected Data
* Connected Data
* Sequenced Address
* Vendor-specific/unknown item types

Dan:

* Validate item length
* Validate item count
* Reject malformed CPF
* Handle unknown item types gracefully

---

# 6. CIP Message Layer

Generic CIP request:

```text
Service
Request Path Size
Request Path
Request Data
```

Response:

```text
Service | 0x80
Reserved
General Status
Additional Status Size
Additional Status
Response Data
```

Driver harus membedakan:

```text
Success
Partial Success
Error
Extended Error
```

---

# 7. CIP Service Framework

Jangan hardcode service tertentu.

Buat generic API:

```javascript
cip.request({
    service,
    path,
    data
});
```

Sehingga dapat digunakan untuk:

```text
Get_Attribute_All
Get_Attribute_Single
Set_Attribute_Single
Reset
Create
Delete
Forward_Open
Forward_Close
Multiple_Service_Packet
Read_Tag
Write_Tag
```

### Standard Services

Implementasi umum:

| Service                 |   Code |
| ----------------------- | -----: |
| Get Attributes All      | `0x01` |
| Set Attribute All       | `0x02` |
| Get Attribute Single    | `0x0E` |
| Set Attribute Single    | `0x10` |
| Reset                   | `0x05` |
| Create                  | `0x08` |
| Delete                  | `0x09` |
| Multiple Service Packet | `0x0A` |

---

# 8. CIP Object Model

Generic object addressing:

```text
Class
Instance
Attribute
```

Driver harus mempunyai generic path builder:

```javascript
CIPPath.class(0x01)
    .instance(1)
    .attribute(7)
```

atau:

```text
20 01
24 01
30 07
```

tergantung segment encoding.

---

# 9. Standard CIP Objects

Minimal architecture harus mampu berinteraksi dengan standard objects.

### Identity Object — `0x01`

Attributes:

```text
Vendor ID
Device Type
Product Code
Revision
Status
Serial Number
Product Name
State
Configuration Consistency Value
```

Services:

```text
GetAttributeSingle
GetAttributesAll
Reset
```

---

### Message Router — `0x02`

Digunakan untuk routing CIP request.

Driver harus memahami:

```text
Application
   ↓
Message Router
   ↓
Object
```

---

### Connection Manager — `0x06`

Harus mendukung lifecycle:

```text
Forward_Open
Large_Forward_Open
Forward_Close
```

dan memahami:

* Connection Serial Number
* Vendor ID
* Originator Serial Number
* Connection ID
* Connection path
* O→T parameters
* T→O parameters
* RPI
* Transport Type
* Trigger
* Connection timeout multiplier

---

# 10. TCP/IP Interface Object — `0xF5`

Harus mampu membaca atribut:

```text
Status
Configuration Capability
Configuration Control
Physical Link Object
Interface Configuration
Hostname
```

Interface configuration dapat mencakup:

```text
IP Address
Network Mask
Gateway
Name Server
Name Server 2
Domain Name
```

Untuk perangkat yang mengizinkan konfigurasi, `SetAttributeSingle` juga harus ditangani dengan benar.

---

# 11. Ethernet Link Object — `0xF6`

Driver harus mampu membaca:

```text
Interface Flags
Physical Link Object
Interface Counters
Media Counters
Interface Control
```

Termasuk informasi seperti:

```text
Link Status
Speed
Duplex
CRC errors
Alignment errors
FCS errors
Late collisions
Carrier Sense errors
```

Tidak semua device expose seluruh attribute dengan cara yang sama, sehingga driver harus menangani:

```text
Attribute not supported
Attribute optional
Attribute unavailable
```

---

# 12. Connection Manager

Ini bagian yang sering dilewatkan driver sederhana.

### Forward Open

Driver harus dapat membangun:

```text
Priority/Time Tick
Timeout Ticks
O->T Network Connection ID
T->O Network Connection ID
Connection Serial Number
Originator Vendor ID
Originator Serial Number
Connection Timeout Multiplier
O->T RPI
O->T Parameters
T->O RPI
T->O Parameters
Transport Type / Trigger
Connection Path
```

### Large Forward Open

Untuk connection dengan parameter/data yang membutuhkan format extended.

### Forward Close

Harus mengirim:

```text
Connection Serial Number
Originator Vendor ID
Originator Serial Number
Connection Path
```

dan menangani response/error.

---

# 13. CIP Connection Lifecycle

Driver sebaiknya memiliki explicit state:

```text
NEW
 ↓
OPENING
 ↓
ESTABLISHED
 ↓
RUNNING
 ↓
TIMED_OUT
 ↓
CLOSING
 ↓
CLOSED
```

Harus mendeteksi:

* Connection timeout
* Connection refused
* Connection ownership conflict
* Connection path failure
* Invalid connection parameters
* Device restart
* Network interruption

---

# 14. Real-Time I/O — UDP/2222

Untuk Class 1 I/O:

```text
EtherNet/IP
      ↓
UDP
      ↓
Port 2222
      ↓
CIP I/O
```

Driver harus mendukung bila bertindak sebagai Scanner/Originator:

```text
Forward_Open
      ↓
Connection established
      ↓
UDP I/O packets
      ↓
Sequence validation
      ↓
Application callback
```

---

# 15. I/O Connection Types

Support:

* Point-to-point
* Multicast
* Unicast
* Cyclic
* Change-of-State
* Application-triggered

Tergantung device/profile yang digunakan.

---

# 16. RPI

RPI harus diperlakukan sebagai parameter connection, bukan sekadar `setInterval()`.

Misalnya:

```text
RPI = 10 ms
```

berarti connection meminta packet interval tertentu dari device.

Driver harus menangani:

* Minimum RPI
* Requested RPI
* Actual RPI
* RPI rejection
* RPI modification
* Timeout based on RPI

---

# 17. Sequence Number

Untuk Class 1 connection, implementasikan sequence tracking.

Contoh:

```text
100
101
102
104
```

Driver harus dapat mendeteksi:

```text
103 missing
```

dan membedakan:

```text
packet lost
packet duplicated
packet reordered
```

---

# 18. Multicast Handling

Jika adapter menggunakan multicast:

Driver harus menangani:

* Multicast IP
* UDP socket binding
* Interface selection
* IGMP membership
* Multicast join
* Multicast leave
* Multiple multicast connections

Pada Linux misalnya perlu memperhatikan:

```text
SO_REUSEADDR
IP_ADD_MEMBERSHIP
IP_MULTICAST_IF
```

---

# 19. CIP Routing

Driver harus mendukung routing path:

```text
PC
 ↓
Ethernet
 ↓
PLC
 ↓
Backplane
 ↓
Module
```

Contoh:

```text
Ethernet Port 2
   ↓
Backplane Port 1
   ↓
Slot 3
```

Generic route:

```text
Port Segment
Port Segment
Port Segment
...
```

---

# 20. Port Segment

Harus mendukung:

* Port number
* Link address
* Extended link address
* Logical link addressing
* Backplane routing

Format dapat menggunakan:

```text
Port Segment
```

dengan short maupun extended link address.

---

# 21. Logical Segments

Support:

```text
Class
Instance
Attribute
Member
Connection Point
Extended Logical
```

Encoding harus benar untuk:

```text
8-bit
16-bit
32-bit
```

logical values.

---

# 22. Symbolic Segment

Untuk Logix-style symbolic addressing:

```text
MyTag
MyArray[10]
Motor.Speed
Program:MainProgram.MyTag
```

harus dapat encode symbolic path:

```text
0x91
Length
ASCII bytes
Padding
```

Jika panjang string ganjil, alignment/padding harus benar.

---

# 23. Array Indexing

Driver harus mampu menangani:

```text
MyArray[0]
MyArray[1]
MyArray[100]
```

dan nested structures:

```text
Motor[2].Status.Speed
```

serta multidimensional array jika didukung target:

```text
Array[2,3]
```

---

# 24. Logix Tag Services

Untuk Rockwell Logix family, tambahkan layer vendor/application-specific:

### Read Tag

```text
0x4C
```

### Write Tag

```text
0x4D
```

### Read Tag Fragmented

```text
0x52
```

### Write Tag Fragmented

```text
0x53
```

Driver harus menangani:

* Single element
* Array
* Structure
* UDT
* Fragmented transfer
* Offset
* Element count
* Byte count

---

# 25. Multiple Service Packet

`0x0A`

Harus mendukung:

```text
Request:
 ├── Request 1
 ├── Request 2
 ├── Request 3
 └── Request 4
```

dan response:

```text
Response 1
Response 2
Response 3
Response 4
```

Penting untuk:

* Calculate offsets
* Align embedded requests
* Parse individual status
* Handle partial failures

---

# 26. Logix Symbol Object — `0x6B`

Untuk target Logix:

Driver dapat melakukan symbolic discovery:

```text
Class 0x6B
    ↓
Instances
    ↓
Symbol attributes
    ↓
Tag database
```

Informasi:

```text
Tag Name
Type
Instance
Scope
Array information
Structure information
```

---

# 27. Template Object — `0x6C`

Untuk UDT/structure:

```text
Template
   ↓
Members
   ↓
Data Type
   ↓
Offset
   ↓
Size
```

Driver harus mampu:

* Read template definition
* Parse member descriptors
* Resolve nested UDT
* Resolve arrays
* Calculate offsets
* Cache templates

---

# 28. Data Type System

Sebaiknya implementasikan type system internal:

```text
BOOL
SINT
INT
DINT
LINT
USINT
UINT
UDINT
ULINT
REAL
LREAL
BYTE
WORD
DWORD
LWORD
STRING
STRUCT
ARRAY
UDT
```

dengan metadata:

```text
type
size
alignment
signed
elementType
elementCount
members
offset
```

---

# 29. Endianness

Driver harus secara eksplisit menangani byte ordering.

Contoh:

```text
DINT
REAL
LREAL
```

dan jangan bergantung pada native CPU endian.

Gunakan:

```text
readInt16LE()
readInt32LE()
readFloatLE()
readDoubleLE()
```

atau equivalent abstraction.

---

# 30. BOOL / Bit-Level Access

Untuk packed boolean structures:

```text
Byte
 76543210
 ||||||||
 |||||||└ Bit 0
 ||||||└─ Bit 1
 ...
```

driver harus dapat resolve:

```text
MyStructure.Enable
```

ke:

```text
byte offset
+
bit offset
+
mask
```

---

# 31. String Handling

Logix `STRING` bukan sekadar:

```text
[length][ASCII]
```

karena struktur string dapat memiliki metadata/format tertentu.

Driver harus mempunyai type decoder khusus:

```text
Logix STRING
```

dan bukan menganggap semua CIP string sebagai satu format universal.

---

# 32. UDT Decoder

Idealnya architecture:

```text
Template Cache
      ↓
UDT Definition
      ↓
Decoder
      ↓
JavaScript/Object representation
```

Contoh:

```javascript
{
    Speed: 120.5,
    Running: true,
    Alarm: false
}
```

dengan metadata internal:

```text
Speed   offset=0
Running offset=4 bit=0
Alarm   offset=4 bit=1
```

---

# 33. Fragmentation

Driver harus mempunyai generic fragmentation engine.

```text
Request
   ↓
Fragment 0
   ↓
Fragment 1
   ↓
Fragment 2
   ↓
...
   ↓
Complete buffer
```

Harus menangani:

* Fragment offset
* Remaining bytes
* Maximum payload
* Device-specific limits
* Timeout
* Fragment failure
* Retry

---

# 34. CIP Error Handling

Response harus dipisahkan menjadi:

```text
General Status
Additional Status
```

Jangan hanya:

```javascript
if (status !== 0) throw Error();
```

Contoh struktur:

```javascript
{
    success: false,
    generalStatus: 0x04,
    additionalStatus: [...],
    message: "..."
}
```

---

# 35. General Status Codes

Implementasi decoder setidaknya harus memahami:

```text
0x00 Success
0x01 Connection failure
0x02 Resource unavailable
0x03 Invalid parameter value
0x04 Path segment error
0x05 Path destination unknown
0x06 Partial transfer
0x07 Connection lost
0x08 Service not supported
0x09 Invalid attribute value
0x0A Attribute list error
0x0B Already in requested mode/state
0x0C Object state conflict
0x0D Object already exists
0x0E Attribute not settable
0x0F Privilege violation
0x10 Device state conflict
0x11 Reply data too large
0x12 Fragmentation of a primitive value
0x13 Not enough data
0x14 Attribute not supported
0x15 Too much data
0x16 Object does not exist
0x20 Invalid parameter
0x26 Path size invalid
```

**Catatan:** jangan mengasumsikan satu status selalu berarti satu penyebab spesifik; `Additional Status` sering diperlukan untuk diagnosis.

---

# 36. Additional Status

Driver harus expose raw additional status.

Contoh:

```javascript
{
    generalStatus: 0x04,
    additionalStatus: [
        0x1234,
        0x5678
    ]
}
```

Jangan dibuang.

Karena vendor/device tertentu menggunakan additional status untuk informasi diagnosis yang penting.

---

# 37. Timeout Management

Setiap request harus memiliki timeout sendiri:

```text
TCP Connect Timeout
Session Timeout
CIP Request Timeout
Forward Open Timeout
I/O Connection Timeout
Fragment Timeout
Reconnect Timeout
```

Jangan hanya memakai satu global timeout.

---

# 38. Retry Policy

Harus membedakan:

```text
retryable
non-retryable
```

Contoh retryable:

```text
TCP reset
temporary network failure
connection timeout
```

Tidak selalu retryable:

```text
Invalid attribute
Path error
Invalid service
Invalid parameter
```

---

# 39. TCP Stream Handling

**TCP bukan packet protocol.**

Driver tidak boleh berasumsi:

```text
socket.on("data")
= 1 EtherNet/IP packet
```

Harus menggunakan framing:

```text
TCP stream
 ↓
24-byte header
 ↓
Length
 ↓
payload
```

dan mampu menangani:

```text
packet split:

[data 1]
[data 2]

atau

[data1 + data2 + data3]
```

dalam satu TCP read.

Ini salah satu bagian paling penting untuk robustness.

---

# 40. Concurrency

Driver production-grade harus mampu:

```text
Request A
Request B
Request C
Request D
```

secara concurrent.

Harus tersedia:

```text
Request ID / correlation
Pending request map
Timeout
Response dispatcher
```

misalnya:

```javascript
pendingRequests.set(id, promise);
```

Jangan bergantung pada:

```text
request → wait → response → request
```

secara global.

---

# 41. Request Queue / Backpressure

Jika user melakukan:

```javascript
Promise.all(
    Array.from({length: 10000}, ...)
)
```

driver tidak boleh langsung membuka 10.000 request tanpa kontrol.

Sediakan:

```text
maxInFlight
queue
backpressure
rate limiting
```

Contoh:

```text
maxInFlight = 32
```

---

# 42. Connection Pooling

Jika diperlukan:

```text
PLC
 ├── Session 1
 ├── Connection Class 1
 └── Connection Class 3
```

harus ada lifecycle management yang jelas.

Untuk satu PLC, jangan membuat session baru untuk setiap:

```javascript
readTag()
```

Idealnya:

```text
connect()
   ↓
persistent session
   ↓
read/write
   ↓
disconnect()
```

---

# 43. Discovery

Implementasikan:

```text
ListIdentity
```

untuk discovery.

Output ideal:

```javascript
{
    vendorId,
    deviceType,
    productCode,
    revision,
    status,
    serialNumber,
    productName,
    socketAddress
}
```

---

# 44. Device Identity Cache

Setelah discovery:

```text
Device
 ├── Vendor
 ├── Product
 ├── Revision
 ├── Serial
 └── Capabilities
```

dapat di-cache.

Tapi capability discovery tidak boleh dianggap universal karena device profile berbeda.

---

# 45. Device Capability Detection

Driver sebaiknya bisa menentukan:

```text
Supports Explicit Messaging
Supports Class 1
Supports Class 3
Supports Large Forward Open
Supports Multiple Service Packet
Supports Fragmentation
Supports Symbolic Addressing
Supports Unconnected Send
```

sebelum memilih mekanisme komunikasi.

---

# 46. Generic CIP Path Builder

Ini sebaiknya menjadi subsystem tersendiri:

```text
CIPPath
 ├── Port
 ├── Class
 ├── Instance
 ├── Attribute
 ├── Member
 ├── Symbol
 ├── ConnectionPoint
 └── Data
```

Contoh:

```javascript
new CIPPath()
    .class(0x6B)
    .instance(123)
    .attribute(1);
```

---

# 47. Generic Binary Codec

Jangan campur protocol logic dengan binary parsing.

Buat layer:

```text
ByteReader
ByteWriter
```

support:

```text
UInt8
UInt16
UInt32
UInt64
Int8
Int16
Int32
Int64
Float32
Float64
Bytes
String
```

plus:

```text
align()
slice()
remaining()
```

Ini sangat membantu untuk menghindari bug protocol.

---

# 48. Packet Validation

Setiap layer harus punya validation.

```text
TCP
 ↓
Encapsulation validation
 ↓
CPF validation
 ↓
CIP validation
 ↓
Object/path validation
 ↓
Application decoding
```

Malformed packet harus tidak menyebabkan:

```text
crash
memory corruption
infinite loop
buffer over-read
```

---

# 49. Security / Robustness

Walaupun EtherNet/IP tradisional bukan protocol yang dirancang sebagai secure-by-default protocol, driver modern harus memperhatikan:

* Malformed packet
* Oversized packet
* Invalid length
* Integer overflow
* Buffer overflow
* Resource exhaustion
* Connection flooding
* Request flooding
* Unexpected session
* Invalid CPF item
* Invalid CIP path

Jangan pernah trust:

```text
Length
Count
Offset
Array Size
Fragment Size
```

yang datang dari network.

---

# 50. Logging & Diagnostics

Idealnya tersedia beberapa level:

```text
ERROR
WARN
INFO
DEBUG
TRACE
PACKET
```

Contoh TRACE:

```text
TX:
RegisterSession

RX:
RegisterSession Response

TX:
SendRRData
CIP ReadTag MyTag

RX:
CIP Response
Status=0x00
```

Dan raw packet dump:

```text
TX 65 00 ...
RX 65 00 ...
```

---

# 51. Wireshark Compatibility

Untuk development/conformance debugging, packet hasil driver harus dapat dianalisis menggunakan Wireshark EtherNet/IP/CIP dissector.

Test:

```text
Driver
   ↕
Wireshark
   ↕
Reference PLC
```

Bandingkan:

```text
reference packet
vs
your packet
```

byte-by-byte.

---

# 52. Protocol Test Suite

Buat automated test:

```text
Encapsulation Tests
CIP Tests
CPF Tests
Path Tests
Connection Tests
I/O Tests
Error Tests
Fragmentation Tests
Concurrency Tests
Reconnect Tests
```

Contoh:

```text
RegisterSession
✓ valid response
✓ invalid response
✓ malformed length
✓ timeout
✓ connection reset
```

---

# 53. Interoperability Testing

Jangan hanya test dengan satu PLC.

Test berbagai vendor/profile jika targetnya generic EIP:

```text
Rockwell
Schneider
Omron
Mitsubishi
Keyence
Turck
Phoenix Contact
WAGO
Beckhoff
SICK
etc.
```

Karena:

> **EtherNet/IP compliance ≠ “bisa komunikasi dengan satu Rockwell PLC”.**

---

# 54. Rockwell-Specific Compatibility Layer

Kalau target utama kamu adalah Rockwell Logix, sebaiknya arsitekturnya:

```text
┌─────────────────────────────┐
│        User API             │
├─────────────────────────────┤
│     Logix Driver Layer      │
│ ReadTag / WriteTag / UDT    │
├─────────────────────────────┤
│      CIP Service Layer      │
├─────────────────────────────┤
│       CIP Object Model      │
├─────────────────────────────┤
│        CPF Layer            │
├─────────────────────────────┤
│    EtherNet/IP Encapsulation│
├─────────────────────────────┤
│          TCP / UDP          │
└─────────────────────────────┘
```

Dengan begitu kamu bisa punya:

```text
EtherNet/IP Core
```

yang generic, lalu:

```text
Rockwell Logix Extension
```

yang menangani:

```text
0x4C
0x4D
0x52
0x53
0x6B
0x6C
UDT
Symbol browsing
Template parsing
```

---

# 55. Conformance-Oriented Final Checklist

Kalau mau dibuat **super ringkas sebagai checklist implementasi**, struktur besarnya menjadi:

```text
[ ] TCP 44818
[ ] UDP 44818
[ ] UDP 2222

[ ] Encapsulation Header
[ ] RegisterSession
[ ] UnregisterSession
[ ] SendRRData
[ ] SendUnitData
[ ] ListIdentity
[ ] ListInterfaces
[ ] ListServices
[ ] NOP

[ ] CPF
[ ] CIP Request
[ ] CIP Response
[ ] General Status
[ ] Additional Status

[ ] Object Model
[ ] Identity Object
[ ] Message Router
[ ] Connection Manager
[ ] TCP/IP Interface
[ ] Ethernet Link

[ ] GetAttributeSingle
[ ] SetAttributeSingle
[ ] GetAttributesAll
[ ] SetAttributesAll
[ ] Reset
[ ] Multiple Service Packet

[ ] ForwardOpen
[ ] LargeForwardOpen
[ ] ForwardClose

[ ] Connection IDs
[ ] Connection Serial
[ ] Originator Vendor ID
[ ] Originator Serial
[ ] RPI
[ ] Timeout Multiplier
[ ] Connection Path

[ ] Class 1
[ ] Class 3
[ ] Unicast
[ ] Multicast
[ ] Cyclic
[ ] CoS
[ ] Sequence Counter
[ ] I/O Timeout
[ ] IGMP

[ ] Port Segment
[ ] Logical Segment
[ ] Symbolic Segment
[ ] Data Segment
[ ] Extended Segment
[ ] Multi-hop Routing

[ ] BOOL
[ ] SINT
[ ] INT
[ ] DINT
[ ] LINT
[ ] USINT
[ ] UINT
[ ] UDINT
[ ] ULINT
[ ] REAL
[ ] LREAL
[ ] STRING
[ ] ARRAY
[ ] STRUCT

[ ] Fragmentation
[ ] Partial Transfer
[ ] Large Data

[ ] TCP stream reassembly
[ ] Concurrent requests
[ ] Request correlation
[ ] Timeout
[ ] Retry
[ ] Reconnect
[ ] Backpressure
[ ] Resource limits

[ ] Malformed packet handling
[ ] Invalid path handling
[ ] Invalid service handling
[ ] Invalid length handling
[ ] Additional status handling

[ ] Packet logging
[ ] Wireshark verification
[ ] Automated conformance tests
[ ] Interoperability tests
[ ] Long-running stability tests

--- Rockwell Extension ---

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

### Yang paling penting buat project kamu

Kalau ini untuk **driver JavaScript/Node/Electron/Nexa** yang sedang kamu bangun, aku justru akan memprioritaskan implementasinya seperti ini:

```text
PHASE 1
TCP
 └── Encapsulation
      ├── RegisterSession
      ├── SendRRData
      └── CPF

PHASE 2
CIP
 ├── Path Builder
 ├── Generic Request
 ├── Generic Response
 ├── Status Decoder
 └── Object Model

PHASE 3
Rockwell Logix
 ├── ReadTag
 ├── WriteTag
 ├── Fragmentation
 ├── MRP
 ├── Symbol
 └── Template

PHASE 4
Connection Manager
 ├── ForwardOpen
 ├── ForwardClose
 └── Class 3

PHASE 5
Class 1 I/O
 ├── UDP 2222
 ├── Unicast
 ├── Multicast
 ├── RPI
 └── Sequence

PHASE 6
Production Hardening
 ├── concurrency
 ├── timeout
 ├── reconnect
 ├── backpressure
 ├── fuzz testing
 └── Wireshark validation
```

Dan satu koreksi penting dari draft awalmu: **`0x01 = Connection failure`, `0x04 = Path segment error`, dst. jangan dianggap sebagai daftar “error EIP” sederhana.** Itu adalah **CIP General Status**, dan maknanya bergantung pada service/context; untuk diagnosis yang benar kamu perlu parse **Additional Status** juga.

Kalau target akhirnya benar-benar **“driver EIP yang bisa dipakai sebagai library industrial-grade”**, struktur di atas jauh lebih aman daripada membuat `readD()`, `writeY()`, dll langsung di atas socket. `readD()`/`writeY()` sebaiknya cuma menjadi **device-specific API layer** di atas generic EIP/CIP engine.
