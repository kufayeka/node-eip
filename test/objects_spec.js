'use strict';

const assert = require('assert');
const { IdentityObject } = require('../src/cip/objects/identity');
const { AssemblyObject } = require('../src/cip/objects/assembly');
const { CipGeneralStatus } = require('../src/constants');

describe('Server-side Identity Object', function () {
    const identity = new IdentityObject({
        vendorId: 0xffff,
        deviceType: 14,
        productCode: 1,
        revision: { major: 1, minor: 2 },
        productName: 'node-eip-adapter',
        serialNumber: 0x12345678
    });

    it('answers Instance 0 class attributes (Revision/Max Instance/Number of Instances)', function () {
        assert.strictEqual(identity.getAttributeSingle(0, 1).data.readUInt16LE(0), 1); // Revision
        assert.strictEqual(identity.getAttributeSingle(0, 2).data.readUInt16LE(0), 1); // Max Instance
        assert.strictEqual(identity.getAttributeSingle(0, 3).data.readUInt16LE(0), 1); // Number of Instances
        assert.strictEqual(identity.getAttributeSingle(0, 99).generalStatus, CipGeneralStatus.AttributeNotSupported);
    });

    it('answers Vendor ID (attribute 1) at Instance 1', function () {
        const res = identity.getAttributeSingle(1, 1);
        assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        assert.strictEqual(res.data.readUInt16LE(0), 0xffff);
    });

    it('answers Product Name (attribute 7) as a SHORT_STRING', function () {
        const res = identity.getAttributeSingle(1, 7);
        assert.strictEqual(res.data.readUInt8(0), 'node-eip-adapter'.length);
        assert.strictEqual(res.data.subarray(1).toString('ascii'), 'node-eip-adapter');
    });

    it('rejects any instance other than 1', function () {
        const res = identity.getAttributeSingle(2, 1);
        assert.strictEqual(res.generalStatus, CipGeneralStatus.PathDestinationUnknown);
    });

    it('rejects an unknown attribute', function () {
        const res = identity.getAttributeSingle(1, 99);
        assert.strictEqual(res.generalStatus, CipGeneralStatus.AttributeNotSupported);
    });

    it('is read-only (Set_Attribute_Single always rejected)', function () {
        const res = identity.setAttributeSingle(1, 1, Buffer.from([0, 0]));
        assert.strictEqual(res.generalStatus, CipGeneralStatus.AttributeNotSettable);
    });

    describe('Reset service (0x05) — CIP Vol 1 5-2.5.4, ported from OpENer IdentityObjectPreResetCallback', function () {
        it('accepts reset type 0 (emulate power cycle) with no request data (implied type 0)', function () {
            const res = identity.handleService(0x05, { instance: 1 }, Buffer.alloc(0));
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        });

        it('accepts reset type 0 explicitly and emits a "reset" event', function (done) {
            identity.once('reset', (type) => {
                assert.strictEqual(type, 0);
                done();
            });
            const res = identity.handleService(0x05, { instance: 1 }, Buffer.from([0]));
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        });

        it('accepts reset type 1 (return to factory defaults)', function () {
            const res = identity.handleService(0x05, { instance: 1 }, Buffer.from([1]));
            assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        });

        it('rejects reset type 2 (and any other unsupported type) as InvalidParameterValue', function () {
            const res = identity.handleService(0x05, { instance: 1 }, Buffer.from([2]));
            assert.strictEqual(res.generalStatus, CipGeneralStatus.InvalidParameterValue);
        });

        it('rejects more than 1 byte of request data as TooMuchData', function () {
            const res = identity.handleService(0x05, { instance: 1 }, Buffer.from([0, 0]));
            assert.strictEqual(res.generalStatus, CipGeneralStatus.TooMuchData);
        });

        it('returns null (falls through) for any other service code', function () {
            const res = identity.handleService(0x0e, { instance: 1 }, Buffer.alloc(0));
            assert.strictEqual(res, null);
        });
    });
});

describe('Server-side Assembly Object', function () {
    it('answers Instance 0 class attributes, reflecting whatever instances are currently defined', function () {
        const assembly = new AssemblyObject().define(100, 4).define(101, 4).define(130, 8);
        assert.strictEqual(assembly.getAttributeSingle(0, 1).data.readUInt16LE(0), 2); // Revision
        assert.strictEqual(assembly.getAttributeSingle(0, 2).data.readUInt16LE(0), 130); // Max Instance
        assert.strictEqual(assembly.getAttributeSingle(0, 3).data.readUInt16LE(0), 3); // Number of Instances
        assert.strictEqual(assembly.getAttributeSingle(0, 99).generalStatus, CipGeneralStatus.AttributeNotSupported);
    });

    it('Instance 0 Max Instance/Number of Instances are both 0 before any instance is defined', function () {
        const assembly = new AssemblyObject();
        assert.strictEqual(assembly.getAttributeSingle(0, 2).data.readUInt16LE(0), 0);
        assert.strictEqual(assembly.getAttributeSingle(0, 3).data.readUInt16LE(0), 0);
    });

    it('Get_Attribute_Single Attribute 4 (Size) matches the defined instance size', function () {
        const assembly = new AssemblyObject().define(101, 200);
        const res = assembly.getAttributeSingle(101, 4);
        assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        assert.strictEqual(res.data.readUInt16LE(0), 200);
    });

    it('Get_Attribute_Single Attribute 3 (Data) starts all-zero', function () {
        const assembly = new AssemblyObject().define(101, 4);
        const res = assembly.getAttributeSingle(101, 3);
        assert.deepStrictEqual(res.data, Buffer.alloc(4));
    });

    it('Set_Attribute_Single writes Data when the length matches exactly', function () {
        const assembly = new AssemblyObject().define(100, 4);
        const res = assembly.setAttributeSingle(100, 3, Buffer.from([1, 2, 3, 4]));
        assert.strictEqual(res.generalStatus, CipGeneralStatus.Success);
        assert.deepStrictEqual(assembly.getData(100), Buffer.from([1, 2, 3, 4]));
    });

    it('Set_Attribute_Single rejects a length mismatch with TooMuchData — matches real Delta hardware behavior (README Domain B)', function () {
        const assembly = new AssemblyObject().define(100, 200);
        const res = assembly.setAttributeSingle(100, 3, Buffer.alloc(4));
        assert.strictEqual(res.generalStatus, CipGeneralStatus.TooMuchData);
    });

    it('rejects an undefined instance', function () {
        const assembly = new AssemblyObject();
        assert.strictEqual(assembly.getAttributeSingle(999, 3).generalStatus, CipGeneralStatus.PathDestinationUnknown);
    });

    it('getData()/setData() give the Connection Manager direct buffer access without CIP framing', function () {
        const assembly = new AssemblyObject().define(101, 2);
        assembly.setData(101, Buffer.from([0xaa, 0xbb]));
        assert.deepStrictEqual(assembly.getData(101), Buffer.from([0xaa, 0xbb]));
    });
});
