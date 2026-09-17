'use strict';

/**
 * Assist tool for defining a new device-type profile (src/delta/device-types/)
 * from a vendor-supplied EDS file — parses the [Assembly] and
 * [Connection Manager] sections and returns the candidate connection
 * paths/instance numbers a device of that type is expected to expose.
 *
 * This does NOT auto-generate a working profile — EDS files don't document
 * which byte offset within an assembly corresponds to which named register
 * (the SX3 EDS's own [Assembly] Param names are generic "Input_data0",
 * "Input_data1", ... not "D0", "D1"). It's a starting point: read the
 * output, then confirm live against real hardware with the known-pattern
 * technique (README Domain J) before writing the actual profile.
 */

const fs = require('fs');

/** Parses every ConnectionN entry's Name and Path fields out of an EDS's [Connection Manager] section. */
function parseConnections(edsText) {
    const section = edsText.match(/\[Connection Manager\]([\s\S]*?)(\n\[|$)/);
    const text = section ? section[1] : edsText;

    // Split on each "ConnectionN =" boundary, then parse Name/Path out of each chunk independently -
    // far more robust than one big regex given how much free-form "$ ..." commentary EDS files contain.
    const starts = [...text.matchAll(/Connection(\d+)\s*=/g)];
    const connections = [];
    for (let i = 0; i < starts.length; i++) {
        const start = starts[i].index;
        const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
        const chunk = text.slice(start, end);
        const nameMatch = chunk.match(/"([^"]*)"\s*,\s*\$\s*Connection Name/);
        const pathMatch = chunk.match(/"([0-9A-Fa-f ]+|SYMBOL_ANSI)"\s*;?\s*\$\s*Path/);
        connections.push({
            connection: Number(starts[i][1]),
            name: nameMatch ? nameMatch[1] : undefined,
            path: pathMatch ? pathMatch[1] : undefined
        });
    }
    return connections;
}

/** Parses every AssemN entry's descriptive name and declared size out of an EDS's [Assembly] section. */
function parseAssemblies(edsText) {
    const assemSectionMatch = edsText.match(/\[Assembly\]([\s\S]*?)\n\[/);
    const section = assemSectionMatch ? assemSectionMatch[1] : edsText;
    const assemblies = [];
    const assemRe = /Assem(\d+)\s*=\s*\n\s*"([^"]*)"\s*,\s*\n(?:[^\n]*\n)*?\s*(\d+),/g;
    let match;
    while ((match = assemRe.exec(section))) {
        assemblies.push({ assem: Number(match[1]), name: match[2], size: Number(match[3]) });
    }
    return assemblies;
}

function inspectEds(filePath) {
    const text = fs.readFileSync(filePath, 'latin1');
    return {
        assemblies: parseAssemblies(text),
        connections: parseConnections(text)
    };
}

module.exports = { inspectEds, parseConnections, parseAssemblies };
