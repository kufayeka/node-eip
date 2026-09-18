'use strict';

/**
 * Universal EDS to DeviceProfile Generator
 *
 * Translates ODVA Standard Electronic Data Sheet (EDS) files into production-ready
 * declarative DeviceProfile instances and JavaScript profile files.
 *
 * Supports:
 * - Comprehensive parameter extraction ([Params] -> CIP Class 0x0F Parameter Object or Link Path)
 * - Flexible parameter lookup by Code ('01-00'), ID (1, 2), or Name ('Output Frequency')
 * - Assembly structure extraction and structured object decoding/encoding
 * - ODVA AC Drive standard profile template fallback (Instances 20/70, 21/71)
 * - Batch operations (CIP 0x0A) and real-time I/O connection helper
 */

const fs = require('fs');
const path = require('path');
const { EdsFile } = require('../cip/eds');
const { decodeEPath } = require('../cip/path');
const { DeviceProfile } = require('./profile');

/**
 * Maps CIP EDS Data Type code to standard CIP data type string.
 */
function mapCipDataType(typeCode, sizeBytes) {
    switch (typeCode) {
        case 0xC1: return 'BOOL';
        case 0xC2: return 'SINT';
        case 0xC3: return 'INT';
        case 0xC4: return 'DINT';
        case 0xC5: return 'LINT';
        case 0xC6: return 'USINT';
        case 0xC7: return 'UINT';
        case 0xC8: return 'UDINT';
        case 0xC9: return 'ULINT';
        case 0xCA: return 'REAL';
        case 0xCB: return 'LREAL';
        case 0xD1: return 'BYTE';
        case 0xD2: return 'WORD';
        case 0xD3: return 'DWORD';
        case 0xD4: return 'LWORD';
        case 0xD0: return 'SHORT_STRING';
        case 0xDA: return 'STRING';
        default:
            if (sizeBytes === 1) return 'USINT';
            if (sizeBytes === 2) return 'UINT';
            if (sizeBytes === 4) return 'UDINT';
            if (sizeBytes === 8) return 'ULINT';
            return 'INT';
    }
}

/**
 * Attempts to extract a parameter code (e.g. '01-00' or '01.00') from parameter name or help string.
 */
function extractParamCode(param) {
    const combined = `${param.name || ''} ${param.help || ''}`;
    const match = /\b(\d{1,3}[-.]\d{1,3})\b/.exec(combined);
    if (match) {
        return match[1].replace('.', '-');
    }
    return `P${param.id}`;
}

/**
 * Resolves parameter CIP destination (Class, Instance, Attribute).
 */
function resolveParamCipPath(param) {
    if (param.linkPath && typeof param.linkPath === 'string' && param.linkPath.trim().length > 0) {
        try {
            // Hex string e.g. "20 28 24 01 30 01"
            const hexParts = param.linkPath.trim().replace(/,/g, '').split(/\s+/).filter(Boolean);
            if (hexParts.length >= 2) {
                const rawBuf = Buffer.from(hexParts.map(h => parseInt(h, 16)));
                const decoded = decodeEPath(rawBuf);
                if (decoded && typeof decoded === 'object') {
                    return {
                        classId: decoded.classId !== undefined ? decoded.classId : 0x0F,
                        instance: decoded.instance !== undefined ? decoded.instance : param.id,
                        attribute: decoded.attribute !== undefined ? decoded.attribute : 1
                    };
                }
            }
        } catch {
            // fallback to Parameter Object
        }
    }

    // Default ODVA CIP Parameter Object: Class 0x0F, Instance = ParamId, Attribute = 1 (Value)
    return {
        classId: 0x0F,
        instance: param.id,
        attribute: 1
    };
}

/**
 * Creates a DeviceProfile directly from an EDS file instance or path.
 *
 * @param {EdsFile|string} edsSource - EdsFile instance, path to .eds file, or raw text
 * @param {object} [options]
 * @returns {DeviceProfile}
 */
