'use strict';

/**
 * Phase 2 smoke test: generic explicit messaging write (Set_Attribute_Single)
 * via SendRRData — no new framing code needed, cip/message-router.js's
 * buildRequest() already accepts any service code, Get and Set alike.
 *
 * Default target: Assembly Object (Class 0x04) Instance 100 Attribute 3
 * (Data) — the same instance read in examples/get-attribute.js, which
 * reported 200 zero bytes. This writes those exact same 200 zero bytes
 * back, so the device's state does not actually change — a safe way to
 * validate Set_Attribute_Single framing against a live, real device.
 *
 * Usage: node examples/set-attribute.js <host> [class] [instance] [attribute] [hexData]
 */

const { EIPSession } = require('../src/client');
const { encodeEPath } = require('../src/cip/path');
const { buildRequest } = require('../src/cip/message-router');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/set-attribute.js <host> [class] [instance] [attribute] [hexData]');
        process.exit(1);
    }
    const classId = process.argv[3] ? Number(process.argv[3]) : 0x04; // Assembly
    const instance = process.argv[4] ? Number(process.argv[4]) : 100;
    const attribute = process.argv[5] ? Number(process.argv[5]) : 3; // Data
    const hexData = process.argv[6] || '00'.repeat(200); // safe default: all-zero, matches known current value

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

    try {
        const path = encodeEPath({ classId, instance, attribute });
        const data = Buffer.from(hexData, 'hex');
        const request = buildRequest({ service: CipCommonServices.SetAttributeSingle, path, data });

        console.log(`\nSet_Attribute_Single — Class 0x${classId.toString(16)} Instance ${instance} Attribute ${attribute}, ${data.length} bytes`);
        const response = await session.sendUnconnected(request);

        if (response.generalStatus !== CipGeneralStatus.Success) {
            console.log(`FAILED — general status 0x${response.generalStatus.toString(16)}, additional status: ${response.additionalStatus.map((w) => '0x' + w.toString(16)).join(', ')}`);
        } else {
            console.log('OK — write accepted (empty response data expected on success).');
        }
    } finally {
        await session.close();
        console.log('\nSession closed.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
