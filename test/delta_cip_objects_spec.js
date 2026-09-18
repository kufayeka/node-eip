'use strict';

const assert = require('assert');
const net = require('net');
const { EIPAdapter } = require('../src/adapter');
const { DeviceLevelRingObject } = require('../src/cip/objects/dlr');
const { ConnectionManagerObject } = require('../src/cip/objects/connection-manager-object');
const { DeltaRegisterStore, DeltaRegisterObject } = require('../src/cip/objects/delta-registers');
const { GenericCipObject } = require('../src/cip/objects/generic-object');
const { encodeMessage, decodeMessage } = require('../src/encapsulation/header');
const { encodeCpf, decodeCpf, CpfItemType } = require('../src/encapsulation/cpf');
const { buildRequest, parseResponse } = require('../src/cip/message-router');
const { encodeEPath } = require('../src/cip/path');
const {
    EncapsulationCommands,
    EncapsulationStatus,
    CipClassCodes,
    CipCommonServices,
    CipGeneralStatus
} = require('../src/constants');

describe('Delta Specific & ODVA Compliant CIP Objects', function () {
    describe('Device Level Ring Object (Class 0x47)', function () {
        it('returns revision 3 on Class attribute 1', function () {
            const dlr = new DeviceLevelRingObject();
            const res = dlr.getAttributeSingle(0, 1);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(res.data.readUInt16LE(0), 3);
        });

        it('returns Linear topology (0) and Normal status (0) on Instance 1', function () {
            const dlr = new DeviceLevelRingObject();
            const r1 = dlr.getAttributeSingle(1, 1); // Topology
            assert.strictEqual(r1.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(r1.data[0], 0);

            const r2 = dlr.getAttributeSingle(1, 2); // Status
            assert.strictEqual(r2.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(r2.data[0], 0);

            const r3 = dlr.getAttributeSingle(1, 3); // Ring Supervisor Status (2: Normal Node)
            assert.strictEqual(r3.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(r3.data[0], 2);
        });

        it('returns Get_Attributes_All on Instance 1', function () {
            const dlr = new DeviceLevelRingObject();
            const res = dlr.getAttributesAll(1);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert(res.data.length >= 25);
        });
    });

    describe('Connection Manager Object (Class 0x06)', function () {
        it('returns statistics on Instance 1', function () {
            const cm = new ConnectionManagerObject();
            cm.recordOpenRequest(true);
            cm.recordOpenRequest(false, 'resource');
            cm.recordCloseRequest(true);

            const rOpen = cm.getAttributeSingle(1, 1);
            assert.strictEqual(rOpen.data.readUInt16LE(0), 2);

            const rRej = cm.getAttributeSingle(1, 3);
            assert.strictEqual(rRej.data.readUInt16LE(0), 1);

            const rClose = cm.getAttributeSingle(1, 5);
            assert.strictEqual(rClose.data.readUInt16LE(0), 1);

            const rAll = cm.getAttributesAll(1);
            assert.strictEqual(rAll.data.length, 16);
        });
    });

    describe('Delta Registers Objects (Classes 0x350 - 0x359, 0x370 - 0x372)', function () {
        let store;
        beforeEach(function () {
            store = new DeltaRegisterStore();
        });

        it('reads and writes D-Registers (Class 0x352) in word mode (Instance 2)', function () {
            const dObj = new DeltaRegisterObject(0x352, store);
            store.setD(10, 12345);

            const r1 = dObj.getAttributeSingle(2, 10);
            assert.strictEqual(r1.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(r1.data.readInt16LE(0), 12345);

            // Write via Set_Attribute_Single
            const writeBuf = Buffer.alloc(2);
            writeBuf.writeInt16LE(25000, 0);
            const wRes = dObj.setAttributeSingle(2, 10, writeBuf);
            assert.strictEqual(wRes.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(store.getD(10), 25000);
        });

        it('reads and writes D-Registers (Class 0x352) in bit mode (Instance 1)', function () {
            const dObj = new DeltaRegisterObject(0x352, store);
            store.setD(0, 0x0001); // bit 0 is 1

            const b0 = dObj.getAttributeSingle(1, 0);
            assert.strictEqual(b0.data[0], 1);

            const b1 = dObj.getAttributeSingle(1, 1);
            assert.strictEqual(b1.data[0], 0);

            // Set bit 1 to 1 (offset 1 in D0)
            dObj.setAttributeSingle(1, 1, Buffer.from([1]));
            assert.strictEqual(store.getD(0), 0x0003);
        });

        it('reads and writes M-Relays (Class 0x353) in bit mode (Instance 1)', function () {
            const mObj = new DeltaRegisterObject(0x353, store);
            store.setM(100, 1);

            const r1 = mObj.getAttributeSingle(1, 100);
            assert.strictEqual(r1.data[0], 1);

            mObj.setAttributeSingle(1, 100, Buffer.from([0]));
            assert.strictEqual(store.getM(100), 0);
        });

        it('supports Delta native services 0x32 (Read_Parameter) and 0x33 (Write_Parameter)', function () {
            const dObj = new DeltaRegisterObject(0x352, store);
            store.setD(50, 9999);

            // Service 0x32 Read_Parameter
            const readRes = dObj.handleService(0x32, { instance: 2, attribute: 50 }, Buffer.alloc(0));
            assert.strictEqual(readRes.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(readRes.data.readInt16LE(0), 9999);

            // Service 0x33 Write_Parameter
            const writeBuf = Buffer.alloc(2);
            writeBuf.writeInt16LE(7777, 0);
            const writeRes = dObj.handleService(0x33, { instance: 2, attribute: 50 }, writeBuf);
            assert.strictEqual(writeRes.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(store.getD(50), 7777);
        });
    });

    describe('Generic Extensible CIP Object Framework', function () {
        it('supports arbitrary Class ID, instances, and typed attributes (STRING, STRUCT, INT)', function () {
            const custom = new GenericCipObject({ classId: 0x68, revision: 2, name: 'CustomMotor' });
            custom.setAttribute(1, 1, 'DELTA-DRIVE-C2000', 'STRING');
            custom.setAttribute(1, 2, 45.5, 'REAL');
            custom.setAttribute(1, 3, 1500, 'INT');

            // Read STRING attribute
            const r1 = custom.getAttributeSingle(1, 1);
            assert.strictEqual(r1.generalStatus, CipGeneralStatus.Success);
            const strLen = r1.data.readUInt16LE(0);
            assert.strictEqual(r1.data.subarray(2, 2 + strLen).toString('ascii'), 'DELTA-DRIVE-C2000');

            // Read REAL attribute
            const r2 = custom.getAttributeSingle(1, 2);
            assert(Math.abs(r2.data.readFloatLE(0) - 45.5) < 0.01);

            // Read INT attribute
            const r3 = custom.getAttributeSingle(1, 3);
            assert.strictEqual(r3.data.readInt16LE(0), 1500);

            // Write attribute
            const writeReal = Buffer.alloc(4);
            writeReal.writeFloatLE(50.0, 0);
            custom.setAttributeSingle(1, 2, writeReal);
            assert.strictEqual(custom.getAttribute(1, 2), 50.0);
        });
    });

    describe('EIPAdapter Online Access to Delta Vendor Objects', function () {
        let adapter;
        const TCP_PORT = 44922;

        before(async function () {
            adapter = new EIPAdapter({ port: TCP_PORT, ioPort: 22223, address: '127.0.0.1' });
            await adapter.start();
        });

        after(async function () {
            if (adapter) await adapter.stop();
        });

        it('dispatches CIP requests to Delta D Register (0x352) over SendRRData', async function () {
            adapter.deltaStore.setD(100, 31415);

            const client = new net.Socket();
            await new Promise((resolve) => client.connect(TCP_PORT, '127.0.0.1', resolve));

            // 1. Register Session
            const regReq = encodeMessage({ command: EncapsulationCommands.RegisterSession }, Buffer.from([0x01, 0x00, 0x00, 0x00]));
            client.write(regReq);
            const regResBuf = await new Promise((resolve) => client.once('data', resolve));
            const regMsg = decodeMessage(regResBuf);
            const sessionHandle = regMsg.header.sessionHandle;

            // 2. Query Delta D100 (Class 0x352, Inst 2, Attr 100) via Service 0x0E
            const cipReq = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: encodeEPath({ classId: 0x352, instance: 2, attribute: 100 })
            });

            const cpf = encodeCpf([
                { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
                { typeId: CpfItemType.UnconnectedData, data: cipReq }
            ]);
            const prefix = Buffer.alloc(6);
            const fullPayload = Buffer.concat([prefix, cpf]);

            const rrMsg = encodeMessage({
                command: EncapsulationCommands.SendRRData,
                sessionHandle,
                senderContext: Buffer.alloc(8)
            }, fullPayload);

            client.write(rrMsg);

            const rrResBuf = await new Promise((resolve) => client.once('data', resolve));
            const rrResp = decodeMessage(rrResBuf);
            const { items } = decodeCpf(rrResp.data.subarray(6));
            const dataItem = items.find(i => i.typeId === CpfItemType.UnconnectedData);
            const cipResp = parseResponse(dataItem.data);

            assert.strictEqual(cipResp.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(cipResp.data.readInt16LE(0), 31415);
            client.destroy();
        });

        it('dispatches CIP requests to DLR Object (0x47) over SendRRData', async function () {
            const client = new net.Socket();
            await new Promise((resolve) => client.connect(TCP_PORT, '127.0.0.1', resolve));

            const regReq = encodeMessage({ command: EncapsulationCommands.RegisterSession }, Buffer.from([0x01, 0x00, 0x00, 0x00]));
            client.write(regReq);
            const regResBuf = await new Promise((resolve) => client.once('data', resolve));
            const regMsg = decodeMessage(regResBuf);
            const sessionHandle = regMsg.header.sessionHandle;

            // Query DLR Class 0x47, Inst 1, Attr 1 (Network Topology)
            const cipReq = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: encodeEPath({ classId: 0x47, instance: 1, attribute: 1 })
            });

            const cpf = encodeCpf([
                { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
                { typeId: CpfItemType.UnconnectedData, data: cipReq }
            ]);
            const prefix = Buffer.alloc(6);
            const fullPayload = Buffer.concat([prefix, cpf]);

            const rrMsg = encodeMessage({
                command: EncapsulationCommands.SendRRData,
                sessionHandle,
                senderContext: Buffer.alloc(8)
            }, fullPayload);

            client.write(rrMsg);

            const rrResBuf = await new Promise((resolve) => client.once('data', resolve));
            const rrResp = decodeMessage(rrResBuf);
            const { items } = decodeCpf(rrResp.data.subarray(6));
            const dataItem = items.find(i => i.typeId === CpfItemType.UnconnectedData);
            const cipResp = parseResponse(dataItem.data);

            assert.strictEqual(cipResp.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(cipResp.data[0], 0); // Linear topology
            client.destroy();
        });
    });
});
