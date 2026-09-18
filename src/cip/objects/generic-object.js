'use strict';

/**
 * Generic Extensible CIP Object Framework (OpENer-style Architecture)
 *
 * Allows developers to define any custom CIP Class ID with arbitrary instances,
 * strongly-typed attributes (INT, REAL, BOOL, STRING, SHORT_STRING, STRUCT, ARRAY, RAW Buffer),
 * and custom CIP service handlers.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class GenericCipObject {
    /**
     * @param {object} options
     * @param {number} options.classId 16-bit CIP Class ID
     * @param {number} [options.revision=1] Class Revision
     * @param {string} [options.name='GenericObject']
     */
    constructor({ classId, revision = 1, name = 'GenericObject' } = {}) {
        this.classId = classId;
        this.revision = revision;
        this.name = name;

        // Map<instanceNumber, Map<attributeNumber, { value: any, type: string, access: 'r'|'rw' }>>
        this.instances = new Map();
        // Custom service handlers: Map<serviceCode, (path, data) => { generalStatus, data }>
        this.customServices = new Map();
    }

    /**
     * Optional explicit instance creation.
     */
    addInstance(instance) {
        if (!this.instances.has(instance)) {
            this.instances.set(instance, new Map());
        }
        return this;
    }

    /**
     * Helper alias for setAttribute with flexible argument order.
     */
    registerAttribute(instance, attribute, type, value, options = {}) {
        const access = (typeof options === 'string' ? options : (options.access || 'rw')).toLowerCase();
        return this.setAttribute(instance, attribute, value, type, access);
    }

    /**
     * Defines or updates an attribute on an instance.
     *
     * @param {number} instance 1..N
     * @param {number} attribute 1..N
     * @param {any} value Value (primitive, string, Buffer, or array/object for struct)
     * @param {string} [type='INT'] 'BOOL'|'SINT'|'INT'|'DINT'|'USINT'|'UINT'|'UDINT'|'REAL'|'STRING'|'SHORT_STRING'|'RAW'|'STRUCT'
     * @param {'r'|'rw'} [access='rw'] Access rule
     */
    setAttribute(instance, attribute, value, type = 'INT', access = 'rw') {
        if (!this.instances.has(instance)) {
            this.instances.set(instance, new Map());
        }
        this.instances.get(instance).set(attribute, { value, type: type.toUpperCase(), access });
        return this;
    }

    getAttribute(instance, attribute) {
        const instMap = this.instances.get(instance);
        if (!instMap) return undefined;
        const entry = instMap.get(attribute);
        return entry ? entry.value : undefined;
    }

    registerService(serviceCode, handlerFn) {
        this.customServices.set(serviceCode, handlerFn);
        return this;
    }

    _encodeValue(val, type) {
        if (Buffer.isBuffer(val)) return val;

        switch (type) {
            case 'BOOL':
            case 'USINT':
            case 'BYTE': {
                const b = Buffer.alloc(1);
                b.writeUInt8(Boolean(val) ? (typeof val === 'number' ? val : 1) : 0, 0);
                return b;
            }
            case 'SINT': {
                const b = Buffer.alloc(1);
                b.writeInt8(Number(val) || 0, 0);
                return b;
            }
            case 'UINT':
            case 'WORD': {
                const b = Buffer.alloc(2);
                b.writeUInt16LE(Number(val) || 0, 0);
                return b;
            }
            case 'INT': {
                const b = Buffer.alloc(2);
                b.writeInt16LE(Number(val) || 0, 0);
                return b;
            }
            case 'UDINT':
            case 'DWORD': {
                const b = Buffer.alloc(4);
                b.writeUInt32LE(Number(val) >>> 0, 0);
                return b;
            }
            case 'DINT': {
                const b = Buffer.alloc(4);
                b.writeInt32LE(Number(val) || 0, 0);
                return b;
            }
            case 'REAL': {
                const b = Buffer.alloc(4);
                b.writeFloatLE(Number(val) || 0.0, 0);
                return b;
            }
            case 'SHORT_STRING': {
                const str = String(val || '');
                const strBuf = Buffer.from(str, 'ascii');
                const lenBuf = Buffer.from([strBuf.length & 0xff]);
                return Buffer.concat([lenBuf, strBuf]);
            }
            case 'STRING': {
                const str = String(val || '');
                const strBuf = Buffer.from(str, 'ascii');
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeUInt16LE(strBuf.length, 0);
                const pad = (strBuf.length % 2 !== 0) ? Buffer.alloc(1) : Buffer.alloc(0);
                return Buffer.concat([lenBuf, strBuf, pad]);
            }
            case 'STRUCT':
            case 'RAW': {
                if (Array.isArray(val)) {
                    return Buffer.concat(val.map(item => this._encodeValue(item.value, item.type)));
                }
                return Buffer.from(val || []);
            }
            default:
                return Buffer.from(val || []);
        }
    }

    _decodeValue(buf, type) {
        if (!buf || buf.length === 0) return null;
        switch (type) {
            case 'BOOL':
            case 'USINT':
            case 'BYTE': return buf.readUInt8(0);
            case 'SINT': return buf.readInt8(0);
            case 'UINT':
            case 'WORD': return buf.length >= 2 ? buf.readUInt16LE(0) : 0;
            case 'INT': return buf.length >= 2 ? buf.readInt16LE(0) : 0;
            case 'UDINT':
            case 'DWORD': return buf.length >= 4 ? buf.readUInt32LE(0) : 0;
            case 'DINT': return buf.length >= 4 ? buf.readInt32LE(0) : 0;
            case 'REAL': return buf.length >= 4 ? buf.readFloatLE(0) : 0.0;
            case 'SHORT_STRING': {
                const len = buf.readUInt8(0);
                return buf.subarray(1, 1 + len).toString('ascii');
            }
            case 'STRING': {
                if (buf.length < 2) return '';
                const len = buf.readUInt16LE(0);
                return buf.subarray(2, 2 + len).toString('ascii');
            }
            default:
                return buf;
        }
    }

    getAttributeSingle(instance, attribute) {
        if (instance === 0) {
            switch (attribute) {
                case 1: { // Revision
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(this.revision, 0);
                    return ok(b);
                }
                case 2: { // Max Instance
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(Math.max(1, this.instances.size), 0);
                    return ok(b);
                }
                case 3: { // Number of Instances
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(this.instances.size, 0);
                    return ok(b);
                }
                default:
                    return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
            }
        }

        const instMap = this.instances.get(instance);
        if (!instMap) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        const entry = instMap.get(attribute);
        if (!entry) {
            return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }

        return ok(this._encodeValue(entry.value, entry.type));
    }

    setAttributeSingle(instance, attribute, data) {
        if (instance === 0) {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        const instMap = this.instances.get(instance);
        if (!instMap) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        const entry = instMap.get(attribute);
        if (!entry) {
            return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }

        if (entry.access !== 'rw') {
            return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }

        entry.value = this._decodeValue(data, entry.type);
        return ok(Buffer.alloc(0));
    }

    getAttributesAll(instance) {
        if (instance === 0) {
            const b = Buffer.alloc(6);
            b.writeUInt16LE(this.revision, 0);
            b.writeUInt16LE(Math.max(1, this.instances.size), 2);
            b.writeUInt16LE(this.instances.size, 4);
            return ok(b);
        }

        const instMap = this.instances.get(instance);
        if (!instMap) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        const sortedAttrs = Array.from(instMap.keys()).sort((a, b) => a - b);
        const chunks = [];
        for (const attr of sortedAttrs) {
            const entry = instMap.get(attr);
            chunks.push(this._encodeValue(entry.value, entry.type));
        }
        return ok(Buffer.concat(chunks));
    }

    handleService(service, path, data) {
        const custom = this.customServices.get(service);
        if (typeof custom === 'function') {
            return custom(path, data);
        }
        return { generalStatus: CipGeneralStatus.ServiceNotSupported, data: Buffer.alloc(0) };
    }
}

module.exports = { GenericCipObject };
