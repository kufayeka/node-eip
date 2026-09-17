# EtherNet/IP (EIP) Examples & Compliance Test Catalog

This directory contains runnable, standalone examples demonstrating compliance with the **ODVA EtherNet/IP & CIP Specifications**. All client scripts default to the live Delta DVP-SX3 PLC at `192.168.68.250`, but accept any custom host or port as command-line arguments.

---

## ODVA Compliance Mapping

| Example File | ODVA / CIP Reference | Description |
|---|---|---|
| [`list-services.js`](./list-services.js) | **Vol 2 §1.2** Encapsulation `0x0004` | Queries supported encapsulation services (TCP/UDP capability flags & service name) without establishing a session. |
| [`probe-device.js`](./probe-device.js) | **Vol 2 §1.2** Encapsulation `0x0063`, `0x0065` | Performs TCP `ListIdentity` discovery followed by a clean `RegisterSession`/`UnregisterSession` handshake. |
| [`scan-network.js`](./scan-network.js) | **Vol 2 §1.2, §43** Broadcast Discovery | Sends UDP broadcast `ListIdentity` on port 44818 to discover all EtherNet/IP devices on the subnet. |
| [`read-network-objects.js`](./read-network-objects.js) | **Vol 2 §10 & §11** Standard Objects (`0xF5`, `0xF6`) | Reads and decodes standard TCP/IP Interface Object (`0xF5`) and Ethernet Link Object (`0xF6`) attributes. |
| [`get-attributes-all.js`](./get-attributes-all.js) | **Vol 1 §7** CIP Common Service `0x01` | Retrieves and decodes all attributes of Identity (`0x01`), TCP/IP (`0xF5`), and Ethernet Link (`0xF6`) in single roundtrips. |
| [`multiple-service.js`](./multiple-service.js) | **Vol 1 §25** Multiple Service Packet `0x0A` | Batches multiple CIP requests into a single Message Router round-trip, natively verified on Delta SX3 (<12ms). |
| [`get-attribute.js`](./get-attribute.js) | **Vol 1 §7** CIP Common Service `0x0E` | Generic explicit messaging read (`Get_Attribute_Single`) for any arbitrary Class, Instance, and Attribute. |
| [`set-attribute.js`](./set-attribute.js) | **Vol 1 §7** CIP Common Service `0x10` | Generic explicit messaging write (`Set_Attribute_Single`), validating exact payload lengths. |
| [`routing-and-types.js`](./routing-and-types.js) | **Vol 1 §19, §20, §28-§31** Data Types & Port Segments | Demonstrates CIP elementary type codecs, bit-level packed boolean masking, and multi-hop EPATH route paths. |
| [`large-forward-open.js`](./large-forward-open.js) | **Vol 1 §12, §13** Large Forward Open `0x5B` | Establishes connections with 32-bit parameters up to 65,535 bytes, natively confirmed on Delta SX3. |
| [`session-robustness.js`](./session-robustness.js) | **Vol 2 §2.2, §38** Lifecycle & Reconnect | Demonstrates Session State Machine, fast liveness ping, NOP keepalive, and auto-reconnect resilience. |
| [`concurrency-demo.js`](./concurrency-demo.js) | **Vol 2 §40, §41** Concurrency & Backpressure | Issues concurrent explicit messages via `Promise.all()`, tracking responses via 64-bit Sender Context without head-of-line collision. |
| [`forward-open.js`](./forward-open.js) | **Vol 1 §12, §13** Connection Manager | Connects and executes `Forward_Open` (0x54) and `Forward_Close` (0x4E) for Class 1 I/O connections. |
| [`class1-cyclic-io.js`](./class1-cyclic-io.js) | **Vol 1 §14–§17** Real-Time Cyclic I/O | Full-duplex Class 1 cyclic engine with 32-bit Run/Idle header, sequence tracking, watchdog, and stats. |
| [`eds-discovery.js`](./eds-discovery.js) | **Vol 1 §43, §44, §45** EDS File Parser | Ingests official vendor EDS files, verifies identity match against target, and automatically opens connections. |
| [`io-listen.js`](./io-listen.js) | **Vol 2 §14** Real-Time Cyclic I/O (UDP 2222) | Establishes a Class 1 I/O connection and consumes real-time T->O cyclic UDP datagrams at the negotiated RPI (e.g., 20ms). |
| [`adapter-demo.js`](./adapter-demo.js) | **Vol 2 EIP Adapter** Full Loopback Server | Hosts a local EtherNet/IP Adapter server with Identity, Assembly, TCP/IP, and Ethernet Link objects, and validates client interaction. |
| [`scanner-demo.js`](./scanner-demo.js) | **Scanner Public API** | High-level ergonomic API wrapper showing discovery, explicit messaging, and device reading in minimal code. |
| [`delta-registers.js`](./delta-registers.js) | **Delta Vendor Layer** | Reads and writes Delta D, M, X, Y, and 32-bit registers (AH/AS/SX3 series). |
| [`delta-sx3-full-roundtrip.js`](./delta-sx3-full-roundtrip.js) | **Delta Vendor Layer** | Comprehensive test matrix validating every register type (word, bit, 32-bit, octal labels) on live hardware. |

---

## Quick Execution Guide

### 1. Discovery & Network Services
```bash
# Query supported encapsulation services (ListServices 0x0004)
node examples/list-services.js 192.168.68.250

# TCP ListIdentity probe + session registration
node examples/probe-device.js 192.168.68.250

# Discover devices via UDP broadcast
node examples/scan-network.js
```

### 2. Standard CIP Objects & Attributes
```bash
# Read standard TCP/IP (0xF5) & Ethernet Link (0xF6) objects
node examples/read-network-objects.js 192.168.68.250

# Read all attributes in single roundtrips (Get_Attribute_All 0x01)
node examples/get-attributes-all.js 192.168.68.250

# Read a single attribute (Get_Attribute_Single 0x0E): Identity (0x01) Inst 1 Attr 1 (Vendor ID)
node examples/get-attribute.js 192.168.68.250 1 1 1
```

### 3. Concurrency & Pipeline Performance
```bash
# Test 12 simultaneous requests via Promise.all with Sender Context correlation
node examples/concurrency-demo.js 192.168.68.250
```

### 4. Real-Time Cyclic I/O (Class 1)
```bash
# Test Forward_Open / Forward_Close handshake
node examples/forward-open.js 192.168.68.250

# Stream real-time cyclic UDP 2222 datagrams for 3 seconds
node examples/io-listen.js 192.168.68.250 3
```

### 5. Local Server Loopback
```bash
# Start a local EIP Adapter and test all ODVA commands against it
node examples/adapter-demo.js
```
