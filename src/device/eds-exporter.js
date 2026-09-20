'use strict';

/**
 * ODVA Standard Electronic Data Sheet (EDS) Exporter
 *
 * Fully compliant with ODVA CIP Volume 1 Appendix C specification.
 * Verified against official Rockwell Automation and Delta Electronics (EIP Builder) EDS standards.
 */

const { getCipTypeInfo, CipDataTypeCode, encodeType } = require('../cip/types');

// Conservative full-range bounds per elementary CIP numeric type, used only
// for the synthetic tag-derived Param entries below (real addParam() calls
// already carry their own min/max).
function numericTypeRange(dataType) {
    switch (String(dataType || 'DINT').toUpperCase()) {
        case 'BOOL': return [0, 1];
        case 'SINT': return [-128, 127];
        case 'USINT': case 'BYTE': return [0, 255];
        case 'INT': return [-32768, 32767];
        case 'UINT': case 'WORD': return [0, 65535];
        case 'DINT': return [-2147483648, 2147483647];
        case 'UDINT': case 'DWORD': return [0, 4294967295];
        default: return [0, 4294967295];
    }
}

function formatDate(d = new Date()) {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
}

function formatTime(d = new Date()) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

/**
 * Exports device specification to ODVA EDS format string.
 *
 * @param {object} deviceSpec - Complete device model
 * @returns {string} Formatted EDS text
 */
