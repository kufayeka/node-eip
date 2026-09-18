'use strict';

/**
 * Delta DVP-ES2-E / SE / SE2 / 26SE Device Profile
 * Source: Delta IA-PLC EtherNet/IP Operation Manual, Appendix B.5
 */

const { DeviceProfile } = require('../../../device/profile');

const es2Profile = new DeviceProfile({
    vendor: 'Delta',
    family: 'DVP',
    model: 'ES2',
    description: 'Delta DVP-ES2-E / DVP-SE / DVP-SE2 / DVP-26SE Series',
    capabilities: {
        multipleServicePacket: true,
        symbolicTags: false,
        class1IO: true
    },
    aliases: ['es2', 'es2e', 'se', 'se2', 'dvp26se', 'delta:es2', 'delta:es2e', 'delta:se', 'delta:se2', 'delta:dvp26se'],
    registers: {
        // X Input: Class 0x350, Instance 1, Attribute 0..255 (Octal X0-X377), Read-only
        X: {
            classId: 0x350,
            instance: 1,
            dataType: 'BOOL',
            access: 'r',
            isBit: true,
            octal: true,
            range: [0, 255]
        },
        // Y Output: Class 0x351, Instance 1, Attribute 0..255 (Octal Y0-Y377), Read-write
        Y: {
            classId: 0x351,
            instance: 1,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            octal: true,
            range: [0, 255]
        },
        // D Register: Class 0x352, Instance 1 (flat 16-bit word, NOT instance 2!), Attribute = D number
        D: {
            classId: 0x352,
            instance: 1,
            dataType: 'INT',
            access: 'rw',
            isWord: true,
            range: [0, 11999]
        },
        // M Relay: Class 0x353, Instance 1, Attribute 0..4095, BOOL
        M: {
            classId: 0x353,
            instance: 1,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            range: [0, 4095]
        },
        // S Relay: Class 0x354, Instance 1, Attribute 0..1023, BOOL
        S: {
            classId: 0x354,
            instance: 1,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            range: [0, 1023]
        },
        // T Timer: Class 0x355. Instance 2 = INT current value; Instance 1 = BOOL contact bit
        T: {
            classId: 0x355,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'rw',
            range: [0, 255]
        },
        // C Counter: Class 0x356. Instance 2 = Numeric value; Instance 1 = BOOL contact bit
        // Range 0..199: INT (16-bit). Range 200..255: DINT (32-bit).
        C: {
            classId: 0x356,
            instance: 2,
            bitInstance: 1,
            access: 'rw',
            range: [0, 255],
            resolve: (regIndex, options = {}) => {
                if (options.mode === 'bit') {
                    return { instance: 1, dataType: 'BOOL', byteWidth: 1, isBit: true };
                }
                const is32Bit = regIndex >= 200;
                return {
                    instance: 2,
                    dataType: is32Bit ? 'DINT' : 'INT',
                    byteWidth: is32Bit ? 4 : 2,
                    isBit: false
                };
            }
        }
    },
    customMethods: {
        readC32: (target, n) => target.read('C', n),
        writeC32: (target, n, val) => target.write('C', n, val),
        readD32: async (target, n) => {
            const low = await target.read('D', n);
            const high = await target.read('D', n + 1);
            const uLow = low & 0xFFFF;
            const uHigh = high & 0xFFFF;
            const combined = (uHigh << 16) | uLow;
            return combined;
        },
        writeD32: async (target, n, value) => {
            const low = value & 0xFFFF;
            const high = (value >> 16) & 0xFFFF;
            await target.write('D', n, low);
            await target.write('D', n + 1, high);
            return true;
        }
    }
});

module.exports = { es2Profile };
