'use strict';

/**
 * Delta DVP-SV3 / SX3 / ES3 / EX3 / AS-series / AH-series Device Profile
 * Source: Delta IA-PLC EtherNet/IP Operation Manual, Chapter 8
 */

const { DeviceProfile } = require('../../../device/profile');

const sx3Profile = new DeviceProfile({
    vendor: 'Delta',
    family: 'DVP/AS/AH',
    model: 'SX3',
    description: 'Delta DVP-SX3 / SV3 / ES3 / EX3 / AS300 / AHCPU Series',
    capabilities: {
        multipleServicePacket: true,
        symbolicTags: false,
        class1IO: true
    },
    aliases: ['sx3', 'es3', 'ex3', 'sv3', 'as', 'as300', 'ah', 'ah500', 'delta:sx3', 'delta:es3', 'delta:as', 'delta:as300', 'delta:ah'],
    registers: {
        // X Input: Class 0x350. Instance 2 = INT word; Instance 1 = BOOL bit (word*16 + bit)
        X: {
            classId: 0x350,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'r',
            octal: true,
            range: [0, 255]
        },
        // Y Output: Class 0x351. Instance 2 = INT word; Instance 1 = BOOL bit (word*16 + bit)
        Y: {
            classId: 0x351,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'rw',
            octal: true,
            range: [0, 255]
        },
        // D Register: Class 0x352. Instance 2 = INT word (D number); Instance 1 = INT bit enumeration
        D: {
            classId: 0x352,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'rw',
            isWord: true,
            range: [0, 29999]
        },
        // M Relay: Class 0x353. Instance 1 = BOOL bit
        M: {
            classId: 0x353,
            instance: 1,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            range: [0, 8191]
        },
        // S Relay: Class 0x354. Instance 1 = BOOL bit
        S: {
            classId: 0x354,
            instance: 1,
            dataType: 'BOOL',
            access: 'rw',
            isBit: true,
            range: [0, 2047]
        },
        // T Timer: Class 0x355. Instance 2 = INT current value; Instance 1 = BOOL contact bit
        T: {
            classId: 0x355,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'rw',
            range: [0, 511]
        },
        // C Counter: Class 0x356. Instance 2 = INT current value; Instance 1 = BOOL contact bit
        C: {
            classId: 0x356,
            instance: 2,
            bitInstance: 1,
            dataType: 'INT',
            access: 'rw',
            range: [0, 511]
        },
        // HC High-speed Counter: Class 0x357. Instance 2 = DINT (32-bit) current value; Instance 1 = BOOL contact bit
        HC: {
            classId: 0x357,
            instance: 2,
            bitInstance: 1,
            dataType: 'DINT',
            access: 'rw',
            range: [0, 255]
        },
        // SM System Marker: Class 0x358. Instance 1 = BOOL bit, Read-only
        SM: {
            classId: 0x358,
            instance: 1,
            dataType: 'BOOL',
            access: 'r',
            isBit: true,
            range: [0, 4094]
        },
        // SR System Register: Class 0x359. Instance 1 = INT word (word-only), Read-only
        SR: {
            classId: 0x359,
            instance: 1,
            dataType: 'INT',
            access: 'r',
            isWord: true,
            range: [0, 2047]
        }
    },
    customMethods: {
        readC32: (target, n) => target.read('HC', n),
        writeC32: (target, n, val) => target.write('HC', n, val),
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

module.exports = { sx3Profile };
