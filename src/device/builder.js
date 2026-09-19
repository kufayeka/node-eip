'use strict';

/**
 * Universal EtherNet/IP Device Builder
 *
 * Provides a declarative, fluent API to construct virtual EtherNet/IP devices,
 * export official ODVA-compliant .eds files, and instantiate live EIPAdapter servers.
 */

const { EventEmitter } = require('events');
const { ParameterObject } = require('../cip/objects/parameter');
const { exportToEds } = require('./eds-exporter');
const { EIPAdapter } = require('../adapter');
const { createProfileFromEds } = require('./eds-generator');
const { CipClassCodes } = require('../constants');

class DeviceBuilder extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {number} [options.vendorId=0x1337]
     * @param {string} [options.vendorName='Kufayeka Automation']
     * @param {number} [options.productCode=1]
     * @param {string} [options.productName='Virtual EIP Device']
     * @param {number|string} [options.deviceType=0x002B] - 0x2B (Generic Device), 0x02 (AC Drive), 0x0E (PLC)
     * @param {string} [options.description]
     * @param {{ major: number, minor: number }} [options.revision]
     * @param {number} [options.serialNumber]
     */
    constructor(options = {}) {
        super();
        const rawRevision = options.revision || { major: 1, minor: 1 };
        // ODVA CIP EDS Specification: both MajRev and MinRev must be integers
        // between 1 and 255 (never 0) — clamped here, at construction, so the
        // live Identity Object (checked against every Forward_Open's
        // Electronic Key) can never drift out of sync with generateEds()'s
        // own identical clamp. A caller passing e.g. { major: 1, minor: 0 }
        // used to produce a device whose EDS declared "Revision = 1.1" (EDS
        // exporter's clamp) while the live device actually answered 1.0 —
        // any Scanner using compatible keying (the common case) would then
        // reject every Forward_Open with a Revision mismatch (0x0116),
        // because it always asks for the *exact* revision printed in the EDS.
        const revision = {
            major: Math.max(1, Math.min(255, Number(rawRevision.major) || 1)),
            minor: Math.max(1, Math.min(255, Number(rawRevision.minor) || 1))
        };
        this.identity = {
            vendorId: options.vendorId !== undefined ? options.vendorId : 799,
            vendorName: options.vendorName || 'Delta Electronics, Inc.',
            productCode: options.productCode !== undefined ? options.productCode : 1,
            productName: options.productName || 'Kufayeka Smart Node',
            catalog: options.catalog || 'KUF-EIP-NODE',
            deviceType: typeof options.deviceType === 'number' ? options.deviceType : this._resolveDeviceTypeCode(options.deviceType),
            deviceTypeStr: typeof options.deviceType === 'string' ? options.deviceType : 'Generic Device',
            revision,
            serialNumber: options.serialNumber || (Math.floor(Math.random() * 0x7FFFFFFF) + 1)
        };

        this.description = options.description || `${this.identity.vendorName} ${this.identity.productName}`;
        this.parameterObject = new ParameterObject();
        this.params = [];
        this.tags = new Map(); // tagName -> { type, value }
        this.assemblies = [];
        this.connections = [];
        this._assemblyMappings = new Map(); // instance -> array of { param, offset, byteSize }
        this.syncIoParamsEnabled = Boolean(options.syncIoParams);

        // Forward parameter changes and writes
        this.parameterObject.on('change', (param, newVal, oldVal) => {
            this.emit('paramChange', param.code || param.id, newVal, oldVal, param);
            if (this.adapter && this._assemblyMappings && this.syncIoParamsEnabled) {
                for (const assem of this.assemblies) {
                    if (assem.type === 'input') {
                        this._syncParamsToAssembly(assem.instance);
                    }
                }
            }
        });
        this.parameterObject.on('write', (param, newVal, oldVal) => {
            this.emit('paramWrite', param.code || param.id, newVal, oldVal, param, 'explicit-0x0F');
        });
    }

    _resolveDeviceTypeCode(typeStr) {
        if (!typeStr || typeof typeStr !== 'string') return 0x002B;
        const lower = typeStr.toLowerCase();
        if (lower.includes('drive') || lower.includes('inverter') || lower.includes('vfd')) return 0x0002;
        if (lower.includes('plc') || lower.includes('programmable controller')) return 0x000E;
        if (lower.includes('io') || lower.includes('discrete')) return 0x0007;
        if (lower.includes('sensor')) return 0x0021;
        return 0x002B; // Generic Device
    }

    /**
     * Sets or updates device identity metadata.
     */
    setIdentity(identityOpts = {}) {
        Object.assign(this.identity, identityOpts);
        return this;
    }

    /**
     * Adds a parameter (CIP Parameter Object Class 0x0F).
     *
     * @param {object} opts
     * @param {string} [opts.code] - Parameter code e.g. '01-00'
     * @param {string} [opts.name] - Descriptive parameter name
     * @param {string} [opts.dataType='INT'] - 'BOOL','SINT','INT','DINT','UINT','UDINT','REAL','STRING'
     * @param {'r'|'w'|'rw'} [opts.access='rw'] - Access permission
     * @param {string} [opts.units=''] - Units e.g. 'Hz', 'RPM', '°C'
     * @param {string} [opts.help=''] - Help string
     * @param {number} [opts.min] - Minimum value
     * @param {number} [opts.max] - Maximum value
     * @param {number} [opts.default] - Default value
     * @param {any} [opts.value] - Initial value
     * @param {string} [opts.linkPath] - CIP link path hex string
     */
    addParam(opts) {
        const param = this.parameterObject.addParam(opts);
        this.params.push(param);
        return this;
    }

    /**
     * Sets value of an existing parameter.
     */
    setParam(key, value) {
        this.parameterObject.setValue(key, value);
        return this;
    }

    /**
     * Gets parameter definition.
     */
    getParam(key) {
        return this.parameterObject.getParam(key);
    }

    /**
     * Gets current value of a parameter.
     */
    getParamValue(key) {
        return this.parameterObject.getValue(key);
    }

    /**
     * Adds a symbolic tag (ControlLogix-style tag addressing).
     * Ideal for MES buffers, key-value storage, and SCADA tags.
     *
     * @param {string} name - Tag name (e.g. 'BatchId', 'TotalCount')
     * @param {string} [dataType='DINT'] - Data type
     * @param {any} [initialValue=0] - Initial value
     */
    addTag(name, dataType = 'DINT', initialValue = 0) {
        this.tags.set(name, {
            name,
            type: dataType.toUpperCase(),
            value: initialValue
        });
        return this;
    }

    /**
     * Sets a symbolic tag value.
     */
    setTag(name, value) {
        const tag = this.tags.get(name);
        if (!tag) {
            throw new Error(`DeviceBuilder: symbolic tag "${name}" not found`);
        }
        const oldVal = tag.value;
        tag.value = value;
        this.emit('tagChange', name, value, oldVal);
        this.emit('tagWrite', name, value, oldVal);
        return this;
    }

    /**
     * Gets a symbolic tag definition.
     */
    getTag(name) {
        return this.tags.get(name) || null;
    }

    /**
     * Gets symbolic tag value.
     */
    getTagValue(name) {
        const tag = this.tags.get(name);
        return tag ? tag.value : undefined;
    }

    /**
     * Defines an Assembly instance for real-time Class 1 I/O (UDP 2222).
     *
     * @param {object} opts
     * @param {number} opts.instance - Assembly instance ID (e.g. 100, 101)
     * @param {string} [opts.name] - Assembly name
     * @param {number} [opts.sizeBytes=4] - Buffer size in bytes
     * @param {'input'|'output'|'config'} [opts.type='input'] - Assembly type
     * @param {Array<{ paramId: number, bitOffset: number, bitLength: number }>} [opts.members]
     */
    defineAssembly(opts) {
        if (!opts || typeof opts.instance !== 'number') {
            throw new TypeError('defineAssembly: options.instance must be a number');
        }
        this.assemblies.push({
            instance: opts.instance,
            name: opts.name || `Assembly ${opts.instance}`,
            sizeBytes: opts.sizeBytes || 4,
            type: (opts.type || 'input').toLowerCase(),
            members: opts.members || []
        });
        return this;
    }

    /**
     * Defines a named Class 1 I/O connection profile in the EDS file.
     *
     * @param {object} opts
     * @param {string} opts.name - Connection name shown in Delta EIP Builder dropdown
     * @param {string} [opts.help] - Description / help string
     * @param {number} opts.outputAssembly - Output / Consumed Assembly Instance ID (PLC -> Device)
     * @param {number} opts.inputAssembly - Input / Produced Assembly Instance ID (Device -> PLC)
     * @param {boolean} [opts.listenOnly=true] - Also offer a Listen-Only variant (lets a second,
     *   passive consumer — e.g. an HMI/SCADA — observe the same T->O data while a PLC owns the
     *   Exclusive-Owner connection). Required for input-having Adapters per PUB00070 §5.2.2/§5.2.3f.
     * @param {boolean} [opts.inputOnly=true] - Also offer an Input-Only variant.
     * @param {number} [opts.rpiUs] - Suggested default RPI (microseconds), both directions, shown
     *   as the pre-filled value in a Scanner's config tool (e.g. Delta EIP Builder's Data Exchange
     *   row) when this connection is first added — the Scanner can still request a different RPI
     *   at Forward_Open time regardless; this is a config-tool convenience default only, not an
     *   enforced limit. Omit to leave it blank (tool's own default / operator must type one in,
     *   this project's previous behavior). @param {number} [opts.otRpiUs] - Overrides opts.rpiUs
     *   for the O->T direction only. @param {number} [opts.toRpiUs] - ...for T->O only.
     * @param {Array<'cyclic'|'cos'|'applicationObject'>} [opts.triggers=['cyclic','cos']] - Which
     *   Production Trigger types this connection's Exclusive-Owner entry ADVERTISES as available
     *   in the EDS (CIP Vol 1 Table 3-4.5) — a config tool that reads this may only let the
     *   operator pick from what's advertised. This does NOT restrict what connection-handler.js
     *   actually accepts at runtime (any Forward_Open naming a supported trigger works regardless,
     *   per decodeProductionTrigger()) — it only affects what a Scanner's own UI offers to select.
     *   Include 'applicationObject' to make Application-Object-triggered connections selectable in
     *   tools that support it (see ConnectionHandler.triggerProduction()/DeviceBuilder.triggerConnection()
     *   for driving one). Listen-Only/Input-Only variants are always Cyclic-only, unaffected by this.
     */
    defineConnection(opts) {
        if (!opts || typeof opts.name !== 'string') {
            throw new TypeError('defineConnection: options.name must be a string');
        }
        // Placeholder O->T instances for the Input-Only/Listen-Only variants of this profile —
        // CIP Vol 1 §5.2.3f / PUB00070 §5.2.2 require an Adapter with input data to support a
        // Listen-Only or Input-Only connection alongside its Exclusive-Owner one, so more than
        // one consumer (e.g. a PLC owning the connection plus an HMI/SCADA independently
        // monitoring it) can read the same T->O data simultaneously. These placeholders carry no
        // real data of their own — see ConnectionHandler.registerConnectionPoint()'s doc comment
        // — they only exist so a Forward_Open's path can select which variant it wants. Matches
        // this project's own real Delta SX3 EDS convention of reserved instances 0xC0/0xC1/...;
        // each connection profile gets its own pair so multiple profiles never collide.
        const index = this.connections.length;
        const listenOnlyO2T = 0xC0 + index * 2;
        const inputOnlyO2T = listenOnlyO2T + 1;
        this.connections.push({
            name: opts.name,
            help: opts.help || opts.name,
            outputAssembly: opts.outputAssembly,
            inputAssembly: opts.inputAssembly,
            listenOnlyO2T,
            inputOnlyO2T,
            supportListenOnly: opts.listenOnly !== false,
            supportInputOnly: opts.inputOnly !== false,
            otRpiUs: opts.otRpiUs !== undefined ? opts.otRpiUs : opts.rpiUs,
            toRpiUs: opts.toRpiUs !== undefined ? opts.toRpiUs : opts.rpiUs,
            triggers: Array.isArray(opts.triggers) ? opts.triggers : ['cyclic', 'cos']
        });
        return this;
    }

    /**
     * Generates a 100% compliant ODVA Electronic Data Sheet (.eds) text.
     *
     * @returns {string} Official EDS text
     */
    generateEds() {
        return exportToEds({
            identity: this.identity,
            description: this.description,
            params: this.params,
            assemblies: this.assemblies,
            connections: this.connections,
            tags: this.tags
        });
    }

    /**
     * Converts this device directly into a client-side DeviceProfile.
     *
     * @returns {import('./profile').DeviceProfile}
     */
    toProfile() {
        const edsText = this.generateEds();
        return createProfileFromEds(edsText, {
            vendor: this.identity.vendorName,
            model: this.identity.productName,
            description: this.description
        });
    }

    /**
     * Creates and starts a live EtherNet/IP Adapter server hosting this device.
     *
     * @param {object} [adapterOpts]
     * @param {number} [adapterOpts.port=44818] - TCP/UDP encapsulation port
     * @param {number} [adapterOpts.ioPort=2222] - UDP I/O port
     * @param {string} [adapterOpts.address] - Interface IP address to bind
     * @returns {EIPAdapter}
     */
    createAdapter(adapterOpts = {}) {
        const adapter = new EIPAdapter({
            port: adapterOpts.port,
            ioPort: adapterOpts.ioPort,
            address: adapterOpts.address,
            quiet: adapterOpts.quiet !== undefined ? adapterOpts.quiet : false,
            strictDuplicateConnections: Boolean(adapterOpts.strictDuplicateConnections),
            identity: {
                vendorId: this.identity.vendorId,
                deviceType: this.identity.deviceType,
                productCode: this.identity.productCode,
                productName: this.identity.productName,
                revision: this.identity.revision,
                serialNumber: this.identity.serialNumber
            }
        });

        // 1. Register Parameter Object (Class 0x0F)
        adapter.registerObject(CipClassCodes.Parameter, this.parameterObject);

        // 1b. Register connection-type slots (Exclusive-Owner always; Input-Only/Listen-Only
        // when enabled) so the Connection Manager can classify Forward_Opens correctly instead
        // of treating every connection identically — see connection-handler.js's
        // registerConnectionPoint()/​_classifyConnectionType().
        for (const conn of this.connections) {
            adapter.connectionHandler.registerConnectionPoint('exclusiveOwner', {
                outputAssembly: conn.outputAssembly,
                inputAssembly: conn.inputAssembly
            });
            if (conn.supportInputOnly) {
                adapter.connectionHandler.registerConnectionPoint('inputOnly', {
                    outputAssembly: conn.inputOnlyO2T,
                    inputAssembly: conn.inputAssembly
                });
            }
            if (conn.supportListenOnly) {
                adapter.connectionHandler.registerConnectionPoint('listenOnly', {
                    outputAssembly: conn.listenOnlyO2T,
                    inputAssembly: conn.inputAssembly
                });
            }
        }

        // 2. Register Symbolic Tags
        for (const [tagName, tagDef] of this.tags.entries()) {
            adapter.defineTag(tagName, tagDef.type, tagDef.value);
        }

        // Keep tags in sync
        this.on('tagChange', (name, val) => {
            try { adapter.setTag(name, val); } catch {}
        });

        // Forward tag writes and changes from adapter back to DeviceBuilder
        adapter.on('tagChange', (name, val, oldVal) => {
            const tag = this.tags.get(name);
            if (tag) tag.value = val;
            this.emit('tagChange', name, val, oldVal);
        });
        adapter.on('tagWrite', (name, val, oldVal) => {
            this.emit('tagWrite', name, val, oldVal);
        });

        // Forward assembly events
        adapter.assembly.on('change', (instance, current, oldBuf) => {
            this.emit('assemblyChange', instance, current, oldBuf);
            const assem = this.assemblies.find(a => a.instance === instance);
            if (assem && assem.type === 'output' && this.syncIoParamsEnabled) {
                if (instance === 110 && adapter.deltaStore) {
                    // D-Register Mirror: Sync incoming PLC D0..D63 into DeltaStore D
                    const words = Math.min(64, Math.floor(current.length / 2));
                    for (let i = 0; i < words; i++) {
                        adapter.deltaStore.setWord('D', i, current.readInt16LE(i * 2));
                    }
                } else {
                    this._unpackAssemblyToParams(instance, current, 'plc-io');
                }
            }
        });
        adapter.assembly.on('write', (instance, current, oldBuf) => {
            this.emit('assemblyWrite', instance, current, oldBuf);
        });

        // 3. Register Assemblies & Build Parameter Mappings
        this._assemblyMappings = new Map();
        for (const assem of this.assemblies) {
            adapter.defineAssembly(assem.instance, assem.sizeBytes);
            const mapping = this._buildAssemblyMapping(assem);
            this._assemblyMappings.set(assem.instance, mapping);

            // Pre-pack initial parameter values for input assemblies (T->O produced to PLC)
            if (assem.type === 'input' && this.syncIoParamsEnabled) {
                this._syncParamsToAssembly(assem.instance);
            }
        }

        // Dynamically sync feedback parameters right before every produced T->O cyclic UDP datagram
        if (adapter.connectionHandler) {
            adapter.connectionHandler.onProduceData = (instance) => {
                if (this.syncIoParamsEnabled) {
                    if (instance === 111 && adapter.deltaStore) {
                        // Pack DeltaStore D100..D163 feedback into Assembly 111 buffer
                        const buf = adapter.assembly.getData(111);
                        if (buf) {
                            const words = Math.min(64, Math.floor(buf.length / 2));
                            for (let i = 0; i < words; i++) {
                                const val = adapter.deltaStore.getWord('D', 100 + i);
                                buf.writeInt16LE(val !== undefined ? val : 0, i * 2);
                            }
                        }
                    } else {
                        this._syncParamsToAssembly(instance);
                    }
                }
            };
        }

        this.adapter = adapter;
        return adapter;
    }

    /**
     * Enables or disables automatic bidirectional synchronization between
     * Assemblies and Parameters (e.g. Assembly 100 unpacks into writable parameters,
     * and parameter changes pack into Assembly 101).
     *
     * @param {boolean} [enabled=true]
     * @returns {DeviceBuilder}
     */
    syncIoParams(enabled = true) {
        this.syncIoParamsEnabled = Boolean(enabled);
        return this;
    }

    /**
     * Explicitly triggers Class 1 production for a connection profile defined with
     * `defineConnection()`, by name — only meaningful for a connection the Scanner opened with
     * Application Object trigger (CIP Vol 1 Table 3-4.5): unlike Cyclic (fixed RPI timer) or
     * Change-of-State (automatic value comparison), that trigger type produces ONLY when the
     * application explicitly asks it to. Call this right after updating the data you want sent
     * (e.g. after `setParam()`/`setTag()`/packing an Assembly buffer directly) — a no-op if the
     * Scanner didn't actually select Application Object trigger for this connection, or if
     * `createAdapter()` hasn't been called yet.
     *
     * @param {string} connectionName - the `name` passed to defineConnection()
     * @returns {number} how many currently-open connections were actually triggered (0 or 1)
     */
    triggerConnection(connectionName) {
        if (!this.adapter) return 0;
        const conn = this.connections.find((c) => c.name === connectionName);
        if (!conn) throw new Error(`DeviceBuilder.triggerConnection: no connection named "${connectionName}" (defineConnection() first)`);
        return this.adapter.triggerProduction(conn.inputAssembly);
    }

    _buildAssemblyMapping(assem) {
        const members = [];
        if (Array.isArray(assem.members) && assem.members.length > 0) {
            let offset = 0;
            for (const m of assem.members) {
                const p = this.getParam(m.paramId || m.id);
                const bSize = m.byteSize || (m.bitLength ? Math.ceil(m.bitLength / 8) : (p ? p.byteSize : 2));
                if (p) members.push({ param: p, offset, byteSize: bSize });
                offset += bSize;
            }
        } else if (this.params.length > 0 && (assem.instance === 100 || assem.instance === 101)) {
            // Convenience fallback for the legacy single-connection-profile convention (Assembly
            // 100 = Output/Consumed, 101 = Input/Produced, no explicit `members` needed) -- NOT a
            // general rule for "any assembly instance below 110". It used to be exactly that (a
            // bare `assem.instance < 110`), which silently auto-mapped ALL registered params
            // (packed byte-aligned, in registration order) into ANY OTHER Assembly in that range
            // that was deliberately left without `members` for its own reason -- e.g. a bit-packed
            // boolean Assembly (102/103), where this fallback stuffed the first Param that fit
            // (by byte size) into the whole raw byte, running ALONGSIDE and fighting the
            // application's own intentional bit-level pack/unpack of that same byte. Concretely:
            // one BOOL param got silently bound to the ENTIRE byte's nonzero-ness, so it read back
            // true whenever ANY of the real bit-packed flags was set, regardless of its own actual
            // bit. Scoped to exactly 100/101 to match eds-exporter.js's own equivalent fallback
            // condition for the EDS text itself, which was never broadened the same way.
            const targetParams = (assem.type === 'output')
                ? (this.params.filter(p => p.access !== 'r').length > 0 ? this.params.filter(p => p.access !== 'r') : this.params)
                : this.params;
            let offset = 0;
            for (const p of targetParams) {
                if (offset + p.byteSize <= assem.sizeBytes) {
                    members.push({ param: p, offset, byteSize: p.byteSize });
                    offset += p.byteSize;
                }
            }
        }
        return members;
    }

    _syncParamsToAssembly(instance) {
        if (!this.adapter || !this.syncIoParamsEnabled) return;
        const mapping = this._assemblyMappings ? this._assemblyMappings.get(instance) : null;
        if (!mapping || !mapping.length) return;
        const currentBuf = this.adapter.assembly.getData(instance);
        if (!currentBuf) return;
        const newBuf = Buffer.from(currentBuf);
        const { encodeType } = require('../cip/types');
        for (const item of mapping) {
            const { param, offset, byteSize } = item;
            if (!param || offset + byteSize > newBuf.length) continue;
            if (param.buffer && param.buffer.length >= byteSize) {
                param.buffer.copy(newBuf, offset, 0, byteSize);
            } else {
                try {
                    const encoded = encodeType(param.dataType, param.value !== undefined ? param.value : param.default);
                    encoded.copy(newBuf, offset, 0, Math.min(byteSize, encoded.length));
                } catch {}
            }
        }
        if (!newBuf.equals(currentBuf)) {
            this.adapter.assembly.setData(instance, newBuf, { silent: true });
        }
    }

    _unpackAssemblyToParams(instance, buffer, source = 'plc') {
        const mapping = this._assemblyMappings ? this._assemblyMappings.get(instance) : null;
        if (!mapping || !mapping.length) return;
        const { decodeType } = require('../cip/types');
        for (const item of mapping) {
            const { param, offset, byteSize } = item;
            if (!param || offset + byteSize > buffer.length) continue;
            try {
                const slice = buffer.subarray(offset, offset + byteSize);
                const decoded = decodeType(param.dataType, slice, 0);
                const newVal = decoded.value;
                if (newVal !== param.value) {
                    const oldVal = param.value;
                    param.value = newVal;
                    param.buffer = Buffer.from(slice);
                    this.emit('paramChange', param.code || param.id, newVal, oldVal, param, source, instance);
                    this.emit('paramWrite', param.code || param.id, newVal, oldVal, param, source, instance);
                }
            } catch (err) {}
        }
    }

    /**
     * Real-time watcher for incoming write events from PLCs / Scanners.
     * Captures parameter writes, symbolic tag writes, and assembly data writes.
     *
     * @param {function(object): void|object} [callbackOrOpts] - Custom callback or options:
     *   - quiet {boolean}: if true, silences all assembly logs completely
     *   - logAssembly {boolean}: if true, logs every raw Class 1 cyclic write (default: false to prevent console flood)
     *   - logAssemblyChanges {boolean}: if true, logs when assembly data changes (default: false)
     *   - logParams {boolean}: whether to log parameter writes (default: true)
     *   - logTags {boolean}: whether to log symbolic tag writes (default: true)
     * @returns {DeviceBuilder}
     */
    watch(callbackOrOpts) {
        let opts = {};
        let customCallback = null;
        if (typeof callbackOrOpts === 'function') {
            customCallback = callbackOrOpts;
        } else if (callbackOrOpts && typeof callbackOrOpts === 'object') {
            opts = callbackOrOpts;
            if (typeof opts.callback === 'function') {
                customCallback = opts.callback;
            }
        }

        const isQuiet = Boolean(opts.quiet);
        const logAssembly = Boolean(opts.logAssembly); // default false: DO NOT spam on every 20ms cyclic packet!
        const logAssemblyChanges = opts.logAssemblyChanges !== undefined ? Boolean(opts.logAssemblyChanges) : false;
        const logParams = opts.logParams !== undefined ? Boolean(opts.logParams) : true;
        const logTags = opts.logTags !== undefined ? Boolean(opts.logTags) : true;

        const defaultHandler = (event) => {
            const now = new Date();
            const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
            if (event.type === 'param' && logParams) {
                const src = event.source ? (event.source === 'plc-io' ? ` [via Assembly ${event.instance}]` : ` [via ${event.source}]`) : '';
                console.log(`\x1b[36m[${time}] [PLC WRITE -> PARAM]\x1b[0m \x1b[1m${event.code}\x1b[0m ("${event.name}"): \x1b[31m${event.oldValue}\x1b[0m -> \x1b[32m${event.value}\x1b[0m ${event.units || ''}${src}`);
            } else if (event.type === 'tag' && logTags) {
                console.log(`\x1b[35m[${time}] [PLC WRITE -> TAG]\x1b[0m \x1b[1m${event.name}\x1b[0m: \x1b[31m${JSON.stringify(event.oldValue)}\x1b[0m -> \x1b[32m${JSON.stringify(event.value)}\x1b[0m`);
            } else if (event.type === 'assembly' && !isQuiet && logAssembly) {
                console.log(`\x1b[33m[${time}] [PLC WRITE -> ASSEMBLY ${event.instance}]\x1b[0m Size: ${event.length}B | Hex: \x1b[36m${event.hex}\x1b[0m`);
            } else if (event.type === 'assemblyChange' && !isQuiet && logAssemblyChanges) {
                console.log(`\x1b[33m[${time}] [PLC ASSEMBLY ${event.instance} CHANGED]\x1b[0m Size: ${event.length}B | Hex: \x1b[36m${event.hex}\x1b[0m`);
            }
        };

        const handler = customCallback || defaultHandler;

        this.on('paramWrite', (code, value, oldValue, param, source, instance) => {
            handler({
                type: 'param',
                code,
                name: param ? param.name : code,
                value,
                oldValue,
                units: param ? param.units : '',
                source: source || 'explicit',
                instance,
                timestamp: new Date()
            });
        });

        this.on('tagWrite', (name, value, oldValue) => {
            handler({
                type: 'tag',
                name,
                value,
                oldValue,
                timestamp: new Date()
            });
        });

        if (logAssembly || (customCallback && opts.logAssembly !== false)) {
            this.on('assemblyWrite', (instance, buffer, oldBuf) => {
                handler({
                    type: 'assembly',
                    instance,
                    buffer,
                    hex: buffer.toString('hex'),
                    length: buffer.length,
                    timestamp: new Date()
                });
            });
        }

        if (logAssemblyChanges) {
            this.on('assemblyChange', (instance, buffer, oldBuf) => {
                handler({
                    type: 'assemblyChange',
                    instance,
                    buffer,
                    hex: buffer.toString('hex'),
                    length: buffer.length,
                    timestamp: new Date()
                });
            });
        }

        return this;
    }
}

module.exports = { DeviceBuilder, EIPDeviceBuilder: DeviceBuilder };

