'use strict';

const assert = require('assert');
const { DeltaDevice } = require('../src/delta/device');
const { DeltaBatchBuilder } = require('../src/delta/batch');
const { CipGeneralStatus } = require('../src/constants');

describe('Delta Batch Operations (§25 Multiple Service Packet)', function () {
    it('DeltaBatchBuilder queues register read and write operations', function () {
        const builder = new DeltaBatchBuilder();
        builder.writeYBit(0, true);
        builder.writeD(10, 1234);
        builder.readD(10);
        builder.readYBit(0);

        assert.strictEqual(builder.length, 4);
        assert.strictEqual(builder.operations[0].service, 0x10); // Set_Attribute_Single
        assert.deepStrictEqual(builder.operations[0].data, Buffer.from([1]));
        assert.strictEqual(builder.operations[1].service, 0x10);
        assert.strictEqual(builder.operations[1].data.readInt16LE(0), 1234);
        assert.strictEqual(builder.operations[2].service, 0x0E); // Get_Attribute_Single
        assert.strictEqual(builder.operations[3].service, 0x0E);
    });

    it('DeltaBatchBuilder rejects writes to read-only register classes', function () {
        const builder = new DeltaBatchBuilder();
        assert.throws(() => builder._addWordWrite(0x350, 0, 1), /read-only/); // X
        assert.throws(() => builder._addBitWrite(0x358, 0, 1), /read-only/);  // SM
    });

    it('DeltaDevice.batch executes multiple operations in a single multi-service request', async function () {
        const dev = new DeltaDevice('127.0.0.1', 'sx3');
        let capturedRequests;

        // Stub scanner.sendMultipleRequests
        dev.scanner.sendMultipleRequests = async (requests) => {
            capturedRequests = requests;
            return [
                { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) },
                { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.alloc(0) },
                { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0xd2, 0x04]) }, // 1234
                { generalStatus: CipGeneralStatus.Success, additionalStatus: [], data: Buffer.from([0x01]) }        // true
            ];
        };

        const results = await dev.batch((b) => {
            b.writeYBit(0, true);
            b.writeD(10, 1234);
            b.readD(10);
            b.readYBit(0);
        });

        assert.strictEqual(capturedRequests.length, 4);
        assert.deepStrictEqual(results, [true, true, 1234, true]);
    });

    it('DeltaDevice.batch returns empty array when no operations are queued', async function () {
        const dev = new DeltaDevice('127.0.0.1', 'sx3');
        const results = await dev.batch(() => {});
        assert.deepStrictEqual(results, []);
    });

    it('DeltaDevice.batch throws when a sub-operation returns an error status', async function () {
        const dev = new DeltaDevice('127.0.0.1', 'sx3');
        dev.scanner.sendMultipleRequests = async () => [
            { generalStatus: CipGeneralStatus.AttributeNotSupported, additionalStatus: [], data: Buffer.alloc(0) }
        ];

        await assert.rejects(
            () => dev.batch((b) => { b.readD(99999); }),
            /failed with CIP status 0x14/
        );
    });
});
