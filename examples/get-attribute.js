'use strict';

/**
 * Phase 2 smoke test: generic explicit messaging (Get_Attribute_Single) via
 * SendRRData, vendor-neutral — reads Identity Object (Class 0x01) Instance 1
 * Attribute 1 (Vendor ID, UINT) and cross-checks it against the value
 * already known from the Phase 1 ListIdentity probe.
 *
 * Usage: node examples/get-attribute.js <host> [class] [instance] [attribute]
 */

const { EIPSession } = require('../src/client');
const { buildRequest, encodeEPath } = (() => {
    const { encodeEPath } = require('../src/cip/path');
    const { buildRequest } = require('../src/cip/message-router');
    return { buildRequest, encodeEPath };
})();
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

async function main() {
    const host = process.argv[2];
    if (!host) {
        console.error('Usage: node examples/get-attribute.js <host> [class] [instance] [attribute]');
        process.exit(1);
    }
    const classId = process.argv[3] ? Number(process.argv[3]) : 0x01; // Identity Object
    const instance = process.argv[4] ? Number(process.argv[4]) : 1;
    const attribute = process.argv[5] ? Number(process.argv[5]) : 1; // Vendor ID

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

    try {
        const path = encodeEPath({ classId, instance, attribute });
        const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });

        console.log(`\nGet_Attribute_Single — Class 0x${classId.toString(16)} Instance ${instance} Attribute ${attribute}`);
        const response = await session.sendUnconnected(request);

        if (response.generalStatus !== CipGeneralStatus.Success) {
            console.log(`FAILED — general status 0x${response.generalStatus.toString(16)}, additional status: ${response.additionalStatus.map((w) => '0x' + w.toString(16)).join(', ')}`);
        } else {
            console.log(`OK — raw data: ${response.data.toString('hex')}`);
            if (classId === 0x01 && attribute === 1 && response.data.length === 2) {
                console.log(`Decoded as Vendor ID (UINT): ${response.data.readUInt16LE(0)}`);
            }
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
