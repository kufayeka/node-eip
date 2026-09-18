'use strict';

const assert = require('assert');
const net = require('net');
const { EIPAdapter } = require('../src/adapter');
const { DeviceBuilder } = require('../src/device/builder');
const { MessageRouterObject } = require('../src/cip/objects/message-router');
const { PortObject } = require('../src/cip/objects/port');
const { QoSObject } = require('../src/cip/objects/qos');
const { ParameterObject } = require('../src/cip/objects/parameter');
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
const { ConnectionManagerServices } = require('../src/cip/connection-manager');

describe('Full Standard CIP Object Model & Encapsulation Services', function () {
    describe('Message Router Object (Class 0x02)', function () {
        it('returns Implemented Object List on Instance 1 Attribute 1', function () {
            const mr = new MessageRouterObject();
            const res = mr.getAttributeSingle(1, 1);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            const count = res.data.readUInt16LE(0);
            assert(count >= 7);
            const classes = [];
            for (let i = 0; i < count; i++) {
                classes.push(res.data.readUInt16LE(2 + i * 2));
            }
            assert(classes.includes(0x01)); // Identity
            assert(classes.includes(0x02)); // Message Router
            assert(classes.includes(0x04)); // Assembly
            assert(classes.includes(0x06)); // Connection Manager
            assert(classes.includes(0x0f)); // Parameter
            assert(classes.includes(0x48)); // QoS
            assert(classes.includes(0xf4)); // Port
            assert(classes.includes(0xf5)); // TCP/IP
            assert(classes.includes(0xf6)); // Ethernet Link
        });

        it('returns Get_Attributes_All on Instance 1', function () {
            const mr = new MessageRouterObject();
            const res = mr.getAttributesAll(1);
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
            assert(res.data.length > 10);
        });

        it('dynamically adds newly registered class to object list', function () {
            const mr = new MessageRouterObject();
            mr.addClass(0x350);
            const res = mr.getAttributeSingle(1, 1);
            const count = res.data.readUInt16LE(0);
            const classes = [];
            for (let i = 0; i < count; i++) {
                classes.push(res.data.readUInt16LE(2 + i * 2));
            }
            assert(classes.includes(0x350));
        });
    });

    describe('Port Object (Class 0xF4)', function () {
        it('returns class attributes on Instance 0', function () {
            const port = new PortObject();
            const r1 = port.getAttributeSingle(0, 1); // Rev
            assert.strictEqual(r1.data.readUInt16LE(0), 1);
            const r2 = port.getAttributeSingle(0, 8); // Entry Port
            assert.strictEqual(r2.data.readUInt16LE(0), 1);
        });

        it('returns port description and link path on Instance 1', function () {
            const port = new PortObject({ portName: 'Port 1', portNumber: 1 });
            const r1 = port.getAttributeSingle(1, 1); // Port Type (4 = EtherNet/IP)
            assert.strictEqual(r1.data.readUInt16LE(0), 4);
            const r2 = port.getAttributeSingle(1, 2); // Port Number
            assert.strictEqual(r2.data.readUInt16LE(0), 1);
            const r3 = port.getAttributeSingle(1, 3); // Link Object EPATH
            assert.deepStrictEqual(r3.data, Buffer.from([0x20, 0xf6, 0x24, 0x01]));
            const r4 = port.getAttributeSingle(1, 4); // Port Name
            assert.strictEqual(r4.data.subarray(1).toString('ascii'), 'Port 1');
            const rAll = port.getAttributesAll(1);
            assert.strictEqual(rAll.generalStatus, CipGeneralStatus.Success);
        });
    });

    describe('Quality of Service (QoS) Object (Class 0x48)', function () {
        it('reads and writes DSCP priority values', function () {
            const qos = new QoSObject();
            const r1 = qos.getAttributeSingle(1, 2); // DSCP PTP Event
            assert.strictEqual(r1.data.readUInt8(0), 59);

            const setRes = qos.setAttributeSingle(1, 2, Buffer.from([50]));
            assert.strictEqual(setRes.generalStatus, CipGeneralStatus.Success);
            const r2 = qos.getAttributeSingle(1, 2);
            assert.strictEqual(r2.data.readUInt8(0), 50);

            const rAll = qos.getAttributesAll(1);
            assert.strictEqual(rAll.data.length, 8);
            assert.strictEqual(rAll.data.readUInt8(1), 50);
        });
    });

    describe('Parameter Object (Class 0x0F) Complete Model', function () {
        it('supports Class Attributes (0) and Get_Attributes_All', function () {
            const paramObj = new ParameterObject();
            paramObj.addParam({ code: '01-00', name: 'Freq', dataType: 'INT', default: 5000 });
            paramObj.addParam({ code: '01-01', name: 'Current', dataType: 'REAL', default: 12.5 });

            const rRev = paramObj.getAttributeSingle(0, 1);
            assert.strictEqual(rRev.data.readUInt16LE(0), 1);
            const rMax = paramObj.getAttributeSingle(0, 2);
            assert.strictEqual(rMax.data.readUInt16LE(0), 2);
            const rDesc = paramObj.getAttributeSingle(0, 8);
            assert.strictEqual(rDesc.data.readUInt16LE(0), 0x000b);

            const rClassAll = paramObj.getAttributesAll(0);
            assert.strictEqual(rClassAll.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(rClassAll.data.length, 10);
        });

        it('supports Instance Attributes (1..19) and Get_Attributes_All', function () {
            const paramObj = new ParameterObject();
            paramObj.addParam({
                code: '01-00',
                name: 'TargetFrequency',
                dataType: 'INT',
                units: '0.01 Hz',
                min: 0,
                max: 6000,
                default: 5000,
                help: 'Target speed command'
            });

            const rVal = paramObj.getAttributeSingle(1, 1);
            assert.strictEqual(rVal.data.readInt16LE(0), 5000);
            const rUnits = paramObj.getAttributeSingle(1, 12);
            assert.strictEqual(rUnits.data.subarray(1).toString('ascii'), '0.01 Hz');
            const rHelp = paramObj.getAttributeSingle(1, 13);
            assert.strictEqual(rHelp.data.subarray(1).toString('ascii'), 'Target speed command');
            const rName = paramObj.getAttributeSingle(1, 19);
            assert.strictEqual(rName.data.subarray(1).toString('ascii'), 'TargetFrequency');

            const rInstAll = paramObj.getAttributesAll(1);
            assert.strictEqual(rInstAll.generalStatus, CipGeneralStatus.Success);
            assert(rInstAll.data.length >= 9);
        });
    });

    describe('Live Encapsulation & Routing Integration', function () {
        let adapter;
        const TCP_PORT = 44820;

        before(async function () {
            adapter = new EIPAdapter({ port: TCP_PORT, ioPort: 22220, address: '127.0.0.1' });
            await adapter.start();
        });

        after(async function () {
            if (adapter) await adapter.stop();
        });

        it('handles ListInterfaces (0x0064) with valid 0-item CPF', async function () {
            const client = new net.Socket();
            await new Promise((resolve) => client.connect(TCP_PORT, '127.0.0.1', resolve));

            const req = encodeMessage({ command: EncapsulationCommands.ListInterfaces, senderContext: Buffer.alloc(8) });
            client.write(req);

            const resBuf = await new Promise((resolve) => client.once('data', resolve));
            const decoded = decodeMessage(resBuf);
            assert.strictEqual(decoded.header.command, EncapsulationCommands.ListInterfaces);
            assert.strictEqual(decoded.header.status, EncapsulationStatus.Success);
            assert.strictEqual(decoded.data.readUInt16LE(0), 0); // Item count = 0
            client.destroy();
        });

        it('handles SendUnitData (0x0070) for Connected Explicit Messaging', async function () {
            const client = new net.Socket();
            await new Promise((resolve) => client.connect(TCP_PORT, '127.0.0.1', resolve));

            // 1. Register Session
            const regReq = encodeMessage({ command: EncapsulationCommands.RegisterSession }, Buffer.from([0x01, 0x00, 0x00, 0x00]));
            client.write(regReq);
            const regResBuf = await new Promise((resolve) => client.once('data', resolve));
            const regMsg = decodeMessage(regResBuf);
            const sessionHandle = regMsg.header.sessionHandle;

            // 2. Build SendUnitData request (Message Router Get_Attribute_Single on Identity Class 0x01 Inst 1 Attr 1)
            const cipReq = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: encodeEPath({ classId: CipClassCodes.Identity, instance: 1, attribute: 1 })
            });

            const connId = 0x12345678;
            const connAddr = Buffer.alloc(4);
            connAddr.writeUInt32LE(connId, 0);

            const seqBuf = Buffer.alloc(2);
            seqBuf.writeUInt16LE(1, 0); // Sequence count = 1
            const transportData = Buffer.concat([seqBuf, cipReq]);

            const cpf = encodeCpf([
                { typeId: CpfItemType.ConnectedAddress, data: connAddr },
                { typeId: CpfItemType.ConnectedTransportData, data: transportData }
            ]);
            const prefix = Buffer.alloc(6);
            const fullPayload = Buffer.concat([prefix, cpf]);

            const unitMsg = encodeMessage({
                command: EncapsulationCommands.SendUnitData,
                sessionHandle,
                senderContext: Buffer.alloc(8)
            }, fullPayload);
            client.write(unitMsg);

            const unitResBuf = await new Promise((resolve) => client.once('data', resolve));
            const decodedUnit = decodeMessage(unitResBuf);
            assert.strictEqual(decodedUnit.header.command, EncapsulationCommands.SendUnitData);
            assert.strictEqual(decodedUnit.header.status, EncapsulationStatus.Success);

            const { items } = decodeCpf(decodedUnit.data.subarray(6));
            const respData = items.find((i) => i.typeId === CpfItemType.ConnectedTransportData);
            assert(respData);
            assert.strictEqual(respData.data.readUInt16LE(0), 1); // Echoed sequence count
            const cipResp = parseResponse(respData.data.subarray(2));
            assert.strictEqual(cipResp.generalStatus, CipGeneralStatus.Success);
            assert.strictEqual(cipResp.data.length, 2); // Vendor ID

            client.destroy();
        });

        it('handles Unconnected_Send (0x52) via Connection Manager', async function () {
            const client = new net.Socket();
            await new Promise((resolve) => client.connect(TCP_PORT, '127.0.0.1', resolve));

            // Register session
            const regReq = encodeMessage({ command: EncapsulationCommands.RegisterSession }, Buffer.from([0x01, 0x00, 0x00, 0x00]));
            client.write(regReq);
            const regResBuf = await new Promise((resolve) => client.once('data', resolve));
            const sessionHandle = decodeMessage(regResBuf).header.sessionHandle;

            // Embedded CIP Request: Get_Attribute_Single on Message Router (Class 0x02 Inst 1 Attr 1)
            const embeddedReq = buildRequest({
                service: CipCommonServices.GetAttributeSingle,
                path: encodeEPath({ classId: CipClassCodes.MessageRouter, instance: 1, attribute: 1 })
            });

            // Unconnected_Send payload: Priority/Tick(1), Timeout(1), Size(2), EmbeddedReq
            const unconnHdr = Buffer.alloc(4);
            unconnHdr.writeUInt8(0x0a, 0);
            unconnHdr.writeUInt8(0x05, 1);
            unconnHdr.writeUInt16LE(embeddedReq.length, 2);
            const unconnData = Buffer.concat([unconnHdr, embeddedReq]);

            const unconnCipReq = buildRequest({
                service: ConnectionManagerServices.UnconnectedSend,
                path: encodeEPath({ classId: CipClassCodes.ConnectionManager, instance: 1 }),
                data: unconnData
            });

            // Send via SendRRData
            const cpf = encodeCpf([
                { typeId: CpfItemType.NullAddress, data: Buffer.alloc(0) },
                { typeId: CpfItemType.UnconnectedData, data: unconnCipReq }
            ]);
            const prefix = Buffer.alloc(6);
            const sendMsg = encodeMessage({
                command: EncapsulationCommands.SendRRData,
                sessionHandle,
                senderContext: Buffer.alloc(8)
            }, Buffer.concat([prefix, cpf]));

            client.write(sendMsg);
            const sendResBuf = await new Promise((resolve) => client.once('data', resolve));
            const decodedSend = decodeMessage(sendResBuf);
            const { items } = decodeCpf(decodedSend.data.subarray(6));
            const unconnItem = items.find((i) => i.typeId === CpfItemType.UnconnectedData);
            const outerResp = parseResponse(unconnItem.data);
            assert.strictEqual(outerResp.generalStatus, CipGeneralStatus.Success);

            // Inner response returned in outerResp.data
            const innerResp = parseResponse(outerResp.data);
            assert.strictEqual(innerResp.generalStatus, CipGeneralStatus.Success);
            const objCount = innerResp.data.readUInt16LE(0);
            assert(objCount >= 7); // Contains implemented object list!

            client.destroy();
        });
    });
});
