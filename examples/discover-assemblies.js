'use strict';

/**
 * Phase 2 probe: sweep the Assembly Object (Class 0x04) instance range on a
 * real device and report which instances exist, by reading Attribute 4
 * (Size, UINT — number of bytes in the assembly's Attribute 3 Data) for
 * each candidate instance over a single session. This finds a vendor's
 * Input/Output/Config assembly instance numbers without needing their
 * manual/EDS — a read-only, non-destructive probe (Get_Attribute_Single
 * only, no writes), safe to run against a live device.
 *
 * Usage: node examples/discover-assemblies.js <host> [maxInstance]
 */

const { EIPSession } = require('../src/client');
const { encodeEPath } = require('../src/cip/path');
const { buildRequest } = require('../src/cip/message-router');
const { CipCommonServices, CipGeneralStatus, CipClassCodes } = require('../src/constants');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/discover-assemblies.js <host> [maxInstance]');
        process.exit(1);
    }
    const maxInstance = process.argv[3] ? Number(process.argv[3]) : 254;

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);
    console.log(`Sweeping Assembly Object (Class 0x${CipClassCodes.Assembly.toString(16)}) instances 1..${maxInstance}, reading Attribute 4 (Size)...\n`);

    const found = [];

    for (let instance = 1; instance <= maxInstance; instance++) {
        const path = encodeEPath({ classId: CipClassCodes.Assembly, instance, attribute: 4 });
        const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });

        let response;
        try {
            response = await session.sendUnconnected(request);
        } catch (err) {
            console.error(`instance ${instance}: transport error — ${err.message}`);
            break; // connection likely dead, stop the sweep
        }

        if (response.generalStatus === CipGeneralStatus.Success) {
            const sizeBytes = response.data.length >= 2 ? response.data.readUInt16LE(0) : null;
            found.push({ instance, sizeBytes });
            console.log(`  instance ${instance}: EXISTS — size = ${sizeBytes} bytes`);
        }
        // Anything else (ObjectDoesNotExist / PathDestinationUnknown / etc.) = instance not present, silently skip.
    }

    await session.close();

    console.log(`\nDone. ${found.length} assembly instance(s) found: ${found.map((f) => f.instance).join(', ') || '(none)'}`);
    if (found.length > 0) {
        console.log('\nNext step: read Attribute 3 (Data) on the interesting instances to see the actual I/O byte layout.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
