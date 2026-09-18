'use strict';

/**
 * Device Level Ring (DLR) Object (Class 0x47) — CIP Vol 2, Chapter 5-5.
 *
 * Implements standard ODVA DLR Object and Delta EtherNet/IP specifications
 * (Delta Operation Manual Chapter 8.7).
 * Allows network scanners, switches, and configuration tools (Delta EIP Builder,
 * Rockwell Studio 5000) to inspect ring topology, supervisor state, and ring faults.
 */

const { CipGeneralStatus } = require('../../constants');

function ok(data) {
    return { generalStatus: CipGeneralStatus.Success, data };
}

class DeviceLevelRingObject {
    /**
     * @param {object} [options]
     * @param {number} [options.networkTopology=0] 0: Linear, 1: Ring
     * @param {number} [options.networkStatus=0] 0: Normal, 1: Ring Fault, 2: Unexpected Loop
     * @param {number} [options.ringSupervisorStatus=2] 2: Normal Ring Node (not supervisor)
     * @param {number} [options.capabilityFlags=0x02] Bit 1: Beacon-based ring node
     */
    constructor({
        networkTopology = 0,
        networkStatus = 0,
        ringSupervisorStatus = 2,
        capabilityFlags = 0x00000002
    } = {}) {
        this.networkTopology = networkTopology;
        this.networkStatus = networkStatus;
        this.ringSupervisorStatus = ringSupervisorStatus;
        this.capabilityFlags = capabilityFlags;

        this.ringSupervisorConfig = {
            enable: 0,
            precedence: 0,
            beaconInterval: 400,
            beaconTimeout: 1960,
            vlanId: 0
        };

        this.ringFaults = 0;
        this.lastActiveNodePort1 = { ip: '0.0.0.0', mac: '00:00:00:00:00:00' };
        this.lastActiveNodePort2 = { ip: '0.0.0.0', mac: '00:00:00:00:00:00' };
        this.activeSupervisorAddress = { ip: '0.0.0.0', mac: '00:00:00:00:00:00' };
    }

    _encodeSupervisorConfig() {
        const b = Buffer.alloc(12);
        b.writeUInt8(this.ringSupervisorConfig.enable ? 1 : 0, 0);
        b.writeUInt8(this.ringSupervisorConfig.precedence & 0xff, 1);
        b.writeUInt32LE(this.ringSupervisorConfig.beaconInterval >>> 0, 2);
        b.writeUInt32LE(this.ringSupervisorConfig.beaconTimeout >>> 0, 6);
        b.writeUInt16LE(this.ringSupervisorConfig.vlanId & 0xffff, 10);
        return b;
    }

    _encodeNodeAddress(node) {
        const b = Buffer.alloc(10);
        if (node && node.ip) {
            const parts = node.ip.split('.').map(Number);
            if (parts.length === 4) {
                b.writeUInt8(parts[3], 0);
                b.writeUInt8(parts[2], 1);
                b.writeUInt8(parts[1], 2);
                b.writeUInt8(parts[0], 3);
            }
        }
        if (node && node.mac) {
            const hex = node.mac.replace(/[:-]/g, '');
            if (hex.length === 12) {
                Buffer.from(hex, 'hex').copy(b, 4, 0, 6);
            }
        }
        return b;
    }

