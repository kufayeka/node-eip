'use strict';

/**
 * TCP/IP Interface Object (Class 0xF5) — CIP Vol 2, Chapter 5-3.
 *
 * Mandatory ODVA object for every EtherNet/IP device. Provides mechanisms to
 * configure and inspect a device's TCP/IP network interface attributes
 * (IP address, netmask, gateway, hostname, physical link pointer to Ethernet Link 0xF6).
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

/** Converts an IPv4 string "192.168.1.10" into a 4-byte little-endian UDINT buffer (CIP wire format). */
function ipToBuffer(ipStr) {
    if (!ipStr || typeof ipStr !== 'string') return Buffer.alloc(4);
    const parts = ipStr.trim().split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
        return Buffer.alloc(4);
    }
    // CIP UDINT encodes the 4 octets little-endian: [b4, b3, b2, b1]
    // where b1 is first octet, e.g. 192.168.68.250 -> bytes [250, 68, 168, 192]
    return Buffer.from([parts[3], parts[2], parts[1], parts[0]]);
}

/** Parses a 4-byte little-endian CIP UDINT buffer into an IPv4 string "192.168.1.10". */
function bufferToIp(buf, offset = 0) {
    if (!buf || buf.length < offset + 4) return '0.0.0.0';
    return `${buf[offset + 3]}.${buf[offset + 2]}.${buf[offset + 1]}.${buf[offset]}`;
}

/** Encodes a CIP STRING (UINT 16-bit length prefix + ASCII bytes). */
function encodeCipString(str = '') {
    const strBuf = Buffer.from(str, 'ascii');
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(strBuf.length, 0);
    const pad = (strBuf.length % 2 !== 0) ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([lenBuf, strBuf, pad]);
}

/** Decodes a CIP STRING (UINT 16-bit length prefix + ASCII characters). */
function decodeCipString(buf, offset = 0) {
    if (!buf || buf.length < offset + 2) return '';
    const len = buf.readUInt16LE(offset);
    const strStart = offset + 2;
    if (buf.length < strStart + len) return '';
    return buf.subarray(strStart, strStart + len).toString('ascii');
}

/** Decodes Attribute 5 (Interface Configuration struct) into a JavaScript object. */
function decodeInterfaceConfiguration(buf) {
    if (!buf || buf.length < 20) {
        throw new RangeError(`decodeInterfaceConfiguration: buffer too short (${buf ? buf.length : 0} bytes, expected at least 20)`);
    }
    const ip = bufferToIp(buf, 0);
    const netmask = bufferToIp(buf, 4);
    const gateway = bufferToIp(buf, 8);
    const primaryDns = bufferToIp(buf, 12);
    const secondaryDns = bufferToIp(buf, 16);
    let domainName = '';
    if (buf.length >= 22) {
        domainName = decodeCipString(buf, 20);
    }
    return {
        ip,
        netmask,
        gateway,
        primaryDns,
        secondaryDns,
        domainName
    };
}

class TcpIpInterfaceObject {
    constructor({
        status = 1, // Bit 0-3: 1 = Interface configuration valid and active
        configurationCapability = 0x15, // BOOTP client (0x01) + DHCP client (0x04) + Settable (0x10)
        configurationControl = 0, // 0 = Static IP (from NV storage), 1 = BOOTP, 2 = DHCP
        physicalLinkObjectPath = Buffer.from([0x20, 0xf6, 0x24, 0x01]), // Class 0xF6 (Ethernet Link), Instance 1
        ip = '127.0.0.1',
        netmask = '255.255.255.0',
        gateway = '0.0.0.0',
        primaryDns = '0.0.0.0',
        secondaryDns = '0.0.0.0',
        domainName = '',
        hostName = 'EIP-Node',
        inactivityTimeoutSec = 120
    } = {}) {
        this.status = status;
        this.configurationCapability = configurationCapability;
        this.configurationControl = configurationControl;
        this.physicalLinkObjectPath = physicalLinkObjectPath;
        this.ip = ip;
        this.netmask = netmask;
        this.gateway = gateway;
        this.primaryDns = primaryDns;
        this.secondaryDns = secondaryDns;
        this.domainName = domainName;
        this.hostName = hostName;
        this.inactivityTimeoutSec = inactivityTimeoutSec;
    }

    _buildInterfaceConfigBuffer() {
        const ipBuf = ipToBuffer(this.ip);
        const maskBuf = ipToBuffer(this.netmask);
        const gwBuf = ipToBuffer(this.gateway);
        const dns1Buf = ipToBuffer(this.primaryDns);
        const dns2Buf = ipToBuffer(this.secondaryDns);
        const domainBuf = encodeCipString(this.domainName);
        return Buffer.concat([ipBuf, maskBuf, gwBuf, dns1Buf, dns2Buf, domainBuf]);
    }

