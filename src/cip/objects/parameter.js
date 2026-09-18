'use strict';

/**
 * Server-side Parameter Object (Class 0x0F) — CIP Vol 1, section 5-15.
 *
 * Provides a standardized interface for configuration parameters in EtherNet/IP
 * adapters, inverters, and virtual devices.
 *
 * Each Parameter instance represents a named setting or measured value:
 * - Attr 1: Value (encapsulated binary data per data type)
 * - Attr 2: Link Path Size
 * - Attr 3: Link Path
 * - Attr 4: Descriptor (bitmask, CIP Vol 1 Appx C: bit0 = Supports Settable
 *   Path, bit1 = Enumerated strings supplied, bit4 (0x0010) = Read-Only.
 *   There is no dedicated "read-write" bit — writable is simply bit4 clear.)
 * - Attr 5: Data Type (CIP elementary data type code)
 * - Attr 6: Data Size (size in bytes)
 */

const { EventEmitter } = require('events');
const { CipGeneralStatus } = require('../../constants');
const { encodeType, decodeType, getCipTypeInfo, CipDataTypeCode } = require('../types');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class ParameterObject extends EventEmitter {
    constructor() {
        super();
        this.params = new Map(); // id (number) -> paramDef
        this.codeMap = new Map(); // code/name (uppercase) -> paramDef
        this._nextId = 1;
    }

    /**
     * Defines a new parameter in the Parameter Object.
     *
     * @param {object} options
     * @param {number} [options.id] - Optional explicit numeric ID (1-based)
     * @param {string} [options.code] - Parameter code e.g. '01-00'
     * @param {string} [options.name] - Parameter descriptive name e.g. 'Max Frequency'
     * @param {string} [options.dataType='INT'] - CIP type string (e.g. 'INT', 'REAL', 'UDINT')
     * @param {'r'|'w'|'rw'} [options.access='rw'] - Access permissions
     * @param {string} [options.units=''] - Engineering units e.g. 'Hz', 'RPM', '°C'
     * @param {string} [options.help=''] - Descriptive help text
     * @param {number} [options.min=0] - Minimum allowable value
     * @param {number} [options.max=65535] - Maximum allowable value
     * @param {number} [options.default=0] - Default value
     * @param {any} [options.value] - Initial value (defaults to options.default)
     * @param {string} [options.linkPath=''] - Optional CIP EPATH hex string
     * @returns {object} The registered parameter definition
     */
    addParam(options = {}) {
        const id = options.id || this._nextId++;
        if (id >= this._nextId) {
            this._nextId = id + 1;
        }

        const dataType = (options.dataType || 'INT').toUpperCase();
        const typeInfo = getCipTypeInfo(dataType);
        const defVal = options.default !== undefined ? options.default : 0;
        const initialVal = options.value !== undefined ? options.value : defVal;
        const buffer = encodeType(dataType, initialVal);
        const byteSize = typeInfo ? typeInfo.size : buffer.length;
        const typeCode = typeInfo ? typeInfo.code : CipDataTypeCode.INT;

        const code = options.code || `P${id}`;
        const name = options.name || `Param${id}`;
        const access = (options.access || 'rw').toLowerCase();

        const param = {
            id,
            code,
            name,
            dataType,
            typeCode,
            byteSize,
            access,
            units: options.units || '',
            help: options.help || '',
            min: options.min !== undefined ? options.min : 0,
            max: options.max !== undefined ? options.max : 65535,
            default: defVal,
            value: initialVal,
            buffer,
            linkPath: options.linkPath || ''
        };

        this.params.set(id, param);
        this.codeMap.set(String(id), param);
        this.codeMap.set(code.toUpperCase(), param);
        this.codeMap.set(name.toUpperCase(), param);

        const sanitized = name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (sanitized) this.codeMap.set(sanitized, param);

        return param;
    }

    /**
     * Retrieves parameter definition by ID, code, or name.
     */
    getParam(key) {
        if (typeof key === 'number') {
            return this.params.get(key) || null;
        }
        return this.codeMap.get(String(key).trim().toUpperCase()) || null;
    }

    /**
     * Gets parameter value directly.
     */
    getValue(key) {
        const param = this.getParam(key);
        return param ? param.value : undefined;
    }

    /**
     * Sets parameter value directly and updates internal buffer.
     */
    setValue(key, value) {
        const param = this.getParam(key);
        if (!param) {
            throw new Error(`ParameterObject: parameter "${key}" not found`);
        }
        const oldVal = param.value;
        param.value = value;
        param.buffer = encodeType(param.dataType, value);
        this.emit('change', param, value, oldVal);
        this.emit('write', param, value, oldVal);
        return this;
    }

    /**
     * Handles CIP Get_Attribute_Single service (0x0E).
     */
    getAttributeSingle(instance, attribute) {
        if (instance === 0) {
            // Class Attributes
            switch (attribute) {
                case 1: { // Revision
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                case 2: { // Max Instance
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(this.params.size, 0);
                    return ok(b);
                }
                default:
                    return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
            }
        }

        const param = this.params.get(instance);
        if (!param) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        switch (attribute) {
            case 1: // Value
                return ok(param.buffer);
            case 2: { // Link Path Size (in 16-bit words)
                const pathBuf = param.linkPath ? Buffer.from(param.linkPath.replace(/\s+/g, ''), 'hex') : Buffer.alloc(0);
                const b = Buffer.alloc(2);
                b.writeUInt16LE(Math.ceil(pathBuf.length / 2), 0);
                return ok(b);
            }
            case 3: { // Link Path
                const pathBuf = param.linkPath ? Buffer.from(param.linkPath.replace(/\s+/g, ''), 'hex') : Buffer.alloc(0);
                return ok(pathBuf);
            }
            case 4: { // Descriptor
                const b = Buffer.alloc(2);
                const descriptor = (param.access === 'r') ? 0x0010 : 0x0000; // bit4 = Read-Only
                b.writeUInt16LE(descriptor, 0);
                return ok(b);
            }
            case 5: { // Data Type
                const b = Buffer.alloc(2);
                b.writeUInt16LE(param.typeCode, 0);
                return ok(b);
            }
            case 6: { // Data Size
                const b = Buffer.alloc(1);
                b.writeUInt8(param.byteSize, 0);
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    /**
     * Handles CIP Set_Attribute_Single service (0x10).
     */
    setAttributeSingle(instance, attribute, data) {
        if (instance === 0) {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        const param = this.params.get(instance);
        if (!param) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        if (attribute !== 1) {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        if (param.access === 'r') {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        if (!data || data.length < param.byteSize) {
            return { generalStatus: CipGeneralStatus.NotEnoughData, data: Buffer.alloc(0) };
        }

        const decoded = decodeType(param.dataType, data, 0);
        const oldVal = param.value;
        param.value = decoded.value;
        param.buffer = Buffer.from(data.subarray(0, param.byteSize));

        this.emit('change', param, param.value, oldVal);
        this.emit('write', param, param.value, oldVal);
        return ok(Buffer.alloc(0));
    }
}

module.exports = { ParameterObject };