function createProfileFromEds(edsSource, options = {}) {
    let eds;
    if (edsSource instanceof EdsFile) {
        eds = edsSource;
    } else if (typeof edsSource === 'string') {
        if (edsSource.includes('\n') && edsSource.includes('[')) {
            eds = EdsFile.parse(edsSource);
        } else {
            eds = EdsFile.fromFile(edsSource);
        }
    } else {
        throw new TypeError('createProfileFromEds: edsSource must be an EdsFile, file path, or EDS string');
    }

    const vendor = options.vendor || eds.device.vendorName || eds.device.vendName || `Vendor_${eds.device.vendorId || eds.device.vendCode || 'Unknown'}`;
    const model = options.model || eds.device.productName || eds.device.prodName || `Model_${eds.device.productCode || eds.device.prodCode || 'Generic'}`;
    const description = options.description || eds.file.descText || `${vendor} ${model} (Auto-generated from EDS)`;

    // Process parameters catalog
    const parameters = new Map();
    const lookupMap = new Map();

    for (const [id, param] of eds.params.entries()) {
        if (options.paramFilter && typeof options.paramFilter === 'function' && !options.paramFilter(param)) {
            continue;
        }

        const code = extractParamCode(param);
        const { classId, instance, attribute } = resolveParamCipPath(param);
        const dataType = mapCipDataType(param.dataType, param.dataSize);
        // Param Descriptor bitmap (CIP Vol 1 Appx C): bit4 (0x0010) = Read-Only.
        // There is no dedicated read-write bit -- writable is simply bit4 clear.
        // (0x0002, used here previously, is "Enumerated strings supplied" --
        // unrelated to access.)
        const access = (param.descriptor & 0x0010) ? 'r' : 'rw';

        const paramDef = {
            id,
            code,
            name: param.name || `Param${id}`,
            classId,
            instance,
            attribute,
            dataType,
            byteWidth: param.dataSize || 2,
            units: param.units || '',
            help: param.help || '',
            min: param.min,
            max: param.max,
            default: param.default,
            access
        };

        parameters.set(id, paramDef);

        // Register lookups: by ID, by code, and by sanitized name
        lookupMap.set(String(id), paramDef);
        lookupMap.set(code.toUpperCase(), paramDef);
        if (param.name) {
            lookupMap.set(param.name.toUpperCase(), paramDef);
            const sanitized = param.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (sanitized) lookupMap.set(sanitized, paramDef);

            // Also register bare name without parameter code prefix (e.g. '01-01 Output Current' -> 'Output Current')
            const bareName = param.name.replace(/^\d{1,3}[-.]\d{1,3}\s*/, '').trim();
            if (bareName) {
                lookupMap.set(bareName.toUpperCase(), paramDef);
                const bareSanitized = bareName.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                if (bareSanitized) lookupMap.set(bareSanitized, paramDef);
            }
        }
    }

    // Process Assemblies (Input, Output, Config)
    const assemblies = {
        input: null,
        output: null,
        config: null,
        all: []
    };

    for (const [id, assem] of eds.assemblies.entries()) {
        const assemInfo = {
            id,
            name: assem.name,
            size: assem.size,
            members: assem.members || []
        };
        assemblies.all.push(assemInfo);

        const lowerName = (assem.name || '').toLowerCase();
        if (id === 70 || id === 71 || id === 101) {
            if (!assemblies.input) assemblies.input = assemInfo;
        } else if (id === 20 || id === 21 || id === 100) {
            if (!assemblies.output) assemblies.output = assemInfo;
        } else if (lowerName.includes('ctrl') || lowerName.includes('consume') || (lowerName.includes('output') && !lowerName.includes('status'))) {
            if (!assemblies.output) assemblies.output = assemInfo;
        } else if (lowerName.includes('stat') || lowerName.includes('produce') || (lowerName.includes('input') && !lowerName.includes('control'))) {
            if (!assemblies.input) assemblies.input = assemInfo;
        } else if (lowerName.includes('config') || id === 128) {
            if (!assemblies.config) assemblies.config = assemInfo;
        }
    }

    // Define registers schema
    const registers = {
        PARAM: {
            classId: 0x0F,
            description: 'Universal Parameter Access (by code, id, or name)',
            access: 'rw',
            resolve: (key, opts) => {
                const query = String(key).trim().toUpperCase();
                const found = lookupMap.get(query);
                if (!found) {
                    throw new Error(`Parameter "${key}" not found in EDS profile for ${vendor} ${model}`);
                }
                return {
                    classId: found.classId,
                    instance: found.instance,
                    attribute: found.attribute,
                    dataType: found.dataType,
                    byteWidth: found.byteWidth,
                    access: found.access
                };
            }
        }
    };

    // Custom helper methods
    const customMethods = {
        readParam: (target, key) => target.read('PARAM', key),
        writeParam: (target, key, value) => target.write('PARAM', key, value),
        getParamInfo: (target, key) => {
            const query = String(key).trim().toUpperCase();
            const found = lookupMap.get(query);
            if (!found) return null;
            return { ...found };
        },
        listParams: (target) => {
            return Array.from(parameters.values()).map(p => ({
                id: p.id,
                code: p.code,
                name: p.name,
                units: p.units,
                dataType: p.dataType,
                access: p.access
            }));
        },
        /**
         * Decodes raw input assembly buffer into a structured object.
         */
        decodeInputAssembly: (target, buffer) => {
            if (!Buffer.isBuffer(buffer)) return {};
            const inputAssem = assemblies.input;
            const result = {};

            // 1. If EDS explicitly defined Member mappings
            if (inputAssem && inputAssem.members && inputAssem.members.length > 0) {
                for (const mem of inputAssem.members) {
                    const byteOffset = Math.floor(mem.bitOffset / 8);
                    const paramDef = mem.paramId ? parameters.get(mem.paramId) : null;
                    const fieldName = paramDef ? paramDef.code : `member_${mem.index}`;
                    if (byteOffset + 2 <= buffer.length) {
                        result[fieldName] = buffer.readUInt16LE(byteOffset);
                    }
                }
                return result;
            }

            // 2. Standard ODVA AC Drive Profile Instance 70 (Basic Speed Status)
            if (inputAssem && inputAssem.id === 70 && buffer.length >= 4) {
                const statusByte = buffer[0];
                return {
                    statusWord: statusByte,
                    faulted: Boolean(statusByte & 0x01),
                    warning: Boolean(statusByte & 0x02),
                    runningFwd: Boolean(statusByte & 0x04),
                    ready: Boolean(statusByte & 0x08),
                    actualSpeed: buffer.readInt16LE(2)
                };
            }

            // 3. Fallback: Word array
            result.raw = buffer;
            const words = [];
            for (let i = 0; i + 2 <= buffer.length; i += 2) {
                words.push(buffer.readInt16LE(i));
            }
            result.words = words;
            return result;
        },
        /**
         * Encodes structured object into output assembly buffer.
         */
        encodeOutputAssembly: (target, data) => {
            const outAssem = assemblies.output;
            const size = outAssem ? outAssem.size : 4;
            const buf = Buffer.alloc(size);

            if (outAssem && outAssem.id === 20) {
                // ODVA AC Drive Instance 20
                let controlWord = 0;
                if (data.runFwd) controlWord |= 0x01;
                if (data.faultReset) controlWord |= 0x04;
                if (data.controlWord !== undefined) controlWord = data.controlWord;
                buf[0] = controlWord;

                if (data.speedReference !== undefined) {
                    buf.writeInt16LE(Math.round(data.speedReference), 2);
                }
                return buf;
            }

            if (Buffer.isBuffer(data)) return data;
            if (Array.isArray(data.words)) {
                data.words.forEach((w, idx) => {
                    if (idx * 2 + 2 <= buf.length) buf.writeInt16LE(w, idx * 2);
                });
            }
            return buf;
        }
    };

    return new DeviceProfile({
        vendor,
        model,
        description,
        capabilities: {
            multipleServicePacket: true,
            class1IO: Boolean(assemblies.input && assemblies.output)
        },
        registers,
        customMethods
    });
}

