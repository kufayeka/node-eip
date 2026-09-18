'use strict';

/**
 * ODVA Standard Electronic Data Sheet (EDS) File Parser — CIP Vol 1, Chapter 7.
 *
 * Implements standard parser for CIP device EDS files:
 * - Strips comments ('$' to end of line).
 * - Handles multiline statements terminated by ';'.
 * - Parses integers in decimal, hex ('0x...' or '16#...'), and binary ('2#...').
 * - Parses quoted strings and handles empty values (',,').
 * - Extracts [File], [Device], [Params], [Assembly], and [Connection Manager] sections.
 * - Decodes Connection Manager EPATH paths into Assembly instance endpoints.
 * - Automatically produces Forward_Open / Large_Forward_Open parameters for Scanners.
 */

const fs = require('fs');
const { decodeEPath, encodeAssemblyConnectionPath } = require('./path');

/**
 * Strips comments from EDS text while preserving string literals.
 * Comments start with '$' outside double-quoted strings.
 *
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
    let result = '';
    let inQuotes = false;
    let inComment = false;
    const len = text.length;

    for (let i = 0; i < len; i++) {
        const ch = text[i];

        if (inComment) {
            if (ch === '\n') {
                inComment = false;
                result += '\n';
            }
            continue;
        }

        if (ch === '"') {
            inQuotes = !inQuotes;
            result += ch;
            continue;
        }

        if (ch === '$' && !inQuotes) {
            inComment = true;
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Parses numeric literals in decimal, hex ('0x...' or '16#...'), or binary ('2#...').
 * Returns original string if not a number.
 *
 * @param {string} token
 * @returns {number|string}
 */
function parseLiteral(token) {
    if (typeof token !== 'string') return token;
    const str = token.trim();
    if (str === '') return '';

    // Quoted string
    if (str.startsWith('"') && str.endsWith('"')) {
        return str.slice(1, -1);
    }

    // Hex notation '16#FFFF' or '0xFFFF'
    if (/^16#[0-9a-fA-F]+$/i.test(str)) {
        return parseInt(str.slice(3), 16);
    }
    if (/^0x[0-9a-fA-F]+$/i.test(str)) {
        return parseInt(str.slice(2), 16);
    }

    // Binary notation '2#1010'
    if (/^2#[01]+$/i.test(str)) {
        return parseInt(str.slice(2), 2);
    }

    // Decimal number
    if (/^-?\d+$/.test(str)) {
        return parseInt(str, 10);
    }
    if (/^-?\d+\.\d+$/.test(str)) {
        return parseFloat(str);
    }

    return str;
}

/**
 * Splits comma-separated values respecting double-quoted strings.
 *
 * @param {string} str
 * @returns {Array<string>}
 */
function splitCsv(str) {
    const items = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (ch === ',' && !inQuotes) {
            items.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    items.push(current.trim());
    return items;
}

/**
 * Parses an EDS file into structured sections and key-value entries.
 *
 * @param {string} edsText
 * @returns {object} Raw sections map
 */
function parseRawSections(edsText) {
    const clean = stripComments(edsText);
    const sections = {};
    let currentSectionName = 'root';
    sections[currentSectionName] = [];

    // Find section headers [Section Name]
    const lines = clean.split('\n');
    let currentStatement = '';

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
            // New section
            currentSectionName = line.slice(1, -1).trim();
            if (!sections[currentSectionName]) {
                sections[currentSectionName] = [];
            }
            continue;
        }

        currentStatement += (currentStatement ? ' ' : '') + line;

        if (currentStatement.includes(';')) {
            // Process complete statement(s)
            const parts = currentStatement.split(';');
            for (let i = 0; i < parts.length - 1; i++) {
                const stmt = parts[i].trim();
                if (stmt) {
                    sections[currentSectionName].push(stmt);
                }
            }
            currentStatement = parts[parts.length - 1].trim();
        }
    }

    // Parse statements into key-value map per section
    const parsedSections = {};
    for (const [secName, stmts] of Object.entries(sections)) {
        parsedSections[secName] = {};
        for (const stmt of stmts) {
            const eqIdx = stmt.indexOf('=');
            if (eqIdx === -1) continue;

            const key = stmt.slice(0, eqIdx).trim();
            const valueStr = stmt.slice(eqIdx + 1).trim();
            const values = splitCsv(valueStr).map(parseLiteral);

            parsedSections[secName][key] = values.length === 1 ? values[0] : values;
        }
    }

    return parsedSections;
}

/**
 * Standard CIP EDS File Representation.
 */
class EdsFile {
    /**
     * @param {object} rawSections
     */
    constructor(rawSections) {
        this.raw = rawSections;
        this.file = this._parseFileSection();
        this.device = this._parseDeviceSection();
        this.params = this._parseParamsSection();
        this.assemblies = this._parseAssemblySection();
        this.connections = this._parseConnectionManagerSection();
    }

