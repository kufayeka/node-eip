'use strict';

const assert = require('assert');
const { readD, D_WINDOWS } = require('../src/delta/device-types/es2');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

function stubSession(handler) {
    return { sendUnconnected: handler };
}

describe('es2 profile — multi-window D read', function () {
    it('exposes 8 windows of 100 words each, covering D0-D799', function () {
        assert.strictEqual(D_WINDOWS.length, 8);
        assert.deepStrictEqual(D_WINDOWS.map((w) => w.base), [0, 100, 200, 300, 400, 500, 600, 700]);
        assert.deepStrictEqual(D_WINDOWS.map((w) => w.instance), [101, 103, 105, 107, 109, 111, 113, 115]);
    });

    it('reads D0 from Instance 101 at offset 0', async function () {
        const data = Buffer.alloc(200);
        data.writeInt16LE(10, 0);
        const session = stubSession(async (cipRequest) => {
            assert.strictEqual(cipRequest.readUInt8(0), CipCommonServices.GetAttributeSingle);
            assert.strictEqual(cipRequest.readUInt8(5), 101); // instance segment value
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
        });
        assert.strictEqual(await readD(session, 0), 10);
    });

    it('reads D100 from Instance 103 at offset 0 (the window boundary)', async function () {
        const data = Buffer.alloc(200);
        data.writeInt16LE(1111, 0);
        const session = stubSession(async (cipRequest) => {
            assert.strictEqual(cipRequest.readUInt8(5), 103); // instance segment value
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
        });
        assert.strictEqual(await readD(session, 100), 1111);
    });

    it('reads D502 from Instance 111 at offset 4 (byte offset (502-500)*2)', async function () {
        const data = Buffer.alloc(200);
        data.writeInt16LE(62, 4);
        const session = stubSession(async (cipRequest) => {
            assert.strictEqual(cipRequest.readUInt8(5), 111);
            return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
        });
        assert.strictEqual(await readD(session, 502), 62);
    });

    it('rejects a D number outside the confirmed 0-799 range without sending a request', async function () {
        const session = stubSession(async () => { throw new Error('should not be called'); });
        await assert.rejects(() => readD(session, 800), /outside the confirmed readable range/);
    });
});
