'use strict';

/**
 * Delta DVP-12SE Legacy Device Profile
 * Source: Delta IA-PLC EtherNet/IP Operation Manual, Appendix B.5
 *
 * DVP12SE uses distinct vendor Class IDs (0x64..0x69) where the PLC point/number
 * is mapped to the CIP Instance ID (Instance = index + 1) rather than Attribute ID.
 */

const { DeviceProfile } = require('../../../device/profile');

const dvp12seProfile = new DeviceProfile({
    vendor: 'Delta',
    family: 'DVP',
    model: '12SE',
    description: 'Delta DVP-12SE Series (Legacy Object Model 0x64..0x69)',
    capabilities: {
        multipleServicePacket: true,
        symbolicTags: false,
        class1IO: false
    },
    aliases: ['12se', 'dvp12se', 'delta:12se', 'delta:dvp12se'],
    registers: {
        // X Input: Class 0x64, Instance = point + 1, Attribute 0x64 (100), BYTE, Read-only
        X: {
            classId: 0x64,
            instance: (idx) => idx + 1,
            attribute: 0x64,
            dataType: 'BOOL',
            access: 'r',
            isBit: true,
            octal: true,
            range: [0, 255]
        },
        // Y Output: Class 0x65, Instance = point + 1, Attribute 0x64 (100), BYTE, Read-write
        Y: {
            classId: 0x65,
            instance: (idx) => idx + 1,
            attribute: 0x64,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            octal: true,
            range: [0, 255]
        },
        // D Register: Class 0x69, Instance = point + 1, Attribute 0x64 (100), INT
        D: {
            classId: 0x69,
            instance: (idx) => idx + 1,
            attribute: 0x64,
            dataType: 'INT',
            access: 'rw',
            isWord: true,
            range: [0, 11999]
        },
        // M Relay: Class 0x67, Instance = point + 1, Attribute 0x64 (100), BYTE
        M: {
            classId: 0x67,
            instance: (idx) => idx + 1,
            attribute: 0x64,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            range: [0, 4095]
        },
        // T Timer: Class 0x66. Attribute 0x64 = INT current value; Attribute 0x65 = BYTE contact bit
        T: {
            classId: 0x66,
            instance: (idx) => idx + 1,
            access: 'rw',
            range: [0, 255],
            resolve: (regIndex, options = {}) => {
                const isBit = options.mode === 'bit';
                return {
                    classId: 0x66,
                    instance: regIndex + 1,
                    attribute: isBit ? 0x65 : 0x64,
                    dataType: isBit ? 'BOOL' : 'INT',
                    byteWidth: isBit ? 1 : 2,
                    isBit
                };
            }
        },
        // C Counter: Class 0x68. Attribute 0x64 = Numeric value; Attribute 0x65 = BYTE contact bit
        // Range 0..199: INT (16-bit). Range 200..255: DINT (32-bit).
        C: {
            classId: 0x68,
            instance: (idx) => idx + 1,
            access: 'rw',
            range: [0, 255],
            resolve: (regIndex, options = {}) => {
                const isBit = options.mode === 'bit';
                if (isBit) {
                    return { classId: 0x68, instance: regIndex + 1, attribute: 0x65, dataType: 'BOOL', byteWidth: 1, isBit: true };
                }
                const is32Bit = regIndex >= 200;
                return {
                    classId: 0x68,
                    instance: regIndex + 1,
                    attribute: 0x64,
                    dataType: is32Bit ? 'DINT' : 'INT',
                    byteWidth: is32Bit ? 4 : 2,
                    isBit: false
                };
            }
        }
    }
});

module.exports = { dvp12seProfile };
