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

    it('readD() on an "es2" device uses Class 0x352 Instance 1, flat Attribute = D number (manual Appendix B.5.2, 2026-09 correction)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        let capturedRequest;
        const data = Buffer.alloc(2);
        data.writeInt16LE(4321, 0);
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data };
            }
        };

        const value = await device.readD(3);

        assert.strictEqual(value, 4321);
        // Class 0x352 (D Register, 16-bit segment), Instance 1 (not 2!), Attribute 3
        assert.deepStrictEqual(capturedRequest.subarray(2, 10), Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x01, 0x30, 0x03]));
    });

    it('readX() on an "es2" device reads bit-mode via Class 0x350 (confirmed live against real hardware)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        let capturedRequest;
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0x01]) };
            }
        };

        const value = await device.readX(2);

        assert.strictEqual(value, true);
        // Class 0x350 (X Register, 16-bit segment), Instance 1 (bit), Attribute 2
        assert.deepStrictEqual(capturedRequest.subarray(2, 10), Buffer.from([0x21, 0x00, 0x50, 0x03, 0x24, 0x01, 0x30, 0x02]));
    });

    it('writeD() on an "es2" device uses Class 0x352 Instance 1, flat Attribute = D number, 16-bit INT payload (2026-09 correction, pending live re-confirmation)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        let capturedRequest;
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) };
            }
        };

        await device.writeD(0, 1234);

        assert.strictEqual(capturedRequest.readUInt8(0), CipCommonServices.SetAttributeSingle);
        assert.deepStrictEqual(capturedRequest.subarray(2, 10), Buffer.from([0x21, 0x00, 0x52, 0x03, 0x24, 0x01, 0x30, 0x00]));
        assert.deepStrictEqual(capturedRequest.subarray(-2), Buffer.from([0xd2, 0x04])); // 1234 LE
    });

    it('writeM() on an "es2" device writes bit-mode via Class 0x353 (confirmed live turning on a real relay)', async function () {
        const device = new DeltaDevice('127.0.0.1', 'es2');
        let capturedRequest;
        device.scanner.session = {
            sendUnconnected: async (cipRequest) => {
                capturedRequest = cipRequest;
                return { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) };
            }
        };

        await device.writeM(10, true);

        assert.strictEqual(capturedRequest.readUInt8(0), CipCommonServices.SetAttributeSingle);
        assert.deepStrictEqual(capturedRequest.subarray(-1), Buffer.from([0x01]));
    });
});