    static parse(edsText) {
        const raw = parseRawSections(edsText);
        return new EdsFile(raw);
    }

    static fromFile(filePath, encoding = 'latin1') {
        const text = fs.readFileSync(filePath, encoding);
        return EdsFile.parse(text);
    }

    _parseFileSection() {
        const sec = this.raw['File'] || {};
        return {
            descText: sec.DescText || '',
            createDate: sec.CreateDate || '',
            createTime: sec.CreateTime || '',
            modDate: sec.ModDate || '',
            modTime: sec.ModTime || '',
            revision: sec.Revision || '',
            homeUrl: sec.HomeURL || ''
        };
    }

    _parseDeviceSection() {
        const sec = this.raw['Device'] || {};
        const majRev = typeof sec.MajRev === 'number' ? sec.MajRev : 1;
        const minRev = typeof sec.MinRev === 'number' ? sec.MinRev : 0;
        return {
            vendorId: typeof sec.VendCode === 'number' ? sec.VendCode : 0,
            vendorName: sec.VendName || '',
            deviceType: typeof sec.ProdType === 'number' ? sec.ProdType : 0,
            deviceTypeStr: sec.ProdTypeStr || '',
            productCode: typeof sec.ProdCode === 'number' ? sec.ProdCode : 0,
            majorRevision: majRev,
            minorRevision: minRev,
            revision: `${majRev}.${minRev}`,
            productName: sec.ProdName || '',
            catalog: sec.Catalog || '',
            icon: sec.Icon || ''
        };
    }

    _parseParamsSection() {
        const sec = this.raw['Params'] || {};
        const params = new Map();

        for (const [key, val] of Object.entries(sec)) {
            const match = key.match(/^Param(\d+)$/i);
            if (!match) continue;

            const id = Number(match[1]);
            const arr = Array.isArray(val) ? val : [val];

            // Standard Param layout can have either:
            // - [reserved, linkPathSize, linkPath, descriptor, dataType, dataSize, name, units, help, min, max, default] (12 fields)
            // - [reserved, linkPath, descriptor, dataType, dataSize, name, units, help, min, max, default] (11 fields)
            // - [reserved, '', '', descriptor, ...] (empty link path with two commas)
            let linkPath = '';
            let offset = 2;

            if (typeof arr[1] === 'string' && (arr[1].startsWith('20 ') || arr[1].includes(' '))) {
                offset = 1;
                linkPath = arr[1];
            } else if (typeof arr[2] === 'string' && arr[2].trim().length > 0) {
                offset = 2;
                linkPath = arr[2].trim();
            }

            const descriptorVal = arr[offset + 1];
            const dataTypeVal = arr[offset + 2];
            const dataSizeVal = arr[offset + 3];
            const nameVal = arr[offset + 4];
            const unitsVal = arr[offset + 5];
            const helpVal = arr[offset + 6];
            const minVal = arr[offset + 7];
            const maxVal = arr[offset + 8];
            const defVal = arr[offset + 9];

            params.set(id, {
                id,
                linkPath,
                descriptor: typeof descriptorVal === 'number' ? descriptorVal : 0,
                dataType: typeof dataTypeVal === 'number' ? dataTypeVal : 0,
                dataSize: typeof dataSizeVal === 'number' ? dataSizeVal : 0,
                name: typeof nameVal === 'string' ? nameVal : '',
                units: typeof unitsVal === 'string' ? unitsVal : '',
                help: typeof helpVal === 'string' ? helpVal : '',
                min: typeof minVal === 'number' ? minVal : 0,
                max: typeof maxVal === 'number' ? maxVal : 0,
                default: typeof defVal === 'number' ? defVal : 0
            });
        }


        return params;
    }

