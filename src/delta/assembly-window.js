'use strict';

/**
 * Fallback register access for Delta devices that do NOT implement the
 * vendor-specific Register Objects from registers.js (Class 0x350-0x359) —
 * confirmed on a real DVP32ES2-E, which answers generic CIP fine but
 * rejects reads/writes to those classes with PathDestinationUnknown.
 *
 * On such devices, a device's own project configuration (Delta's ISPSoft
 * EtherNet/IP I/O mapping tool) can still expose specific registers as a
 * plain word-array window inside a generic Assembly Object instance — the
 * SAME mechanism generic CIP I/O uses everywhere else in this driver, just
 * with the byte layout meaning something specific to that one device's
 * project. Confirmed by writing a known value pattern into a register
 * range via the device's own programming tool, then scanning every
 * Assembly instance's Data attribute for a byte-for-byte match.
 *
 * IMPORTANT: unlike registers.js (Delta manual-documented, vendor-wide),
 * an assembly window's instance/offset is NOT a general Delta convention —
 * it is specific to whatever one device's project was configured to
 * expose, and must be reconfirmed (via the same known-pattern technique)
 * for any other device before reuse.
 */

const { encodeEPath } = require('../cip/path');
const { buildRequest } = require('../cip/message-router');
const { CipCommonServices, CipGeneralStatus, CipClassCodes } = require('../constants');

async function readAssemblyData(session, instance) {
    const path = encodeEPath({ classId: CipClassCodes.Assembly, instance, attribute: 3 });
    const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });
    const response = await session.sendUnconnected(request);
    if (response.generalStatus !== CipGeneralStatus.Success) {
        throw new Error(`readAssemblyData(instance ${instance}): general status 0x${response.generalStatus.toString(16)}`);
    }
    return response.data;
}

async function writeAssemblyData(session, instance, data) {
    const path = encodeEPath({ classId: CipClassCodes.Assembly, instance, attribute: 3 });
    const request = buildRequest({ service: CipCommonServices.SetAttributeSingle, path, data });
    const response = await session.sendUnconnected(request);
    if (response.generalStatus !== CipGeneralStatus.Success) {
        throw new Error(`writeAssemblyData(instance ${instance}): general status 0x${response.generalStatus.toString(16)}`);
    }
}

/**
 * A confirmed word-window into one Assembly instance: register number `n`
 * maps to byte offset `(n - base) * 2` within that instance's Data
 * attribute (16-bit signed, little-endian — matches every register.js
 * word type except HC).
 */
function makeWordWindow({ instance, base = 0, writable = false }) {
    return {
        instance,
        base,
        writable,
        async read(session, n) {
            const data = await readAssemblyData(session, instance);
            return data.readInt16LE((n - base) * 2);
        },
        async write(session, n, value) {
            if (!writable) {
                throw new Error(`Assembly instance ${instance} is read-only for this window (Set_Attribute_Single rejected it)`);
            }
            const data = Buffer.from(await readAssemblyData(session, instance));
            data.writeInt16LE(value, (n - base) * 2);
            await writeAssemblyData(session, instance, data);
        }
    };
}

module.exports = {
    readAssemblyData,
    writeAssemblyData,
    makeWordWindow
};
