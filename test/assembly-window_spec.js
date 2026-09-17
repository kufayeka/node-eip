'use strict';

const assert = require('assert');
const { makeWordWindow } = require('../src/delta/assembly-window');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

function stubSession(handler) {
    return { sendUnconnected: handler };
}

describe('Assembly-window fallback register access', function () {
    it('read() decodes the register at (n - base) * 2 as a signed 16-bit LE word', async function () {
        const data = Buffer.alloc(200);
        data.writeInt16LE(1234, 4); // register index 2 (base 0) -> offset 4

        const session = stubSession(async (cipRequest) => {
            assert.strictEqual(cipRequest.readUInt8(0), CipCommonServices.GetAttributeSingle);
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
        });

        const window = makeWordWindow({ instance: 101, base: 0, writable: false });
        assert.strictEqual(await window.read(session, 2), 1234);
    });

    it('write() throws for a non-writable window without sending anything', async function () {
        const window = makeWordWindow({ instance: 101, base: 0, writable: false });
        const session = stubSession(async () => { throw new Error('should not be called'); });
        await assert.rejects(() => window.write(session, 2, 1), /read-only/);
    });

    it('write() reads the current image, patches one word, and writes it back', async function () {
        const current = Buffer.alloc(200);
        let written;
        let calls = 0;
        const session = stubSession(async (cipRequest) => {
            calls++;
            if (calls === 1) {
                // the read-before-write
                assert.strictEqual(cipRequest.readUInt8(0), CipCommonServices.GetAttributeSingle);
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: current };
            }
            assert.strictEqual(cipRequest.readUInt8(0), CipCommonServices.SetAttributeSingle);
            written = cipRequest.subarray(-200);
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) };
        });

        const window = makeWordWindow({ instance: 100, base: 0, writable: true });
        await window.write(session, 3, 777);

        assert.strictEqual(written.readInt16LE(6), 777); // register 3 -> offset 6
    });

    it('applies a nonzero base offset when mapping register number to byte offset', async function () {
        const data = Buffer.alloc(20);
        data.writeInt16LE(42, 0); // first word in this window's data represents register `base`

        const session = stubSession(async () => ({ generalStatus: CipGeneralStatus.Success, additionalStatus: [], data }));
        const window = makeWordWindow({ instance: 105, base: 500, writable: false });
        assert.strictEqual(await window.read(session, 500), 42);
    });
});
