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
        this.identity = {
            vendorId: options.vendorId !== undefined ? options.vendorId : 0x1337,
            vendorName: options.vendorName || 'Kufayeka Automation',
            productCode: options.productCode !== undefined ? options.productCode : 1,
            productName: options.productName || 'Virtual EIP Device',
            deviceType: typeof options.deviceType === 'number' ? options.deviceType : this._resolveDeviceTypeCode(options.deviceType),
            deviceTypeStr: typeof options.deviceType === 'string' ? options.deviceType : 'Generic Device',
            revision: options.revision || { major: 1, minor: 0 },
            serialNumber: options.serialNumber || (Math.floor(Math.random() * 0x7FFFFFFF) + 1)
        };

        this.description = options.description || `${this.identity.vendorName} ${this.identity.productName}`;
        this.parameterObject = new ParameterObject();
        this.params = [];
        this.tags = new Map(); // tagName -> { type, value }
        this.assemblies = [];

        // Forward parameter changes and writes
        this.parameterObject.on('change', (param, newVal, oldVal) => {
            this.emit('paramChange', param.code || param.id, newVal, oldVal, param);
        });
        this.parameterObject.on('write', (param, newVal, oldVal) => {
            this.emit('paramWrite', param.code || param.id, newVal, oldVal, param);
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
     * Generates a 100% compliant ODVA Electronic Data Sheet (.eds) text.
     *
     * @returns {string} Official EDS text
     */
    generateEds() {
        return exportToEds({
            identity: this.identity,
            description: this.description,
            params: this.params,
            assemblies: this.assemblies
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
        });
        adapter.assembly.on('write', (instance, current, oldBuf) => {
            this.emit('assemblyWrite', instance, current, oldBuf);
        });

        // 3. Register Assemblies
        for (const assem of this.assemblies) {
            adapter.defineAssembly(assem.instance, assem.sizeBytes);
        }

        this.adapter = adapter;
        return adapter;
    }

    /**
     * Real-time watcher for all incoming write events from PLCs / Scanners.
     * Captures parameter writes, symbolic tag writes, and assembly data writes.
     *
     * @param {function(object): void} [callback] - Optional custom event handler. If omitted, prints formatted console logs.
     * @returns {DeviceBuilder}
     */
    watch(callback) {
        const handler = callback || ((event) => {
            const now = new Date();
            const time = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
            if (event.type === 'param') {
                console.log(`\x1b[36m[${time}] [PLC WRITE -> PARAM]\x1b[0m \x1b[1m${event.code}\x1b[0m ("${event.name}"): \x1b[31m${event.oldValue}\x1b[0m -> \x1b[32m${event.value}\x1b[0m ${event.units || ''}`);
            } else if (event.type === 'tag') {
                console.log(`\x1b[35m[${time}] [PLC WRITE -> TAG]\x1b[0m \x1b[1m${event.name}\x1b[0m: \x1b[31m${JSON.stringify(event.oldValue)}\x1b[0m -> \x1b[32m${JSON.stringify(event.value)}\x1b[0m`);
            } else if (event.type === 'assembly') {
                console.log(`\x1b[33m[${time}] [PLC WRITE -> ASSEMBLY ${event.instance}]\x1b[0m Size: ${event.length}B | Hex: \x1b[36m${event.hex}\x1b[0m`);
            }
        });

        this.on('paramWrite', (code, value, oldValue, param) => {
            handler({
                type: 'param',
                code,
                name: param ? param.name : code,
                value,
                oldValue,
                units: param ? param.units : '',
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

        return this;
    }
}

module.exports = { DeviceBuilder, EIPDeviceBuilder: DeviceBuilder };