    getAttributeSingle(instance, attribute) {
        if (instance === 0) {
            switch (attribute) {
                case 1: { // Class Revision
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(3, 0); // Revision 3
                    return ok(b);
                }
                case 2: { // Max Instance
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                case 3: { // Number of Instances
                    const b = Buffer.alloc(2);
                    b.writeUInt16LE(1, 0);
                    return ok(b);
                }
                default:
                    return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
            }
        }

        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        switch (attribute) {
            case 1: { // Network Topology (USINT) 0: Linear, 1: Ring
                return ok(Buffer.from([this.networkTopology & 0xff]));
            }
            case 2: { // Network Status (USINT) 0: Normal
                return ok(Buffer.from([this.networkStatus & 0xff]));
            }
            case 3: { // Ring Supervisor Status (USINT)
                return ok(Buffer.from([this.ringSupervisorStatus & 0xff]));
            }
            case 4: { // Ring Supervisor Config (STRUCT of 12B)
                return ok(this._encodeSupervisorConfig());
            }
            case 5: { // Ring Faults (UINT)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(this.ringFaults & 0xffff, 0);
                return ok(b);
            }
            case 6: { // Last Active Node on Port 1 (STRUCT: IP 4B, MAC 6B)
                return ok(this._encodeNodeAddress(this.lastActiveNodePort1));
            }
            case 7: { // Last Active Node on Port 2 (STRUCT: IP 4B, MAC 6B)
                return ok(this._encodeNodeAddress(this.lastActiveNodePort2));
            }
            case 8: { // Participants List (Count UINT + Array)
                const b = Buffer.alloc(2);
                b.writeUInt16LE(0, 0); // 0 participants
                return ok(b);
            }
            case 9: { // Active Supervisor Address (STRUCT: IP 4B, MAC 6B)
                return ok(this._encodeNodeAddress(this.activeSupervisorAddress));
            }
            case 10: { // Capability Flags (DWORD)
                const b = Buffer.alloc(4);
                b.writeUInt32LE(this.capabilityFlags >>> 0, 0);
                return ok(b);
            }
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSupported, data: Buffer.alloc(0) };
        }
    }

    getAttributesAll(instance) {
        if (instance === 0) {
            const b = Buffer.alloc(6);
            b.writeUInt16LE(3, 0); // Revision 3
            b.writeUInt16LE(1, 2);
            b.writeUInt16LE(1, 4);
            return ok(b);
        }
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }

        const attr1 = Buffer.from([this.networkTopology & 0xff]);
        const attr2 = Buffer.from([this.networkStatus & 0xff]);
        const attr3 = Buffer.from([this.ringSupervisorStatus & 0xff]);
        const attr4 = this._encodeSupervisorConfig();
        const attr5 = Buffer.alloc(2);
        attr5.writeUInt16LE(this.ringFaults & 0xffff, 0);
        const attr6 = this._encodeNodeAddress(this.lastActiveNodePort1);
        const attr7 = this._encodeNodeAddress(this.lastActiveNodePort2);
        const attr8 = Buffer.alloc(2); // count 0
        const attr9 = this._encodeNodeAddress(this.activeSupervisorAddress);
        const attr10 = Buffer.alloc(4);
        attr10.writeUInt32LE(this.capabilityFlags >>> 0, 0);

        return ok(Buffer.concat([attr1, attr2, attr3, attr4, attr5, attr6, attr7, attr8, attr9, attr10]));
    }

    setAttributeSingle(instance, attribute, data) {
        if (instance !== 1) {
            return { generalStatus: CipGeneralStatus.PathDestinationUnknown, data: Buffer.alloc(0) };
        }
        switch (attribute) {
            case 2: // Network Status
                if (data && data.length >= 1) this.networkStatus = data[0];
                return ok(Buffer.alloc(0));
            case 4: // Ring Supervisor Config
                if (data && data.length >= 12) {
                    this.ringSupervisorConfig.enable = data.readUInt8(0);
                    this.ringSupervisorConfig.precedence = data.readUInt8(1);
                    this.ringSupervisorConfig.beaconInterval = data.readUInt32LE(2);
                    this.ringSupervisorConfig.beaconTimeout = data.readUInt32LE(6);
                    this.ringSupervisorConfig.vlanId = data.readUInt16LE(10);
                }
                return ok(Buffer.alloc(0));
            default:
                return { generalStatus: CipGeneralStatus.AttributeNotSettable, data: Buffer.alloc(0) };
        }
    }
}

module.exports = { DeviceLevelRingObject };
