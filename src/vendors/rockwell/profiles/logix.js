'use strict';

/**
 * Rockwell Automation ControlLogix / CompactLogix Profile Example
 * Demonstrates how symbolic tag based PLCs are defined in this architecture.
 */

const { DeviceProfile } = require('../../../device/profile');

const logixProfile = new DeviceProfile({
    vendor: 'Rockwell',
    family: 'Logix',
    model: 'ControlLogix',
    description: 'Rockwell ControlLogix / CompactLogix (Symbolic Tag Addressing)',
    capabilities: {
        multipleServicePacket: true,
        symbolicTags: true,
        class1IO: true
    },
    aliases: ['logix', 'controllogix', 'compactlogix', 'rockwell:logix'],
    registers: {}, // Logix uses dynamic symbolic tags rather than fixed numerical registers
    customMethods: {
        readTag: async (target, tagName) => {
            return target.scanner.readSymbolicTag(tagName);
        },
        writeTag: async (target, tagName, value, dataType) => {
            return target.scanner.writeSymbolicTag(tagName, value, dataType);
        }
    }
});

module.exports = { logixProfile };
