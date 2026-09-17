'use strict';

const assert = require('assert');
const { DeltaDevice } = require('../src/delta/device');
const { CipCommonServices, CipGeneralStatus } = require('../src/constants');

describe('DeltaDevice (explicit device-type wrapper)', function () {
    it('throws immediately in the constructor for an unknown device type', function () {
        assert.throws(() => new DeltaDevice('127.0.0.1', 'nonexistent-plc'), /Unknown Delta device type/);
    });

    it('readD() on an "sx3" device delegates to the vendor Register Object path', async function () {
        const device = new DeltaDevice('127.0.0.1', 'sx3');
        let capturedRequest;
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0xd2, 0x04]) };
            }
        };

        const value = await device.readD(100);

        assert.strictEqual(value, 1234);
        assert.strictEqual(capturedRequest.readUInt8(0), CipCommonServices.GetAttributeSingle);
        // Class 0x352 (D Register, 16-bit segment), Instance 2 (word), Attribute 100
        assert.deepStrictEqual(capturedRequest.subarray(2, 10), Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x02, 0x30, 0x64]));
    });

    it('readD() on an "es2" device delegates to the Assembly-window fallback (Instance 101)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        let capturedRequest;
        const data = Buffer.alloc(200);
        data.writeInt16LE(4321, 6); // register 3 -> byte offset 6
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
            }
        };

        const value = await device.readD(3);

        assert.strictEqual(value, 4321);
        // Class 0x04 (Assembly, 8-bit), Instance 101 (8-bit, fits in 0xFF), Attribute 3 (Data)
        assert.deepStrictEqual(capturedRequest.subarray(2, 8), Buffer.from([0x20, 0x04, 0x24, 0x65, 0x30, 0x03]));
    });

    it('readX() on an "es2" device rejects clearly (no confirmed mapping)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        device.scanner.session = { sendUnconnected: async () => { throw new Error('should not be called'); } };
        await assert.rejects(() => device.readX(0), /not supported for device type "es2"/);
    });
});
