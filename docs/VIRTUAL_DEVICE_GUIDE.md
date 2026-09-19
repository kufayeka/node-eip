# Comprehensive Guide: Building a Virtual EtherNet/IP Device

This is the deep-dive companion to the top-level `README.md` §5 quick tutorial. Where the README
gets you a working device in ~7 steps, this document explains every `DeviceBuilder` option, the
two production trigger modes in depth, symbolic Produced/Consumed Tag Connections and their real
config-software quirks, and a troubleshooting appendix built from actual errors encountered
integrating with a real Delta PLC. See `.agents/skills/odva-cip-compliance/SKILL.md` for the
underlying ODVA compliance sourcing.

## Table of Contents

1. [Mental Model](#1-mental-model)
2. [Identity & Revision](#2-identity--revision)
3. [Parameters (CIP Class 0x0F)](#3-parameters-cip-class-0x0f)
4. [Symbolic Tags](#4-symbolic-tags)
5. [Assemblies (Class 1 I/O buffers)](#5-assemblies-class-1-io-buffers)
6. [Connections](#6-connections)
7. [Production Trigger Modes: Cyclic, Change-of-State, and Application Object](#7-production-trigger-modes-cyclic-change-of-state-and-application-object)
8. [Symbolic Produced/Consumed Tag Connections](#8-symbolic-producedconsumed-tag-connections)
9. [Generating the EDS and Starting the Server](#9-generating-the-eds-and-starting-the-server)
10. [Watching Activity & Reacting to Writes](#10-watching-activity--reacting-to-writes)
11. [Registering Custom CIP Objects](#11-registering-custom-cip-objects)
12. [Real PLC Setup Walkthrough (Delta EIP Builder / DIADesigner-AX)](#12-real-plc-setup-walkthrough-delta-eip-builder--diadesigner-ax)
13. [Troubleshooting: Error Codes You Will Actually See](#13-troubleshooting-error-codes-you-will-actually-see)
14. [Capturing & Analyzing Real-Time Timing (Production Readiness)](#14-capturing--analyzing-real-time-timing-production-readiness)

---

## 1. Mental Model

A `DeviceBuilder` describes a device declaratively; `createAdapter()` turns that description into a
live `EIPAdapter` (TCP 44818 + UDP 2222 servers). `generateEds()` turns the *same* description into
an ODVA-format `.eds` text file a real PLC's config software can import. These two outputs **must
stay in sync** — the whole reason `DeviceBuilder` exists as a single source of truth is so you never
hand-maintain an EDS file separately from the running device's actual behavior.

```
DeviceBuilder (in-memory model)
        │
        ├──> generateEds()   ──> "MyDevice.eds"  (import into PLC config software)
        │
        └──> createAdapter() ──> EIPAdapter (live TCP 44818 + UDP 2222 server)
```

## 2. Identity & Revision

```js
const builder = new DeviceBuilder({
    vendorId: 799,                 // ODVA Vendor ID. 799 = Delta Electronics; use your own if you have one.
    vendorName: 'Delta Electronics, Inc.',
    productCode: 1,                 // Your own product identifier, unique per distinct device "shape"
    productName: 'Kufayeka Smart Node',
    deviceType: 'Generic Device',   // or 'AC Drive', 'PLC', 'Communications Adapter', or a raw numeric code
    catalog: 'KUF-NODE-01',
    revision: { major: 1, minor: 1 },
    serialNumber: 0x12345678,       // optional; random if omitted
    description: 'Human-readable description for the EDS [File] DescText'
});
```

**`revision` is clamped to `[1, 255]` for both major and minor**, matching ODVA's own EDS
requirement that Revision fields can never be 0. This isn't just pedantry: the live device's
Identity Object (checked against every Forward_Open's Electronic Key) and the generated EDS's
declared `Revision =` line are guaranteed to match as a result. If they ever disagreed — e.g. one
side silently defaulting to `minor: 0` while the other clamped to `1` — a real Scanner using
*compatible* keying (the common default) reads the EDS's revision, asks for exactly that at
Forward_Open, and gets rejected against the live device with a Revision mismatch (extended status
`0x0116`). This was reproduced live against a real Delta PLC before the clamp was added — see
§13 if you hit this.

**Bumping the revision (or `productCode`) is also the standard fix for a stale device cache.**
Real PLC config software (Delta EIP Builder, RSLogix, etc.) caches imported device definitions
keyed by VendorID+ProductCode+DeviceType(+Revision for some tools). If you change your device's
parameters/assemblies but the PLC software still shows the old structure after re-importing the
EDS, delete the cached device entry and re-add it from the fresh file — don't just overwrite the
`.eds` on disk and expect the config tool to notice. Bumping the revision often forces this
refresh automatically since the tool then treats it as a genuinely different device version.

## 3. Parameters (CIP Class 0x0F)

Parameters populate the config software's "EIP Parameter" screen and can be individually read/
written via explicit messaging, independent of any Class 1 I/O connection.

```js
builder.addParam({
    code: '01-00',          // Vendor-style code shown in the parameter name (e.g. Delta's NN-NN convention)
    name: 'TargetFrequency',
    dataType: 'INT',        // BOOL | SINT | INT | DINT | UINT | UDINT | REAL | STRING
    units: '0.01 Hz',
    min: 0,
    max: 30000,
    default: 100,
    access: 'rw',            // 'r' | 'w' | 'rw'
    help: 'Target frequency command',
    linkPath: undefined       // optional: a raw hex EPATH string if this param aliases another object's attribute
});
```

Read/write current values programmatically (not over the network) with `builder.getParam(code)`,
`builder.getParamValue(code)`, `builder.setParam(code, value)`.

**A parameter can — and often should — be both writable by the PLC and readable back by the PLC.**
ODVA does not restrict which parameter values may appear in which Assembly; an Assembly is just a
byte buffer the vendor chooses how to pack. Mirroring the same `access: 'rw'` parameter into both
an Output Assembly (O→T, written by the PLC) and an Input Assembly (T→O, read back by the PLC) is
standard practice on real CIP devices — e.g. an AC drive's speed setpoint: the PLC writes it, then
reads the same value back as confirmation. See §5-6 for how to wire this up, and set
`syncIoParams: true` in the constructor for it to work automatically.

## 4. Symbolic Tags

Tags differ from Parameters: they don't appear on the "EIP Parameter" screen, but are addressable
directly by name over explicit messaging and can be bound into a Class 1 **Tag Connection**
(§8) instead of a numeric Assembly instance.

```js
builder.addTag('Heartbeat', 'DINT', 0);
builder.addTag('CommandCode', 'INT', 10);
builder.addTag('MES_BatchId', 'STRING', 'BATCH-2026-ALPHA');
```

Read/write: `builder.getTag(name)`, `builder.getTagValue(name)`, `builder.setTag(name, value)`.
Over the network, a Scanner reads/writes a tag with `Get_Attribute_Single`/`Set_Attribute_Single`
against an ANSI Extended Symbol Segment path built from the literal tag name — this project's
`Scanner.readTag()`/`writeTag()` do exactly this against another device; a real PLC's own
explicit-messaging tools can do the same against this device.

**STRING tags cannot be used in a Tag Connection** (§8) — only numeric elementary types
(BOOL/SINT/INT/DINT/UINT/UDINT/REAL/etc.). CIP Parameters (which back a Tag Connection's sizing,
see §8) are fixed-size with numeric Min/Max/Default, incompatible with a variable-length string.
STRING tags remain fully usable via explicit messaging.

## 5. Assemblies (Class 1 I/O buffers)

An Assembly is a raw byte buffer exchanged cyclically over UDP 2222.

```js
builder.defineAssembly({
    instance: 100,                  // Assembly instance number — your choice, but 100/101 is a common convention
    name: 'CTRL_PARAM_20B',         // Shown in the EDS / config software
    sizeBytes: 20,
    type: 'output',                 // 'output' (O->T, PLC writes here) | 'input' (T->O, device produces this) | 'config'
    members: [
        { paramId: '01-00' },       // Reference a Param by its `code`
        { paramId: '01-01' },
        // ...
    ]
});
```

- `type: 'output'` = **O→T** = data the PLC sends **to** this device (Consumed). Typically maps
  writable parameters.
- `type: 'input'` = **T→O** = data this device sends **to** the PLC (Produced). Typically maps
  read-only/feedback parameters — or the SAME `rw` parameters as an output assembly, for the
  write-then-read-back pattern described in §3.
- If `members` is omitted, the builder auto-maps all matching parameters (writable-only for
  `output`, all for `input`) in declaration order until the buffer is full.
- Each member's byte width is inferred from its parameter's `dataType` unless you specify
  `byteSize`/`bitLength` explicitly.

## 6. Connections

A Connection declares a named profile in the EDS's `[Connection Manager]` section — this is what
shows up in the config software's connection/data-exchange dropdown.

```js
builder.defineConnection({
    name: 'Parameter System IO (20 Bytes)',   // Shown in the PLC config software's dropdown
    help: 'Control & Feedback Parameters',
    outputAssembly: 100,   // O->T (Consumed by the device, written by the PLC)
    inputAssembly: 101     // T->O (Produced by the device, read by the PLC)
});
```

Call this once per distinct connection profile you want to offer — e.g. one small "just the
critical parameters" connection and one large "mirror everything" connection, both available as
separate dropdown choices.

## 7. Production Trigger Modes: Cyclic, Change-of-State, and Application Object

CIP Vol 1 Table 3-4.5 defines three Production Trigger modes for a Class 1 connection. Every
Exclusive-Owner connection this library generates advertises support for **Cyclic and
Change-of-State** in its EDS capability mask (`0x04030002` — bit16 Cyclic, bit17 Change-of-State,
bit26 Exclusive-Owner — matching a real Delta SX3's own EDS exactly). The **Scanner** (the PLC)
picks which one to actually use at `Forward_Open` time (usually via a "Trigger Mode" dropdown in
the config software's connection settings) — this device honors whichever was requested:

- **Cyclic**: the device transmits the current T→O data unconditionally on every RPI tick, whether
  or not it changed since the last transmission. Simple, predictable bandwidth.
- **Change-of-State (COS)**: the device polls faster than the RPI internally, but only actually
  transmits when the data has changed *or* the RPI has elapsed as a heartbeat — per CIP Vol 1
  §3-4.5.2, RPI is a *maximum* production interval for COS, not a fixed cadence. This reduces
  network traffic for data that changes infrequently, at the cost of the Scanner needing to trust
  the heartbeat to detect a dead connection rather than a lack of data.

You do not choose between these two in `DeviceBuilder` — it's a Scanner-side choice per connection,
and this library's Adapter follows it automatically (`connection-handler.js`'s `_startProducer()`).

### Application Object trigger — production driven by your own code

The third trigger type is different in kind, not just timing: **the application itself decides
exactly when to produce**, with no automatic timer and no automatic value comparison at all. Ported
from OpENer's own public `TriggerConnections()` API (the same entry point an OpENer-based device's
firmware calls), this device gives you three equivalent ways to trigger it:

```js
// Lowest level — by Assembly instance or tag name, directly on the ConnectionHandler:
adapter.connectionHandler.triggerProduction(101);          // T->O Assembly instance 101
adapter.connectionHandler.triggerProduction('Heartbeat');   // or a symbolic tag name

// Slightly higher level — on the adapter itself, same arguments:
adapter.triggerProduction(101);

// Highest level — by the connection's own name, from DeviceBuilder:
builder.triggerConnection('Parameter System IO (20 Bytes)');
```

A connection only actually produces via these calls if the Scanner negotiated Application Object
trigger for it in the first place (`transportTypeTrigger`'s production-trigger bits = `2`) — calling
`triggerProduction()`/`triggerConnection()` against a Cyclic or Change-of-State connection is a
harmless no-op (returns `0`).

**This mode is not currently advertised in the EDS capability mask** — unlike Cyclic/COS, this
project's own real Delta SX3 ground truth doesn't set the Application Object bit either, and it
isn't a typical option in mainstream config-tool "Trigger Mode" dropdowns. It's implemented and
fully functional for a Scanner (or your own test code) that requests it explicitly, but don't
expect to see it as a selectable option in Delta EIP Builder or similar. Typical use case: your
device's own application logic — not a fixed timer or a value comparison — determines when new
data is meaningful to send (e.g. "a batch just completed", "a barcode was just scanned") and calls
`triggerConnection()` right after updating the relevant parameter/tag/assembly data.

## 8. Symbolic Produced/Consumed Tag Connections

In addition to numeric Assembly-based connections, this library supports a **Tag Connection** —
a Class 1 I/O connection whose Forward_Open path is a symbolic tag name (ANSI Extended Symbol
Segment) instead of fixed Class/Instance/ConnectionPoint numbers. This is automatically added to
the EDS (as `Path = "SYMBOL_ANSI"`) whenever any tag exists:

```js
builder.addTag('Heartbeat', 'DINT', 0);
// ... generateEds() now includes a "Tag Connection" entry automatically
```

At runtime, when a Scanner opens this connection with a symbolic path, the tag name is resolved
against this device's own tag registry and bound to whichever direction(s) the Forward_Open
request populated: O→T-only (PLC writes/Consumes the tag), T→O-only (PLC reads/Produces from the
tag), or both simultaneously (the same tag, read AND write) — matching this project's own real
Delta SX3 ground-truth EDS, whose own Tag Connection entry is Produced-only (O→T size 0).

### Why every numeric tag also gets a synthetic Param + Assembly

Real testing against Delta EIP Builder found that leaving the Tag Connection's Format field blank
left the config software's "Length" column stuck at an uneditable, meaningless default, no matter
what valid tag name was typed in. `eds-exporter.js` therefore also emits, for every **numeric**
tag (STRING tags are skipped — see §4):

1. A synthetic `Param` entry with the tag's real CIP type and byte size.
2. A synthetic `TAG_SYMBOL_TABLE` Assembly listing all of those Params as members.
3. A reference to that Assembly in the Tag Connection's O→T and T→O Format fields.

This mirrors this project's own real Delta SX3 EDS, whose Tag Connection Format field likewise
references a real Assembly of Params rather than being left blank — directly confirmed by ODVA's
own vendor handbook (PUB00213 Appendix A): *"For size and format, at least one of the two fields
must be filled ... It is strongly recommended to define the format."*

**However**, live testing found this synthetic table is not sufficient by itself to make the
config software's "Length" column populate automatically — that column was observed to follow
whichever data type the PLC-side (Master) variable was declared as, not something derived from the
device's own EDS. In practice: **you must manually ensure the PLC-side tag's declared type/size
matches the device-side tag's real byte size** (e.g. a device `DINT` tag needs a 4-byte/DINT
variable on the PLC side) — there is no automatic negotiation, and there is no tag
autocomplete/browsing either (see next paragraph). The synthetic Param/Assembly is still emitted
because it is the ODVA-recommended, real-hardware-matching way to declare the connection, and it
does make the byte size independently discoverable via explicit messaging — it just isn't a
complete substitute for the PLC-side operator getting the type right.

### No tag autocomplete — this is expected, not a bug

The tag-name field in real config software (e.g. Delta EIP Builder's "Slave Register/Parameter/
Variable" column) is **plain manual text entry**. There is no dropdown or live discovery of the
device's available tag names. This is not a limitation of this library — a real Delta SX3 device's
own EDS has no Symbol Object (Class 0x6B), the CIP mechanism that would be needed to support
browsing, so this matches genuine hardware behavior. Type the tag name exactly as given to
`addTag()` (case-sensitive).

## 9. Generating the EDS and Starting the Server

```js
const fs = require('fs');

const edsText = builder.generateEds();
fs.writeFileSync('MyDevice.eds', edsText);

const adapter = builder.createAdapter({
    port: 44818,                        // TCP/UDP encapsulation port
    ioPort: 2222,                        // UDP Class 1 I/O port
    address: '0.0.0.0',                 // bind interface; '0.0.0.0' picks up the machine's outward-facing IP for reporting
    quiet: false,                        // true suppresses per-connection console logs
    strictDuplicateConnections: false   // true = ODVA-strict duplicate Forward_Open rejection (CIP Vol 1 §3-5.5.3)
});

await adapter.start();
```

`strictDuplicateConnections: false` (the default) lets a repeat Forward_Open from the same
originator silently supersede its own prior connection — convenient during development when
restarting a Scanner-side test without an explicit Forward_Close. Set it `true` for ODVA-strict
behavior (reject an exact-triple duplicate with extended status `0x0100`) once you're testing
against a real, well-behaved Scanner and want stricter guarantees.

## 10. Watching Activity & Reacting to Writes

```js
builder.watch({
    logParams: true,       // console.log every parameter write from the PLC
    logTags: true,         // console.log every tag write from the PLC
    logAssembly: false,    // WARNING: true logs every single raw cyclic packet — usually way too much
    logAssemblyChanges: false
});

builder.on('paramChange', (code, newVal, oldVal, param, source) => { /* ... */ });
builder.on('paramWrite', (code, newVal, oldVal, param, source) => { /* ... */ });
builder.on('tagChange', (name, newVal, oldVal) => { /* ... */ });
builder.on('tagWrite', (name, newVal, oldVal) => { /* ... */ });
builder.on('assemblyChange', (instance, buffer, oldBuffer) => { /* ... */ });
builder.on('assemblyWrite', (instance, buffer, oldBuffer) => { /* ... */ });
```

**Important distinction for timing/diagnostic work**: `*Change`/`*Write` events for params/tags
only fire when the DECODED VALUE actually differs from the previous one. `assemblyWrite` fires on
**every** incoming datagram unconditionally (it mirrors `AssemblyObject`'s raw `'write'` event,
which `setData()` always emits). If you need to know exactly when packets physically arrive — for
jitter/drift analysis, or because a value can coincidentally repeat and you don't want that
mistaken for a dropped packet — hook `assemblyWrite`, not `paramChange`. See §14.

## 11. Registering Custom CIP Objects

For behavior beyond parameters/tags/assemblies (a fully custom CIP object class):

```js
const { GenericCipObject } = require('@kufayeka/ethernet-ip').cip.objects;

const recipeObj = new GenericCipObject({ classId: 0x70, className: 'CustomRecipeObject', revision: 1 });
recipeObj.addInstance(1);
recipeObj.registerAttribute(1, 1, 'SHORT_STRING', 'BATCH-2026-X1', { access: 'RW', name: 'BatchId' });
recipeObj.registerAttribute(1, 3, 'STRUCT', {
    fields: [
        { name: 'recipeId', type: 'UINT', value: 101 },
        { name: 'targetTemp', type: 'REAL', value: 75.5 }
    ]
}, { access: 'RW', name: 'RecipeConfig' });

adapter.registerObject(0x70, recipeObj); // after createAdapter(), before/after start() both work
```

## 12. Real PLC Setup Walkthrough (Delta EIP Builder / DIADesigner-AX)

1. Run your script (`node my-device.js`) — it starts listening immediately on TCP 44818 and UDP 2222.
2. In the config software's Network View / Device Library: right-click → **Add Device** → **Import
   EDS** → select the generated `.eds` file.
3. Open the new device's node settings and set its **IP Address** to match where your script is
   running (printed at startup).
4. Open **Data Exchange** (or "Connection Setting"): pick one of your `defineConnection()` profiles
   from the dropdown, set RPI and Trigger Mode.
5. For a Tag Connection specifically: check the "Tag" checkbox for that row, type the exact tag
   name in the Slave/Consumed or Produced column (see §8 — no autocomplete), and separately pick or
   create a matching-type variable on the Master (PLC) side.
6. **If you previously imported an earlier version of this device**, delete that old entry from the
   device library first and re-add fresh from the new EDS — see the caching note in §2.
7. Download the configuration to the PLC and set it to RUN. Your script's console (if `watch()` is
   enabled) will start logging parameter/tag writes as the PLC begins cycling.

## 13. Troubleshooting: Error Codes You Will Actually See

These are real Connection Manager extended status codes encountered integrating with a real Delta
PLC this project, decoded from the `[ConnMgr Open REJECT]` console line `adapter.js` prints.

| Extended Status | Meaning (this project's usage) | Likely cause & fix |
|---|---|---|
| `0x0100` | Connection in use / duplicate Forward_Open | Only occurs with `strictDuplicateConnections: true`; the Scanner re-sent an identical {Connection Serial, Vendor ID, Originator Serial} triple without closing the old one first. Either Forward_Close first, or leave strict mode off during development. |
| `0x0107` | Connection not found at target | The requested Assembly instance (or tag name, for a Tag Connection) doesn't exist on this device. Check `defineAssembly()`/`addTag()` was actually called for that instance/name, and that the tag name is typed exactly (case-sensitive) in the config software. |
| `0x0109` | Invalid connection size | The Forward_Open's requested O→T/T→O byte size doesn't match this device's actual Assembly/tag size. For a Tag Connection, this means the PLC-side variable's type doesn't match the device tag's real byte width — see §8. |
| `0x0113` | Connection size mismatch | Similar to above; requested size exceeds this project's auto-adapt limits (511 bytes classic, 65535 Large_Forward_Open). |
| `0x0114` | Vendor ID or Product Code mismatch (Electronic Key) | The Scanner's cached device definition doesn't match this device's live identity — usually because the Scanner is still configured for an OLD version of this device (different `productCode` from an earlier test). Re-import the current EDS as a fresh device entry. |
| `0x0116` | Revision mismatch (Electronic Key) | The Scanner's Electronic Key asks for a Major/Minor revision this device doesn't (compatibly) satisfy — almost always a live-identity-vs-EDS revision mismatch (see §2) or a genuinely stale cached device revision in the config software. Confirm the currently-RUNNING process's `revision` matches what the EDS on disk (and what the config software has actually re-imported) declares. |
| `0x0120` | Invalid segment in connection path | Malformed or unsupported EPATH segment — e.g. a Tag Connection request with neither O→T nor T→O size populated. |
| `0x0127` | Configuration path parameters mismatch (per Delta's own manual) | Encountered when THIS library acted as a Scanner trying to open a symbolic-tag connection against a REAL Delta PLC's own produced tag — the wire format this library used (a bare ANSI symbol path) didn't match what Delta's Connection Manager expects for that direction. Not yet resolved; see `.agents/skills/odva-cip-compliance/SKILL.md` §5. Does not affect the (fully working) reverse direction — a real PLC connecting to THIS library's own virtual device. |

General diagnosis approach when a Forward_Open is rejected: `adapter.js` prints
`[ConnMgr Open REJECT] General: 0x.. | Extended: 0x.. | Path: <hex>` — decode the `Path` hex with
`cip/path.js`'s `decodeEPath()` if you need to see exactly what the Scanner asked for.

## 14. Capturing & Analyzing Real-Time Timing (Production Readiness)

Before relying on a Class 1 connection for production, capture real timing data rather than
trusting console logs of value changes (which, per §10, can silently skip a coincidentally-repeated
value and look like a dropped packet). The pattern used to validate this project's own connections:

1. Hook `assemblyWrite` (not `paramChange`) and log every row to a CSV with BOTH a wall-clock
   timestamp (`Date.now()`) and a monotonic timestamp (`process.hrtime.bigint()`).
2. Run for a realistic duration under realistic network conditions.
3. Analyze the dump for: packet interval statistics (avg/stdev/percentiles) against your configured
   RPI, anomalous gaps or bursts, and — critically — compare the wall-clock and monotonic deltas
   against each other to separate genuine network/scheduling jitter from an actual system clock
   step (NTP correction, DST, manual clock change), since only the wall clock is affected by the
   latter.

A working reference implementation of both the capture (`eip_device.js`) and the analysis
(`analyze-eip-dump.js`) lives alongside this package in the parent workspace
(`packages/node_modules/`) — read those two files for the exact pattern; they're intentionally
dependency-free (`fs` + arithmetic only) so they're easy to adapt into your own device script.
