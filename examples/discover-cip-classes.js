'use strict';

/**
 * Sweeps a range of CIP class IDs against a real device and reports which
 * ones actually exist, vendor-neutral (no assumption about which classes
 * "should" be there — this is exactly the known-pattern technique used
 * throughout src/delta/README.md's investigation, just generalized and
 * turned into a reusable tool instead of an ad-hoc one-off script).
 *
 * Per class, two probes are tried (either one succeeding marks it
 * present):
 *   1. Get_Attribute_Single(class, Instance 0, Attribute 1) — the class's
 *      own Revision attribute (CIP Vol 1, 4-4.4). Any conformant CIP
 *      object should answer this even with zero real instances.
 *   2. Get_Attribute_Single(class, Instance 1, Attribute 1) — covers
 *      classes/devices that don't implement Instance 0 class-attribute
 *      queries but do have a real Instance 1 (true of every Delta vendor
 *      Register Object, for example).
 * A response other than PathDestinationUnknown (0x05) on either probe
 * means the class exists at the wire level (a different status, e.g.
 * AttributeNotSupported or ServiceNotSupported, still proves the class/
 * instance itself was recognized).
 *
 * Usage: node examples/discover-cip-classes.js <host> [startClass] [endClass]
 *   Defaults to 0x0001-0x03FF, the range that's covered every CIP class
 *   this project has ever found on a Delta device (standard objects,
 *   Delta's documented 0x350-0x376, and the legacy 0x64-0x69 scheme).
 */

const { EIPSession } = require('../src/client');
const { encodeEPath } = require('../src/cip/path');
const { buildRequest } = require('../src/cip/message-router');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

// Known class IDs worth naming when found, from docs/delta_manual.txt Ch.8
// and this project's own investigation of Delta's legacy alt object model.
const KNOWN_CLASSES = {
    0x01: 'Identity Object',
    0x02: 'Message Router Object',
    0x03: 'DeviceNet Object',
    0x04: 'Assembly Object',
    0x06: 'Connection Manager Object',
    0x0f: 'Parameter Object',
    0x47: 'Device Level Ring Object',
    0x48: 'QoS Object',
    0x64: 'Legacy X Register (alt Delta scheme, different product variant)',
    0x65: 'Legacy Y Register (alt Delta scheme, different product variant)',
    0x66: 'Legacy T Register (alt Delta scheme, different product variant)',
    0x67: 'Legacy M Register (alt Delta scheme, different product variant)',
    0x68: 'Legacy C Register (alt Delta scheme, different product variant)',
    0x69: 'Legacy D Register (alt Delta scheme, different product variant)',
    0xf4: 'Port Object',
    0xf5: 'TCP/IP Interface Object',
    0xf6: 'Ethernet Link Object',
    0x350: 'X Register (Delta vendor)',
    0x351: 'Y Register (Delta vendor)',
    0x352: 'D Register (Delta vendor)',
    0x353: 'M Register (Delta vendor)',
    0x354: 'S Register (Delta vendor)',
    0x355: 'T Register (Delta vendor)',
    0x356: 'C Register (Delta vendor)',
    0x357: 'HC Register (Delta vendor)',
    0x358: 'SM Register (Delta vendor)',
    0x359: 'SR Register (Delta vendor)',
    0x370: 'Control/Status Register (Delta vendor, AHRTU remote I/O)',
    0x371: 'Input Register (Delta vendor, AHRTU remote I/O)',
    0x372: 'Output Register (Delta vendor, AHRTU remote I/O)',
    0x373: 'RTU AI Register (Delta vendor, AHRTU remote I/O)',
    0x374: 'RTU AO Register (Delta vendor, AHRTU remote I/O)',
    0x375: 'RTU DI Register (Delta vendor, AHRTU remote I/O)',
    0x376: 'RTU DO Register (Delta vendor, AHRTU remote I/O)'
};

async function probe(session, classId, instance) {
    const path = encodeEPath({ classId, instance, attribute: 1 });
    const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });
    const response = await session.sendUnconnected(request);
    return response;
}

async function main() {
    const host = process.argv[2];
    const startClass = process.argv[3] ? Number(process.argv[3]) : 0x0001;
    const endClass = process.argv[4] ? Number(process.argv[4]) : 0x03ff;

    if (!host) {
        console.error('Usage: node examples/discover-cip-classes.js <host> [startClass] [endClass]');
        process.exit(1);
    }

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Sweeping classes 0x${startClass.toString(16)}-0x${endClass.toString(16)} against ${host}...\n`);

    const found = [];
    try {
        for (let classId = startClass; classId <= endClass; classId++) {
            let hit = null;

            for (const instance of [0, 1]) {
                let response;
                try {
                    response = await probe(session, classId, instance);
                } catch (err) {
                    continue; // transport-level error, not a CIP status — skip this probe
                }
                if (response.generalStatus !== CipGeneralStatus.PathDestinationUnknown) {
                    hit = { instance, response };
                    break;
                }
            }

            if (hit) {
                const name = KNOWN_CLASSES[classId] || '(unknown / undocumented)';
                const statusHex = '0x' + hit.response.generalStatus.toString(16).padStart(2, '0');
                const dataHex = hit.response.data.length ? hit.response.data.toString('hex') : '(empty)';
                found.push({ classId, name, instance: hit.instance, status: statusHex, data: dataHex });
                console.log(`0x${classId.toString(16).padStart(3, '0')}  Instance=${hit.instance}  status=${statusHex}  data=${dataHex}  ${name}`);
            }
        }
    } finally {
        await session.close();
    }

    console.log(`\n--- Summary: ${found.length} class(es) found in range 0x${startClass.toString(16)}-0x${endClass.toString(16)} ---`);
    for (const f of found) {
        console.log(`0x${f.classId.toString(16).padStart(3, '0')}  ${f.name}`);
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