    getAttributeSingle(instance, attribute) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        switch (attribute) {
            case 1: {
                // Status (DWORD - 32-bit)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.status >>> 0, 0);
                return ok(b);
            }
            case 2: {
                // Configuration Capability (DWORD - 32-bit)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.configurationCapability >>> 0, 0);
                return ok(b);
            }
            case 3: {
                // Configuration Control (DWORD - 32-bit)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.configurationControl >>> 0, 0);
                return ok(b);
            }
            case 4: {
                // Physical Link Object (STRUCT: Path Size UINT in 16-bit words, Padded EPATH)
                const pathWords = Math.ceil(this.physicalLinkObjectPath.length / 2);
                const sizeBuf = Buffer.alloc(2);
                sizeBuf.writeUInt16LE(pathWords, 0);
                return ok(Buffer.concat([sizeBuf, this.physicalLinkObjectPath]));
            }
            case 5: {
                // Interface Configuration (STRUCT)
                return ok(this._buildInterfaceConfigBuffer());
            }
            case 6: {
                // Host Name (STRING)
                return ok(encodeCipString(this.hostName));
            }
            case 7: {
                // Safety Network Number (ARRAY[6] of BYTE)
                return ok(Buffer.alloc(6));
            }
            case 8: {
                // TTL Value (USINT)
                return ok(Buffer.from([1]));
            }
            case 9: {
                // Mcast Config (STRUCT: Alloc_Control USINT, Reserved USINT, Num_Mcast UINT, Mcast_Start_Addr UDINT)
                return ok(Buffer.alloc(8));
            }
            case 10: {
                // Select ACD (BOOL)
                return ok(Buffer.from([0]));
            }
            case 11: {
                // Last Conflict Detected (STRUCT, 35 bytes)
                return ok(Buffer.alloc(35));
            }
            case 12: {
                // Quick Connect (BOOL)
                return ok(Buffer.from([0]));
            }
            case 13: {
                // Encapsulation Inactivity Timeout (UINT - 16-bit, seconds)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(this.inactivityTimeoutSec, 0);
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        const b = Buffer.alloc(12);
        b.writeUInt32LE(this.status >>> 0, 0);
        b.writeUInt32LE(this.configurationCapability >>> 0, 4);
        b.writeUInt32LE(this.configurationControl >>> 0, 8);

        const pathWords = Math.ceil(this.physicalLinkObjectPath.length / 2);
        const sizeBuf = Buffer.alloc(2);
        sizeBuf.writeUInt16LE(pathWords, 0);
        const linkObj = Buffer.concat([sizeBuf, this.physicalLinkObjectPath]);

        const ifConfig = this._buildInterfaceConfigBuffer();
        const hostName = encodeCipString(this.hostName);
        const safetyNetNum = Buffer.alloc(6);
        const ttlVal = Buffer.from([1]);
        const mcastConfig = Buffer.alloc(8);
        const remainBytes = Buffer.alloc(9);

        return ok(Buffer.concat([b, linkObj, ifConfig, hostName, safetyNetNum, ttlVal, mcastConfig, remainBytes]));
    }

    setAttributeSingle(instance, attribute, data) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        switch (attribute) {
            case 3: {
                if (data.length < 4) return { generalStatus: CipGeneralStatus.NotEnoughData, data: Buffer.alloc(0) };
                this.configurationControl = data.readUInt32LE(0);
                return ok(Buffer.alloc(0));
            }
            case 5: {
                if (data.length < 20) return { generalStatus: CipGeneralStatus.NotEnoughData, data: Buffer.alloc(0) };
                const conf = decodeInterfaceConfiguration(data);
                this.ip = conf.ip;
                this.netmask = conf.netmask;
                this.gateway = conf.gateway;
                this.primaryDns = conf.primaryDns;
                this.secondaryDns = conf.secondaryDns;
                this.domainName = conf.domainName;
                return ok(Buffer.alloc(0));
            }
            case 6: {
                this.hostName = decodeCipString(data, 0);
                return ok(Buffer.alloc(0));
            }
            case 13: {
                if (data.length < 2) return { generalStatus: CipGeneralStatus.NotEnoughData, data: Buffer.alloc(0) };
                this.inactivityTimeoutSec = data.readUInt16LE(0);
                return ok(Buffer.alloc(0));
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }
    }
}

module.exports = {
    TcpIpInterfaceObject,
    ipToBuffer,
    bufferToIp,
    encodeCipString,
    decodeCipString,
    decodeInterfaceConfiguration
};