    _parseAssemblySection() {
        const sec = this.raw['Assembly'] || {};
        const assemblies = new Map();

        for (const [key, val] of Object.entries(sec)) {
            const match = key.match(/^Assem(\d+)$/i);
            if (!match) continue;

            const id = Number(match[1]);
            const arr = Array.isArray(val) ? val : [val];
            // AssemN = "Name", Path, MaxSizeInBytes, Descriptor, ...
            const name = typeof arr[0] === 'string' ? arr[0] : `Assembly ${id}`;

            const path = typeof arr[1] === 'string' ? arr[1] : '';
            const size = typeof arr[2] === 'number' ? arr[2] : 0;
            const descriptor = typeof arr[3] === 'number' ? arr[3] : 0;

            // Extract Member entries if present in EDS (either Member1 = ... or inline in AssemN)
            const members = [];
            for (let m = 1; m <= 256; m++) {
                const memVal = sec[`Member${m}`];
                if (!memVal) break;
                const memArr = Array.isArray(memVal) ? memVal : [memVal];
                let paramId = null;
                if (typeof memArr[0] === 'string') {
                    const pMatch = memArr[0].match(/Param(\d+)/i);
                    if (pMatch) paramId = Number(pMatch[1]);
                } else if (typeof memArr[0] === 'number') {
                    paramId = memArr[0];
                }

                members.push({
                    index: m,
                    paramRef: memArr[0],
                    paramId,
                    bitOffset: typeof memArr[1] === 'number' ? memArr[1] : 0,
                    bitLength: typeof memArr[2] === 'number' ? memArr[2] : 16
                });
            }

            // If no MemberN keys, check for standard inline members in AssemN statement (indices 6..)
            if (members.length === 0 && arr.length > 6) {
                let bitOffset = 0;
                let mIndex = 1;
                for (let i = 6; i + 1 < arr.length; i += 2) {
                    const bitLength = typeof arr[i] === 'number' ? arr[i] : (parseInt(arr[i], 10) || 0);
                    const paramRef = arr[i + 1];
                    let paramId = null;
                    if (typeof paramRef === 'string') {
                        const pMatch = paramRef.match(/Param(\d+)/i);
                        if (pMatch) paramId = Number(pMatch[1]);
                    } else if (typeof paramRef === 'number' && paramRef > 0) {
                        paramId = paramRef;
                    }
                    if (bitLength > 0) {
                        members.push({
                            index: mIndex++,
                            paramRef,
                            paramId,
                            bitOffset,
                            bitLength
                        });
                        bitOffset += bitLength;
                    }
                }
            }

            assemblies.set(id, {
                id,
                name,
                path,
                size,
                descriptor,
                members
            });

        }

        return assemblies;
    }


    _parseConnectionManagerSection() {
        const sec = this.raw['Connection Manager'] || {};
        const connections = [];

        for (const [key, val] of Object.entries(sec)) {
            const match = key.match(/^Connection(\d+)$/i);
            if (!match) continue;

            const id = Number(match[1]);
            const arr = Array.isArray(val) ? val : [val];

            // Connection layout:
            // 0: trigger & transport (32-bit uint)
            // 1: connection parameters (32-bit uint)
            // 2..4: O->T RPI, size, format
            // 5..7: T->O RPI, size, format
            // 8..9: Config #1 size, format
            // 10..11: Config #2 size, format
            // 12: Connection Name
            // 13: Help string
            // 14: Path string

            const triggerRaw = typeof arr[0] === 'number' ? arr[0] : 0;
            const paramsRaw = typeof arr[1] === 'number' ? arr[1] : 0;

            // Resolve name and path
            let name = `Connection${id}`;
            let pathStr = '';

            for (let i = 2; i < arr.length; i++) {
                if (typeof arr[i] === 'string' && arr[i].startsWith('20 ')) {
                    pathStr = arr[i];
                } else if (typeof arr[i] === 'string' && arr[i].toLowerCase().includes('connection')) {
                    name = arr[i];
                }
            }

            // If name is still default and string at index 12 exists:
            if (typeof arr[12] === 'string' && arr[12] && name === `Connection${id}`) {
                name = arr[12];
            }
            if (typeof arr[14] === 'string' && arr[14].length > 0) {
                pathStr = arr[14];
            }

            // Decode EPATH
            let parsedPath = null;
            let pathBuffer = null;
            if (pathStr) {
                try {
                    const hexBytes = pathStr.replace(/[^0-9a-fA-F]/g, ' ').trim().split(/\s+/).map((b) => parseInt(b, 16));
                    pathBuffer = Buffer.from(hexBytes);
                    const decoded = decodeEPath(pathBuffer);
                    const [o2tInstance, t2oInstance] = decoded.connectionPoints || [];
                    parsedPath = {
                        classId: decoded.classId,
                        configInstance: decoded.instance,
                        o2tInstance,
                        t2oInstance
                    };
                } catch {
                    // Ignore unparseable paths
                }
            }

            // Resolve RPI from Param references if available
            const resolveRpi = (token) => {
                if (typeof token === 'string') {
                    const pMatch = token.match(/^Param(\d+)$/i);
                    if (pMatch) {
                        const p = this.params.get(Number(pMatch[1]));
                        if (p) return { min: p.min, max: p.max, default: p.default };
                    }
                }
                if (typeof token === 'number') {
                    return { min: token, max: token, default: token };
                }
                return { min: 5000, max: 1000000, default: 20000 };
            };

            const otRpi = resolveRpi(arr[2]);
            const toRpi = resolveRpi(arr[5]);

            connections.push({
                id,
                name,
                triggerAndTransport: {
                    raw: triggerRaw,
                    transportClass: triggerRaw & 0xffff,
                    isCyclic: Boolean(triggerRaw & (1 << 16)),
                    isChangeOfState: Boolean(triggerRaw & (1 << 17)),
                    isApplication: Boolean(triggerRaw & (1 << 18))
                },
                connectionParameters: {
                    raw: paramsRaw,
                    otFixed: Boolean(paramsRaw & (1 << 0)),
                    otVariable: Boolean(paramsRaw & (1 << 1)),
                    toFixed: Boolean(paramsRaw & (1 << 2)),
                    toVariable: Boolean(paramsRaw & (1 << 3))
                },
                otRpi,
                toRpi,
                pathString: pathStr,
                pathBuffer,
                parsedPath
            });
        }

        return connections;
    }

