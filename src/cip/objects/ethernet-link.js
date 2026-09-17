'use strict';

/**
 * Ethernet Link Object (Class 0xF6) — CIP Vol 2, Chapter 5-4.
 *
 * Mandatory ODVA object for every EtherNet/IP communications interface.
 * Maintains link-specific counters, flags, and physical MAC layer attributes.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

/** Formats a 6-byte MAC buffer into a standard colon-separated string "00:18:23:E4:61:2E". */
function formatMacAddress(buf, offset = 0) {
    if (!buf || buf.length < offset + 6) return '00:00:00:00:00:00';
    return Array.from(buf.subarray(offset, offset + 6))
        .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
        .join(':');
}

/** Parses a MAC address string "00:18:23:E4:61:2E" into a 6-byte Buffer. */
function parseMacAddress(macStr) {
    if (!macStr || typeof macStr !== 'string') return Buffer.alloc(6);
    const hexParts = macStr.split(/[:-]/);
    if (hexParts.length !== 6) return Buffer.alloc(6);
    const buf = Buffer.alloc(6);
    for (let i = 0; i < 6; i++) {
        const val = parseInt(hexParts[i], 16);
        buf[i] = isNaN(val) ? 0 : val & 0xff;
    }
    return buf;
}

/** Decodes 32-bit Interface Flags into human-readable booleans. */
function decodeInterfaceFlags(flags) {
    return {
        linkActive: (flags & 0x01) !== 0,
        fullDuplex: (flags & 0x02) !== 0,
        negotiationStatus: (flags >> 2) & 0x07,
        manualSettingRequiresReset: (flags & 0x20) !== 0,
        localHardwareFault: (flags & 0x40) !== 0
    };
}

class EthernetLinkObject {
    constructor({
        speedMbps = 100,
        flags = 0x00000013, // Bit 0: Link Active, Bit 1: Full Duplex, Bits 2-4: 4 (Auto-neg not attempted / fixed)
        macAddress = '00:00:00:00:00:00',
        interfaceLabel = 'Ethernet',
        capabilities = [
            { speed: 10, duplex: 0 }, // 10M Half
            { speed: 10, duplex: 1 }, // 10M Full
            { speed: 100, duplex: 0 }, // 100M Half
            { speed: 100, duplex: 1 }  // 100M Full
        ]
    } = {}) {
        this.speedMbps = speedMbps;
        this.flags = flags;
        this.macAddress = macAddress;
        this.interfaceLabel = interfaceLabel;
        this.capabilities = capabilities;
    }

    _buildCapabilityBuffer() {
        // Capability Bits (DWORD, 4 bytes: 0x07 = 10M/100M/Auto-neg)
        const header = Buffer.alloc(5);
        header.writeUInt32LE(0x00000007, 0);
        header.writeUInt8(this.capabilities.length, 4);

        const list = [];
        for (const cap of this.capabilities) {
            const item = Buffer.alloc(3);
            item.writeUInt16LE(cap.speed, 0);
            item.writeUInt8(cap.duplex, 2);
            list.push(item);
        }
        return Buffer.concat([header, ...list]);
    }

    getAttributeSingle(instance, attribute) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        switch (attribute) {
            case 1: {
                // Interface Speed (UDINT, 32-bit Mbps, little-endian)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.speedMbps >>> 0, 0);
                return ok(b);
            }
            case 2: {
                // Interface Flags (DWORD, 32-bit bitmap, little-endian)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.flags >>> 0, 0);
                return ok(b);
            }
            case 3: {
                // Physical Address (MAC address USINT[6])
                return ok(parseMacAddress(this.macAddress));
            }
            case 10: {
                // Interface Label (SHORT_STRING: USINT length + characters)
                const strBuf = Buffer.from(this.interfaceLabel, 'ascii');
                return ok(Buffer.concat([Buffer.from([strBuf.length]), strBuf]));
            }
            case 11: {
                // Interface Capability (STRUCT)
                return ok(this._buildCapabilityBuffer());
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        const b = Buffer.alloc(8);
        b.writeUInt32LE(this.speedMbps >>> 0, 0);
        b.writeUInt32LE(this.flags >>> 0, 4);
        const mac = parseMacAddress(this.macAddress);

        return ok(Buffer.concat([b, mac]));
    }

    setAttributeSingle() {
        return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
    }
}

module.exports = {
    EthernetLinkObject,
    formatMacAddress,
    parseMacAddress,
    decodeInterfaceFlags
};
