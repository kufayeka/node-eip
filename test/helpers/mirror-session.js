'use strict';

const { parseRequest } = require('../../src/cip/message-router');
const { CipCommonServices, CipGeneralStatus } = require('../../src/constants');

/**
 * A fake CIP session that behaves like a real device's register store:
 * Set_Attribute_Single on a path stores the raw bytes written to it;
 * Get_Attribute_Single on the same path returns exactly what was last
 * stored there. This lets tests assert on genuine write-then-read
 * consistency ("mirroring") instead of only on the encoded request bytes.
 */
function makeMirrorSession() {
    const store = new Map();
    return {
        store,
        async sendUnconnected(request) {
            const { service, path, data } = parseRequest(request);
            const key = path.toString('hex');
            if (service === CipCommonServices.SetAttributeSingle) {
                store.set(key, Buffer.from(data));
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) };
            }
            if (service === CipCommonServices.GetAttributeSingle) {
                const stored = store.get(key);
                if (!stored) {
                    throw new Error(`mirror session: no value stored for path 0x${key} — write it first or seed() it`);
                }
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: stored };
            }
            throw new Error(`mirror session: unsupported service 0x${service.toString(16)}`);
        },
        // Directly populate a path's stored bytes — for read-only registers
        // (X/SM/SR), which a real device produces but this driver never writes.
        seed(path, buffer) {
            store.set(path.toString('hex'), buffer);
        }
    };
}

module.exports = { makeMirrorSession };
