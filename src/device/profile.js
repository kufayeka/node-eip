'use strict';

/**
 * Universal CIP Device Profile Contract
 *
 * Encapsulates the specific CIP object dictionary, addressing conventions,
 * data types, and capabilities for a specific PLC family or model.
 *
 * Free of any hardcoded vendor logic or ad-hoc if/else checks.
 */

const { encodeType, decodeType } = require('../cip/types');
const { encodeEPath } = require('../cip/path');

class DeviceProfile {
    constructor(config) {
        if (!config || typeof config !== 'object') {
            throw new TypeError('DeviceProfile: config object is required');
        }
        if (!config.vendor || !config.model) {
            throw new TypeError('DeviceProfile: vendor and model are required strings');
        }

        this.vendor = config.vendor;
        this.family = config.family || config.vendor;
        this.model = config.model;
        this.description = config.description || `${this.vendor} ${this.model}`;
        this.name = config.name || this.description;
        // Extra lookup keys for registerProfile() (src/device/registry.js), beyond the automatic
        // "<vendor>:<model>" and bare "<model>" keys it always registers -- e.g. alternate model
        // names/spellings ('es2e', 'se2') or a vendor:alias shorthand ('rockwell:logix'). This was
        // read by registerProfile() but never actually set here, so every profile's own declared
        // `aliases` silently did nothing; only the automatic vendor:model/model keys ever worked.
        this.aliases = Array.isArray(config.aliases) ? config.aliases.map(String) : [];

        this.capabilities = Object.freeze({
            multipleServicePacket: config.capabilities?.multipleServicePacket !== false,
            symbolicTags: Boolean(config.capabilities?.symbolicTags),
            class1IO: Boolean(config.capabilities?.class1IO),
            ...config.capabilities
        });

        this.registers = {};
        if (config.registers && typeof config.registers === 'object') {
            for (const [key, regDef] of Object.entries(config.registers)) {
                this.registers[key.toUpperCase()] = this._normalizeRegisterDef(key.toUpperCase(), regDef);
            }
        }

        this.customMethods = config.customMethods || {};
    }

    _normalizeRegisterDef(name, def) {
        if (typeof def !== 'object' || def === null) {
            throw new TypeError(`Register definition for "${name}" must be an object`);
        }
        return {
            name,
            description: def.description || `${name} Register`,
            classId: def.classId,
            instance: def.instance !== undefined ? def.instance : 1,
            bitInstance: def.bitInstance !== undefined ? def.bitInstance : 1,
            attribute: def.attribute,
            dataType: def.dataType || (def.isBit ? 'BOOL' : 'INT'),
            access: def.access || 'rw', // 'r', 'w', 'rw'
            isBit: Boolean(def.isBit),
            isWord: def.isWord !== undefined ? def.isWord : !def.isBit,
            isScalar: Boolean(def.isScalar),
            units: def.units || '',
            octal: Boolean(def.octal),
            range: def.range || null,
            resolve: def.resolve || null // dynamic resolver fn(index, mode) => { classId, instance, attribute, dataType, byteWidth }
        };
    }

    hasRegister(name) {
        return Boolean(this.registers[String(name).toUpperCase()]);
    }

    getRegister(name) {
        const key = String(name).toUpperCase();
        const reg = this.registers[key];
        if (!reg) {
            const available = Object.keys(this.registers).join(', ') || '(none)';
            throw new Error(`Register "${name}" is not supported on ${this.vendor} ${this.model}. Supported registers: ${available}`);
        }
        return reg;
    }

    listRegisters() {
        return Object.keys(this.registers);
    }