    /**
     * Finds a connection profile by number (e.g. 1) or name (e.g. "Connection1").
     *
     * @param {number|string} [nameOrId]
     * @returns {object|null}
     */
    getConnection(nameOrId) {
        if (!nameOrId) return this.getDefaultConnection();
        if (typeof nameOrId === 'number') {
            return this.connections.find((c) => c.id === nameOrId) || null;
        }
        const str = String(nameOrId).toLowerCase();
        return this.connections.find((c) => c.name.toLowerCase() === str || `connection${c.id}`.toLowerCase() === str) || null;
    }

    /**
     * Returns the primary / default connection (first cyclic exclusive-owner connection, or Connection1).
     *
     * @returns {object|null}
     */
    getDefaultConnection() {
        if (this.connections.length === 0) return null;
        const cyclic = this.connections.find((c) => c.triggerAndTransport.isCyclic);
        return cyclic || this.connections[0];
    }

    /**
     * Builds ready-to-use Forward_Open / Large_Forward_Open parameters from an EDS connection.
     *
     * @param {number|string} [connectionNameOrId]
     * @param {object} [overrides]
     * @returns {{ connectionPath: Buffer, rpiUs: number, otSize: number, toSize: number }}
     */
    buildForwardOpenParams(connectionNameOrId, overrides = {}) {
        const conn = this.getConnection(connectionNameOrId);
        if (!conn) {
            throw new Error(`EdsFile.buildForwardOpenParams: connection "${connectionNameOrId}" not found in EDS`);
        }

        let connectionPath = overrides.connectionPath;
        if (!connectionPath) {
            if (conn.pathBuffer) {
                connectionPath = conn.pathBuffer;
            } else if (conn.parsedPath) {
                connectionPath = encodeAssemblyConnectionPath({
                    configInstance: conn.parsedPath.configInstance,
                    o2tInstance: conn.parsedPath.o2tInstance,
                    t2oInstance: conn.parsedPath.t2oInstance
                });
            } else {
                throw new Error(`EdsFile.buildForwardOpenParams: could not resolve connectionPath for connection ${conn.id}`);
            }
        }

        const rpiUs = overrides.rpiUs || conn.toRpi.default || 20000;

        // Resolve default assembly sizes if not provided
        let otSize = overrides.otSize;
        let toSize = overrides.toSize;

        if (otSize === undefined && conn.parsedPath && conn.parsedPath.o2tInstance) {
            // Check matching assembly
            for (const assem of this.assemblies.values()) {
                if (assem.id === conn.parsedPath.o2tInstance || assem.name.includes('Output')) {
                    otSize = assem.size;
                    break;
                }
            }
        }

        if (toSize === undefined && conn.parsedPath && conn.parsedPath.t2oInstance) {
            for (const assem of this.assemblies.values()) {
                if (assem.id === conn.parsedPath.t2oInstance || assem.name.includes('Input')) {
                    toSize = assem.size;
                    break;
                }
            }
        }

        return {
            connectionPath,
            rpiUs,
            otSize: otSize !== undefined ? otSize : 200,
            toSize: toSize !== undefined ? toSize : 200,
            ...overrides
        };
    }

    /**
     * Checks if this EDS file matches the discovered device identity.
     *
     * @param {object} identity - Result from scanner.getIdentity() or ListIdentity probe
     * @returns {boolean}
     */
    matchesDevice(identity) {
        if (!identity) return false;
        if (identity.vendorId !== undefined && identity.vendorId !== this.device.vendorId) {
            return false;
        }
        if (identity.deviceType !== undefined && identity.deviceType !== this.device.deviceType) {
            return false;
        }
        if (identity.productCode !== undefined && identity.productCode !== this.device.productCode) {
            return false;
        }
        return true;
    }
}

module.exports = {
    EdsFile,
    parseRawSections,
    stripComments,
    parseLiteral
};