/**
 * Generates standalone JavaScript profile source code from an EDS file.
 *
 * @param {EdsFile|string} edsSource
 * @param {object} [options]
 * @returns {string} Generated JavaScript code
 */
function generateProfileCodeFromEds(edsSource, options = {}) {
    let eds;
    if (edsSource instanceof EdsFile) {
        eds = edsSource;
    } else if (typeof edsSource === 'string') {
        if (edsSource.includes('\n') && edsSource.includes('[')) {
            eds = EdsFile.parse(edsSource);
        } else {
            eds = EdsFile.fromFile(edsSource);
        }
    } else {
        throw new TypeError('generateProfileCodeFromEds: edsSource must be an EdsFile, file path, or EDS string');
    }

    const vendor = options.vendor || eds.device.vendorName || eds.device.vendName || `Vendor_${eds.device.vendorId || eds.device.vendCode || 'Unknown'}`;
    const model = options.model || eds.device.productName || eds.device.prodName || `Model_${eds.device.productCode || eds.device.prodCode || 'Generic'}`;
    const safeModelVar = model.replace(/[^A-Za-z0-9]/g, '_').toLowerCase();

    const paramEntries = [];
    for (const [id, param] of eds.params.entries()) {
        const code = extractParamCode(param);
        const { classId, instance, attribute } = resolveParamCipPath(param);
        const dataType = mapCipDataType(param.dataType, param.dataSize);
        const access = (param.descriptor & 0x0010) ? 'r' : 'rw'; // bit4 = Read-Only

        paramEntries.push(`        '${code}': { id: ${id}, code: '${code}', name: ${JSON.stringify(param.name || `Param${id}`)}, classId: 0x${classId.toString(16).toUpperCase()}, instance: ${instance}, attribute: ${attribute}, dataType: '${dataType}', byteWidth: ${param.dataSize || 2}, units: ${JSON.stringify(param.units || '')}, min: ${param.min || 0}, max: ${param.max || 0}, access: '${access}' }`);
    }

    return `'use strict';

/**
 * Auto-generated DeviceProfile for ${vendor} ${model}
 * Generated from EDS by @kufayeka/ethernet-ip
 */

const { DeviceProfile } = require('../../../device/profile');

const paramCatalog = {
${paramEntries.slice(0, 500).join(',\n')}
};

const lookup = new Map();
for (const p of Object.values(paramCatalog)) {
    lookup.set(String(p.id), p);
    lookup.set(p.code.toUpperCase(), p);
    lookup.set(p.name.toUpperCase(), p);
    lookup.set(p.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), p);
    const bareName = p.name.replace(/^\\d{1,3}[-.]\\d{1,3}\\s*/, '').trim();
    if (bareName) {
        lookup.set(bareName.toUpperCase(), p);
        lookup.set(bareName.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), p);
    }
}

const ${safeModelVar}Profile = new DeviceProfile({
    vendor: ${JSON.stringify(vendor)},
    model: ${JSON.stringify(model)},
    description: ${JSON.stringify(eds.file.descText || `${vendor} ${model} EDS Profile`)},
    capabilities: {
        multipleServicePacket: true,
        class1IO: true
    },
    registers: {
        PARAM: {
            classId: 0x0F,
            description: 'Universal Parameter Access',
            access: 'rw',
            resolve: (key) => {
                const query = String(key).trim().toUpperCase();
                const p = lookup.get(query);
                if (!p) throw new Error('Parameter "' + key + '" not found in profile');
                return {
                    classId: p.classId,
                    instance: p.instance,
                    attribute: p.attribute,
                    dataType: p.dataType,
                    byteWidth: p.byteWidth,
                    access: p.access
                };
            }
        }
    },
    customMethods: {
        readParam: (target, key) => target.read('PARAM', key),
        writeParam: (target, key, value) => target.write('PARAM', key, value),
        getParamInfo: (target, key) => {
            const p = lookup.get(String(key).trim().toUpperCase());
            return p ? { ...p } : null;
        }
    }
});

module.exports = {
    ${safeModelVar}Profile,
    paramCatalog
};
`;
}

module.exports = {
    createProfileFromEds,
    generateProfileCodeFromEds,
    mapCipDataType,
    extractParamCode,
    resolveParamCipPath
};