    /**
     * Resolves an address into CIP Class, Instance, Attribute and Data Type.
     *
     * @param {string} regName - e.g. 'D', 'Y', 'X', 'C'
     * @param {number|string} indexOrLabel - number or label (e.g. 0, 'Y10')
     * @param {object} [options]
     * @param {'word'|'bit'} [options.mode] - access mode
     * @param {number} [options.bitIndex] - bit offset if accessing bit inside word
     * @returns {{ classId: number, instance: number, attribute: number, dataType: string, byteWidth: number, access: string, isBit: boolean }}
     */
    resolveAddress(regName, indexOrLabel, options = {}) {
        const reg = this.getRegister(regName);
        let index = indexOrLabel;

        if (reg.isScalar && index === undefined) {
            index = 0;
        }

        // Custom dynamic resolver (e.g. PARAM register or dynamic attribute/instance logic)
        if (typeof reg.resolve === 'function') {
            const resolved = reg.resolve(index, options);
            return {
                classId: resolved.classId !== undefined ? resolved.classId : reg.classId,
                instance: resolved.instance !== undefined ? resolved.instance : (typeof reg.instance === 'function' ? reg.instance(index) : reg.instance),
                attribute: resolved.attribute !== undefined ? resolved.attribute : index,
                dataType: resolved.dataType || reg.dataType,
                byteWidth: resolved.byteWidth || (resolved.dataType === 'DINT' ? 4 : 2),
                access: resolved.access || reg.access,
                isBit: resolved.isBit !== undefined ? resolved.isBit : reg.isBit
            };
        }

        if (typeof index === 'string') {
            if (reg.octal) {
                index = this.parseOctalLabel(index);
            } else {
                index = parseInt(index, 10);
            }
        }

        const isBitMode = options.mode === 'bit' || (reg.isBit && options.mode !== 'word');
        const hasBitIndex = options.bitIndex !== undefined;
        let max = reg.range ? reg.range[1] : null;
        if (isBitMode && reg.bitInstance && !hasBitIndex) {
            max = reg.bitRange ? reg.bitRange[1] : (reg.range[1] + 1) * 16 - 1;
        }

        if (reg.range && !reg.isScalar && max !== null && (index < reg.range[0] || index > max)) {
            throw new RangeError(`Address ${index} is out of range [${reg.range[0]}..${max}] for register ${regName}`);
        }

        const instance = isBitMode
            ? (typeof reg.bitInstance === 'function' ? reg.bitInstance(index) : reg.bitInstance)
            : (typeof reg.instance === 'function' ? reg.instance(index) : reg.instance);

        let attribute = reg.attribute !== undefined
            ? (typeof reg.attribute === 'function' ? reg.attribute(index) : reg.attribute)
            : index;

        if (options.bitIndex !== undefined) {
            // Word + bit index (e.g. D100.5)
            attribute = index * 16 + options.bitIndex;
        }

        const dataType = isBitMode ? 'BOOL' : reg.dataType;
        const byteWidth = dataType === 'BOOL' ? 1 : (dataType === 'DINT' || dataType === 'UDINT' || dataType === 'REAL' ? 4 : 2);

        return {
            classId: reg.classId,
            instance,
            attribute,
            dataType,
            byteWidth,
            access: reg.access,
            isBit: isBitMode
        };
    }

    parseOctalLabel(label) {
        const match = /^[A-Za-z]*([0-7]+)$/.exec(String(label).trim());
        if (!match) {
            throw new RangeError(`"${label}" is not a valid octal I/O label (valid digits 0-7)`);
        }
        return parseInt(match[1], 8);
    }

    encodeValue(resolved, value) {
        if (resolved.access === 'r') {
            throw new Error(`Register is read-only`);
        }
        return encodeType(resolved.dataType, value);
    }

    decodeValue(resolved, buffer) {
        const decoded = decodeType(resolved.dataType, buffer, 0);
        return decoded && typeof decoded === 'object' && 'value' in decoded ? decoded.value : decoded;
    }
}

DeviceProfile.fromEds = function (edsSource, options) {
    const { createProfileFromEds } = require('./eds-generator');
    return createProfileFromEds(edsSource, options);
};

DeviceProfile.generateCodeFromEds = function (edsSource, options) {
    const { generateProfileCodeFromEds } = require('./eds-generator');
    return generateProfileCodeFromEds(edsSource, options);
};

module.exports = { DeviceProfile };