function exportToEds(deviceSpec) {
    const identity = deviceSpec.identity || {};
    const params = deviceSpec.params || [];
    const assemblies = deviceSpec.assemblies || [];
    // Accept a Map (DeviceBuilder.tags), a plain array, or an object.
    const rawTags = deviceSpec.tags;
    const tagEntries = rawTags instanceof Map ? Array.from(rawTags.values())
        : Array.isArray(rawTags) ? rawTags
        : (rawTags && typeof rawTags === 'object') ? Object.values(rawTags)
        : [];
    const hasTags = tagEntries.length > 0;

    // Config tools (confirmed against Delta EIP Builder: without this, the
    // Tag Connection's "Length" column is stuck at an arbitrary default and
    // isn't editable) need a static, sized list to resolve a typed-in tag
    // name against — so every NUMERIC tag also gets its own synthetic Param
    // entry, continuing the same Param numbering as real addParam() params,
    // and a synthetic Assembly (built below) referencing all of them is
    // wired into the Tag Connection's Format field. This mirrors this
    // project's own real Delta SX3 EDS's Tag Connection, whose Format field
    // likewise references an Assembly of Params rather than being blank.
    // STRING/SHORT_STRING tags are skipped: EDS Params are fixed-size and
    // carry numeric Min/Max/Default, which doesn't fit a variable-length
    // string — those tags remain explicit-messaging-only (no Length entry).
    const STRING_TAG_TYPES = new Set(['STRING', 'SHORT_STRING']);
    const tagParamBaseId = params.length;
    const tagParams = tagEntries
        .filter((t) => !STRING_TAG_TYPES.has(String(t.type || 'DINT').toUpperCase()))
        .map((t, idx) => {
            const dataType = t.type || 'DINT';
            const typeInfo = getCipTypeInfo(dataType);
            const typeCode = typeInfo ? typeInfo.code : CipDataTypeCode.DINT;
            let byteSize;
            try { byteSize = encodeType(dataType, t.value).length; } catch { byteSize = typeInfo ? typeInfo.size : 4; }
            const [min, max] = numericTypeRange(dataType);
            return {
                id: tagParamBaseId + idx + 1,
                name: t.name,
                typeCode,
                byteSize,
                min,
                max,
                defVal: String(dataType).toUpperCase() === 'BOOL'
                    ? (t.value ? 1 : 0)
                    : (typeof t.value === 'number' ? t.value : 0)
            };
        });
    const hasNumericTagParams = tagParams.length > 0;
    // Unused instance number for the synthetic tag-symbol table Assembly —
    // referenced from the Tag Connection's Format field below, never opened
    // as a real Class 1 I/O connection itself.
    const tagAssemblyInstance = hasNumericTagParams
        ? (assemblies.length > 0 ? Math.max(...assemblies.map((a) => a.instance)) + 1 : 199)
        : null;
    const now = new Date();

    const vendCode = identity.vendorId !== undefined ? identity.vendorId : 799; // Default 799 (Delta) or custom
    const vendName = identity.vendorName || 'Delta Electronics, Inc.';
    const prodType = identity.deviceType !== undefined ? identity.deviceType : 43; // 43 = 0x002B (Generic Device)
    const prodTypeStr = identity.deviceTypeStr || (prodType === 14 ? 'Programmable Logic Controller' : (prodType === 12 ? 'Communications Adapter' : (prodType === 2 ? 'AC Drive' : 'Generic Device')));
    const prodCode = identity.productCode !== undefined ? identity.productCode : 1;
    const majRev = (identity.revision && identity.revision.major) !== undefined ? Math.max(1, Math.min(255, identity.revision.major)) : 1;
    // ODVA CIP EDS Specification: MinRev must be an integer between 1 and 255 (cannot be 0)
    const rawMin = (identity.revision && identity.revision.minor) !== undefined ? identity.revision.minor : 1;
    const minRev = Math.max(1, Math.min(255, Number(rawMin) || 1));
    const prodName = identity.productName || 'Kufayeka Smart Node';
    const catalog = identity.catalog || deviceSpec.catalog || 'Generic-EIP';
    const descText = deviceSpec.description || `${vendName} ${prodName} Electronic Data Sheet`;

    let eds = `$ EZ-EDS Version 3.31.1.20220811 Generated Electronic Data Sheet
$ ODVA Standard Electronic Data Sheet for EtherNet/IP Devices
$ Generated by @kufayeka/ethernet-ip DeviceBuilder
$ Timestamp: ${now.toISOString()}

[File]
        DescText = ${JSON.stringify(descText)};
        CreateDate = ${formatDate(now)};
        CreateTime = ${formatTime(now)};
        ModDate = ${formatDate(now)};
        ModTime = ${formatTime(now)};
        Revision = ${majRev}.${minRev};
        HomeURL = "https://github.com/kufayeka/ethernet-ip";

[Device]
        VendCode = ${vendCode};
        VendName = ${JSON.stringify(vendName)};
        ProdType = ${prodType};
        ProdTypeStr = ${JSON.stringify(prodTypeStr)};
        ProdCode = ${prodCode};
        MajRev = ${majRev};
        MinRev = ${minRev};
        ProdName = ${JSON.stringify(prodName)};
        Catalog = ${JSON.stringify(catalog)};

[Device Classification]
        Class1 = EtherNetIP;
`;

    // 1. [ParamClass] & [Params] Section
    if (params.length > 0 || hasNumericTagParams) {
        eds += `\n[ParamClass]
        MaxInst = ${params.length + tagParams.length};
        Descriptor = 0x0001;
        CfgAssembly = 0;\n`;

        eds += `\n[Params]\n`;
        for (const p of params) {
            const id = p.id;
            const typeInfo = getCipTypeInfo(p.dataType || 'INT');
            const typeCode = typeInfo ? typeInfo.code : CipDataTypeCode.INT;
            const byteSize = p.byteSize || (typeInfo ? typeInfo.size : 2);

            // Param Descriptor bitmap (CIP Vol 1 Appx C):
            // Bit 4 (0x0010): Read-Only parameter per official ODVA specification
            let descVal = 0x0000;
            if (p.access === 'r') {
                descVal |= 0x0010;
            }

            const hasScaling = p.scaling && (p.scaling.multiplier || p.scaling.divider || p.scaling.base !== undefined || p.scaling.offset !== undefined);
            if (hasScaling) {
                descVal |= 0x0004; // Bit 2: Scaling Factors supplied
            }

            const descriptor = '0x' + descVal.toString(16).padStart(4, '0').toUpperCase();
            const fullName = p.code ? `${p.code} ${p.name}` : p.name;
            const units = p.units || '';
            const help = p.help || '';
            const isBool = String(p.dataType || '').toUpperCase() === 'BOOL' || typeCode === CipDataTypeCode.BOOL;
            // EDS numeric fields must contain numeric literals. CIP BOOL uses
            // the numeric domain 0..1 in Min/Max/Default even if the JS API
            // accepts boolean true/false values.
            const boolNumeric = (value) => value ? 1 : 0;
            const min = isBool ? 0 : (p.min !== undefined ? p.min : 0);
            const max = isBool ? 1 : (p.max !== undefined ? p.max : 65535);
            const defVal = isBool ? boolNumeric(p.default !== undefined ? p.default : 0) : (p.default !== undefined ? p.default : 0);

            const scalingStr = hasScaling
                ? `                ${p.scaling.multiplier || 1},${p.scaling.divider || 1},${p.scaling.base !== undefined ? p.scaling.base : 1},${p.scaling.offset || 0},\n                ,,,,\n                ${p.scaling.decimalPlaces !== undefined ? p.scaling.decimalPlaces : 0};`
                : `                ,,,,\n                ,,,,\n                ;`;

            if (p.linkPath && p.linkPath.trim().length > 0) {
                eds += `        Param${id} =
                0,
                6, ${JSON.stringify(p.linkPath.trim())},
                ${descriptor},
                0x${typeCode.toString(16).padStart(2, '0').toUpperCase()},
                ${byteSize},
                ${JSON.stringify(fullName)},
                ${JSON.stringify(units)},
                ${JSON.stringify(help)},
                ${min},${max},${defVal},
${scalingStr}
`;
            } else {
                eds += `        Param${id} =
                0,
                ,,
                ${descriptor},
                0x${typeCode.toString(16).padStart(2, '0').toUpperCase()},
                ${byteSize},
                ${JSON.stringify(fullName)},
                ${JSON.stringify(units)},
                ${JSON.stringify(help)},
                ${min},${max},${defVal},
${scalingStr}
`;
            }
        }

        // Synthetic Param entries for numeric symbolic tags (see tagParams'
        // comment above) — always read/write (0x0000), no scaling, no link path.
        for (const tp of tagParams) {
            eds += `        Param${tp.id} =
                0,
                ,,
                0x0000,
                0x${tp.typeCode.toString(16).padStart(2, '0').toUpperCase()},
                ${tp.byteSize},
                ${JSON.stringify(tp.name)},
                "",
                ${JSON.stringify(`Symbolic tag "${tp.name}" (Produced/Consumed Tag Connection member)`)},
                ${tp.min},${tp.max},${tp.defVal},
                ,,,,
                ,,,,
                ;
`;
        }
    }

    const connections = deviceSpec.connections || [];

    // 2. [Assembly] Section
    const inputAssem = assemblies.find(a => a.type === 'input' || a.type === 'produce');
    const outputAssem = assemblies.find(a => a.type === 'output' || a.type === 'consume');

    if (assemblies.length > 0 || hasNumericTagParams) {
        const maxInst = Math.max(1, ...assemblies.map((a) => a.instance), tagAssemblyInstance || 0);
        const totalAssemblyCount = assemblies.length + (hasNumericTagParams ? 1 : 0);

        eds += `\n[Assembly]
        Object_Name = "Assembly Object";
        Object_Class_Code = 0x04;
        Revision = 2;
        MaxInst = ${maxInst};
        Number_Of_Static_Instances = ${totalAssemblyCount};
        Max_Number_Of_Dynamic_Instances = 0;\n\n`;

        for (const assem of assemblies) {
            const instHex = assem.instance.toString(16).padStart(2, '0').toUpperCase();
            const assemName = assem.name || `Assembly ${assem.instance}`;
            const assemPath = `"20 04 24 ${instHex} 30 03"`;
            const sizeBytes = assem.sizeBytes || 4;

            eds += `        Assem${assem.instance} =
                ${JSON.stringify(assemName)},
                ${assemPath},
                ${sizeBytes},
                0x0000,
                ,,\n`;

            // Build member list (essential for Delta EIP Builder Data Exchange table)
            let members = [];
            if (Array.isArray(assem.members) && assem.members.length > 0) {
                let mappedBits = 0;
                members = assem.members.map(m => {
                    const p = typeof m.paramId === 'number'
                        ? params.find(x => x.id === m.paramId)
                        : (params.find(x => x.code === m.paramId) || params.find(x => x.name === m.paramId));
                    const bLen = m.bitLength || (m.byteSize ? m.byteSize * 8 : (p ? p.byteSize * 8 : 16));
                    mappedBits += bLen;
                    return {
                        bits: bLen,
                        paramId: p ? p.id : m.paramId
                    };
                });
                if (mappedBits < sizeBytes * 8) {
                    members.push({ bits: (sizeBytes * 8) - mappedBits, paramId: null });
                }
            } else if (params.length > 0 && (assem.instance === 100 || assem.instance === 101)) {
                if (assem.type === 'output') {
                    // Output (CTRL): Map writable params
                    const writableParams = params.filter(p => p.access !== 'r');
                    const targetParams = writableParams.length > 0 ? writableParams : params;
                    let accumBits = 0;
                    for (const p of targetParams) {
                        const typeInfo = getCipTypeInfo(p.dataType || 'INT');
                        const bSize = p.byteSize || (typeInfo ? typeInfo.size : 2);
                        const bits = bSize * 8;
                        if (accumBits + bits <= sizeBytes * 8) {
                            members.push({ bits, paramId: p.id });
                            accumBits += bits;
                        }
                    }
                    if (accumBits < sizeBytes * 8) {
                        members.push({ bits: sizeBytes * 8 - accumBits, paramId: null });
                    }
                } else {
                    // Input (STAT): Map all params
                    let accumBits = 0;
                    for (const p of params) {
                        const typeInfo = getCipTypeInfo(p.dataType || 'INT');
                        const bSize = p.byteSize || (typeInfo ? typeInfo.size : 2);
                        const bits = bSize * 8;
                        if (accumBits + bits <= sizeBytes * 8) {
                            members.push({ bits, paramId: p.id });
                            accumBits += bits;
                        }
                    }
                    if (accumBits < sizeBytes * 8) {
                        members.push({ bits: sizeBytes * 8 - accumBits, paramId: null });
                    }
                }
            } else {
                members.push({ bits: sizeBytes * 8, paramId: null });
            }

            const memLines = members.map((m, idx) => {
                const isLast = idx === members.length - 1;
                const ref = m.paramId ? `Param${m.paramId}` : '0';
                return `                ${m.bits},${ref}${isLast ? ';' : ','}`;
            });
            eds += memLines.join('\n') + '\n\n';
        }

        // Synthetic "symbol table" Assembly listing every numeric tag as a
        // member — not a real I/O connection endpoint, only referenced from
        // the Tag Connection's Format field below so a config tool has a
        // sized, named list to resolve a typed-in tag name against (this
        // project's own real Delta SX3 EDS does the same: its own Tag
        // Connection's Format field references an Assembly built from Params,
        // not a blank field).
        if (hasNumericTagParams) {
            const instHex = tagAssemblyInstance.toString(16).padStart(2, '0').toUpperCase();
            const totalBytes = tagParams.reduce((sum, tp) => sum + tp.byteSize, 0);
            eds += `        Assem${tagAssemblyInstance} =
                "TAG_SYMBOL_TABLE",
                "20 04 24 ${instHex} 30 03",
                ${totalBytes},
                0x0000,
                ,,\n`;
            const tagMemLines = tagParams.map((tp, idx) => {
                const isLast = idx === tagParams.length - 1;
                return `                ${tp.byteSize * 8},Param${tp.id}${isLast ? ';' : ','}`;
            });
            eds += tagMemLines.join('\n') + '\n\n';
        }
    }

    // 3. [Connection Manager] Section (Matches Delta EIP Builder & ODVA Standard exactly)
    // Also entered for a device with ONLY symbolic tags and no Assembly-based connections at all
    // (hasTags true, connections empty) -- without this, such a device got NO Connection Manager
    // section whatsoever, so its tags were reachable by explicit messaging but could never be
    // selected as a Produced/Consumed Tag Class 1 connection in a Scanner's config tool, since
    // there was no EDS Connection entry to select in the first place. The block below already
    // handles an empty `connections` array correctly (connections.forEach() is a no-op, connIdx
    // stays 0) and already computes totalConnections/tagConnIdx accounting for hasTags.
    if ((Array.isArray(connections) && connections.length > 0) || hasTags) {
        const ownerCount = connections.length;
        const listenOnlyCount = connections.filter((c) => c.supportListenOnly !== false).length;
        const inputOnlyCount = connections.filter((c) => c.supportInputOnly !== false).length;
        const totalConnections = ownerCount + listenOnlyCount + inputOnlyCount + (hasTags ? 1 : 0);
        eds += `[Connection Manager]
        Object_Name = "Connection Manager Object";
        Object_Class_Code = 0x06;
        Revision = 1;
        MaxInst = ${totalConnections};
        Number_Of_Static_Instances = ${totalConnections};
        Max_Number_Of_Dynamic_Instances = 0;\n\n`;

        let connIdx = 0;
        connections.forEach((conn, index) => {
            const otAssem = assemblies.find(a => a.instance === conn.outputAssembly);
            const toAssem = assemblies.find(a => a.instance === conn.inputAssembly);
            const otInstHex = otAssem ? otAssem.instance.toString(16).padStart(2, '0').toUpperCase() : '64';
            const toInstHex = toAssem ? toAssem.instance.toString(16).padStart(2, '0').toUpperCase() : '65';
            const otRef = otAssem ? `Assem${otAssem.instance}` : '';
            const toRef = toAssem ? `Assem${toAssem.instance}` : '';

            connIdx += 1;
            // TransportTypeTrigger word (CIP Vol 1 Table 3-4.5, EDS's own 32-bit expansion of it --
            // see cip/eds.js's parser, the authoritative decode this mirrors): bits 0-15 (0x0002)
            // and bit 26 (0x04000000, "Exclusive-Owner" connection-type marker) are fixed; bits
            // 16/17/18 advertise which Production Trigger types a Scanner's config tool may offer
            // to pick from (Cyclic/Change-of-State/Application Object) -- defaults to Cyclic+COS
            // (0x04030002, this project's long-standing value) unless conn.triggers says otherwise.
            const triggerBits =
                (conn.triggers.includes('cyclic') ? 0x00010000 : 0) |
                (conn.triggers.includes('cos') ? 0x00020000 : 0) |
                (conn.triggers.includes('applicationObject') ? 0x00040000 : 0);
            const transportTriggerWord = (0x04000002 | triggerBits) >>> 0;
            const otRpiField = conn.otRpiUs !== undefined ? conn.otRpiUs : '';
            const toRpiField = conn.toRpiUs !== undefined ? conn.toRpiUs : '';
            eds += `        Connection${connIdx} =
                0x${transportTriggerWord.toString(16).padStart(8, '0')},             $ 1. Trigger: ${conn.triggers.join('+')}, Transport: Exclusive-Owner Class 1
                0x44640405,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ${otRpiField},,${otRef},           $ 3, 4, 5. O->T RPI, Size, Format
                ${toRpiField},,${toRef},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Proxy Config Format
                0,,                     $ 11, 12. Target Config Size (0), Target Config Format (none)
                ${JSON.stringify(conn.name || `Connection ${connIdx}`)},      $ 13. Connection Name
                ${JSON.stringify(conn.help || conn.name || '')}, $ 14. Help String
                "20 04 24 01 2C ${otInstHex} 2C ${toInstHex}"; $ 15. Path\n\n`;

            // Listen-Only / Input-Only variants — CIP Vol 1 §5.2.3f / PUB00070 §5.2.2 require an
            // Adapter with input data to support these alongside its Exclusive-Owner connection,
            // so a second consumer (e.g. an HMI/SCADA) can independently observe the same T->O
            // data while a PLC owns the Exclusive-Owner connection. The O->T side references a
            // reserved placeholder instance (no real Assembly — see DeviceBuilder.defineConnection())
            // rather than the real output Assembly, matching this project's own real Delta SX3 EDS
            // convention (its own Connection2/3 "Listen only" entries use placeholder O->T points).
            if (conn.supportListenOnly !== false && typeof conn.listenOnlyO2T === 'number') {
                const loHex = conn.listenOnlyO2T.toString(16).padStart(2, '0').toUpperCase();
                connIdx += 1;
                eds += `        Connection${connIdx} =
                0x01010002,             $ 1. Trigger: cyclic, Transport: Listen-Only Class 1
                0x44240305,             $ 2. Point-to-Point
                ,0,,                    $ 3, 4, 5. O->T RPI, Size 0, Format none
                ,,${toRef},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Format
                0,,                     $ 11, 12. Target Config Size (0), Format (none)
                ${JSON.stringify(`${conn.name || `Connection ${index + 1}`} (Listen Only)`)},      $ 13. Connection Name
                "Listen-Only — observe the same data without owning the connection", $ 14. Help String
                "20 04 24 01 2C ${loHex} 2C ${toInstHex}"; $ 15. Path\n\n`;
            }
            if (conn.supportInputOnly !== false && typeof conn.inputOnlyO2T === 'number') {
                const ioHex = conn.inputOnlyO2T.toString(16).padStart(2, '0').toUpperCase();
                connIdx += 1;
                eds += `        Connection${connIdx} =
                0x02010002,             $ 1. Trigger: cyclic, Transport: Input-Only Class 1
                0x44640305,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ,0,,                    $ 3, 4, 5. O->T RPI, Size 0, Format none
                ,,${toRef},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Format
                0,,                     $ 11, 12. Target Config Size (0), Format (none)
                ${JSON.stringify(`${conn.name || `Connection ${index + 1}`} (Input Only)`)},      $ 13. Connection Name
                "Input-Only — observe the same data without owning the connection", $ 14. Help String
                "20 04 24 01 2C ${ioHex} 2C ${toInstHex}"; $ 15. Path\n\n`;
            }
        });

        if (hasTags) {
            // Symbolic Produced/Consumed Tag Connection — CIP Vol 1 C-1.4.3 /
            // this driver's src/cip/path.js encodeTagConnectionPath(). Unlike
            // every connection above, the Path here isn't a fixed Class/
            // Instance/ConnectionPoint pair — "SYMBOL_ANSI" is the literal
            // keyword real EDS-consuming tools (confirmed against this
            // project's own real Delta SX3 EDS, eds/031F000E0F0600010001.eds,
            // Connection "Tag Connection") use to mean "the user picks the
            // actual tag name for O->T (Consumed) / T->O (Produced) at
            // configuration time" — that's what makes the Scanner's config
            // tool show a "Symbol Configuration" screen instead of a plain
            // fixed I/O size.
            //
            // The Format field below (both directions) references the
            // synthetic TAG_SYMBOL_TABLE assembly built above when at least
            // one numeric tag exists — confirmed necessary against a real
            // Delta EIP Builder test: with Format left blank, the Data
            // Exchange grid's "Length" column is stuck at a meaningless
            // default and isn't editable, even after typing in a valid tag
            // name. Real SX3's own Tag Connection does the same (its Format
            // field references an Assembly of Params, not a blank field).
            const tagConnIdx = connIdx + 1;
            const tagFormatRef = hasNumericTagParams ? `Assem${tagAssemblyInstance}` : '';
            eds += `        Connection${tagConnIdx} =
                0x04010002,             $ 1. Trigger: cyclic, Transport: Exclusive-Owner Class 1
                0x44640405,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ,,${tagFormatRef},                     $ 3, 4, 5. O->T (Consumed) RPI, Size, Format — chosen tag decides size
                ,,${tagFormatRef},                     $ 6, 7, 8. T->O (Produced) RPI, Size, Format — chosen tag decides size
                ,,                      $ 9, 10. Proxy Config Size, Proxy Config Format
                0,,                     $ 11, 12. Target Config Size (0), Target Config Format (none)
                "Tag Connection",       $ 13. Connection Name
                "Produced/Consumed symbolic tag connection — pick any defined tag as Produced (read) or Consumed (write)", $ 14. Help String
                "SYMBOL_ANSI";          $ 15. Path\n\n`;
        }
    } else if (outputAssem && inputAssem) {
        const otInstHex = outputAssem.instance.toString(16).padStart(2, '0').toUpperCase();
        const toInstHex = inputAssem.instance.toString(16).padStart(2, '0').toUpperCase();

        eds += `[Connection Manager]
        Object_Name = "Connection Manager Object";
        Object_Class_Code = 0x06;
        Revision = 1;
        MaxInst = 1;
        Number_Of_Static_Instances = 1;
        Max_Number_Of_Dynamic_Instances = 0;

        Connection1 =
                0x04030002,             $ 1. Trigger: cyclic or change-of-state, Transport: Exclusive-Owner Class 1
                0x44640405,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ,,Assem${outputAssem.instance},           $ 3, 4, 5. O->T RPI, Size, Format
                ,,Assem${inputAssem.instance},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Proxy Config Format
                0,,                     $ 11, 12. Target Config Size (0), Target Config Format (none)
                "Exclusive Owner",      $ 13. Connection Name
                "Bidirectional Real-Time I/O Connection", $ 14. Help String
                "20 04 24 01 2C ${otInstHex} 2C ${toInstHex}"; $ 15. Path

        Connection2 =
                0x01010002,             $ 1. Trigger: cyclic, Transport: Listen-Only Class 1
                0x44240305,             $ 2. Point-to-Point
                ,0,,                    $ 3, 4, 5. O->T RPI, Size 0, Format none
                ,,Assem${inputAssem.instance},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Format
                0,,                     $ 11, 12. Target Config Size (0), Format (none)
                "Listen Only",          $ 13. Connection Name
                "Listen-Only Real-Time Connection", $ 14. Help String
                "20 04 24 01 2C C0 2C ${toInstHex}"; $ 15. Path (0xC0 = Listen Only Heartbeat)

        Connection3 =
                0x02010002,             $ 1. Trigger: cyclic, Transport: Input-Only Class 1
                0x44640305,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ,0,,                    $ 3, 4, 5. O->T RPI, Size 0, Format none
                ,,Assem${inputAssem.instance},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Format
                0,,                     $ 11, 12. Target Config Size (0), Format (none)
                "Input Only",           $ 13. Connection Name
                "Input-Only Real-Time Connection", $ 14. Help String
                "20 04 24 01 2C C1 2C ${toInstHex}"; $ 15. Path (0xC1 = Input Only Heartbeat)
`;
    } else if (inputAssem) {
        const toInstHex = inputAssem.instance.toString(16).padStart(2, '0').toUpperCase();
        eds += `[Connection Manager]
        Object_Name = "Connection Manager Object";
        Object_Class_Code = 0x06;
        Revision = 1;
        MaxInst = 1;
        Number_Of_Static_Instances = 1;
        Max_Number_Of_Dynamic_Instances = 0;

        Connection1 =
                0x02010002,             $ 1. Trigger: cyclic, Transport: Input-Only Class 1
                0x44640305,             $ 2. Point-to-Point, 4-byte Run/Idle header
                ,0,,                    $ 3, 4, 5. O->T empty
                ,,Assem${inputAssem.instance},           $ 6, 7, 8. T->O RPI, Size, Format
                ,,                      $ 9, 10. Proxy Config Size, Format
                0,,                     $ 11, 12. Target Config Size (0), Format (none)
                "Input Only",           $ 13. Connection Name
                "Input Only Real-Time Connection", $ 14. Help String
                "20 04 24 01 2C C1 2C ${toInstHex}"; $ 15. Path
`;
    }

    // 4. [Capacity] Section
    eds += `\n[Capacity]
        ConnOverhead = .004;
        MaxIOConnections = 4;
        MaxMsgConnections = 8;
        TSpec1 = TxRx, 10, 2000;
        TSpec2 = TxRx, 504, 1500;

[TCP/IP Interface Class]
        Object_Name = "TCP/IP Interface Object";
        Object_Class_Code = 0xF5;
        Revision = 4;
        MaxInst = 1;
        Number_Of_Static_Instances = 1;
        Max_Number_Of_Dynamic_Instances = 0;

[Ethernet Link Class]
        Object_Name = "Ethernet Link Object";
        Object_Class_Code = 0xF6;
        Revision = 4;
        MaxInst = 1;
        Number_Of_Static_Instances = 1;
        Max_Number_Of_Dynamic_Instances = 0;
        InterfaceLabel1 = "Port 1";
`;

    return eds;
}

module.exports = { exportToEds };
