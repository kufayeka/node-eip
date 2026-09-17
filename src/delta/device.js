'use strict';

/**
 * Explicit, device-type-aware Delta client — wraps a Scanner (session +
 * generic CIP) with a chosen device-type profile (src/delta/device-types/).
 * The caller states the PLC type up front; nothing is auto-detected.
 *
 * Usage:
 *   const device = new DeltaDevice('192.168.68.250', 'sx3');
 *   await device.connect();
 *   await device.readD(100);
 *   await device.disconnect();
 */

const { Scanner } = require('../scanner');
const deviceTypes = require('./device-types');

class DeltaDevice {
    constructor(host, deviceType, opts) {
        this.deviceType = deviceType;
        this.profile = deviceTypes.get(deviceType); // throws immediately on an unknown type
        this.scanner = new Scanner(host, opts);
    }

    static listDeviceTypes() {
        return deviceTypes.list();
    }

    async connect() {
        return this.scanner.connect();
    }

    async disconnect() {
        return this.scanner.disconnect();
    }

    get session() {
        return this.scanner.session;
    }

    // Delegate every register method to the chosen profile, bound to this device's session.
    readX(n) { return this.profile.readX(this.session, n); }
    readXBit(n) { return this.profile.readXBit(this.session, n); }
    readY(n) { return this.profile.readY(this.session, n); }
    writeY(n, v) { return this.profile.writeY(this.session, n, v); }
    readYBit(n) { return this.profile.readYBit(this.session, n); }
    writeYBit(n, v) { return this.profile.writeYBit(this.session, n, v); }
    readD(n) { return this.profile.readD(this.session, n); }
    writeD(n, v) { return this.profile.writeD(this.session, n, v); }
    readM(n) { return this.profile.readM(this.session, n); }
    writeM(n, v) { return this.profile.writeM(this.session, n, v); }
    readS(n) { return this.profile.readS(this.session, n); }
    writeS(n, v) { return this.profile.writeS(this.session, n, v); }
    readT(n) { return this.profile.readT(this.session, n); }
    writeT(n, v) { return this.profile.writeT(this.session, n, v); }
    readC(n) { return this.profile.readC(this.session, n); }
    writeC(n, v) { return this.profile.writeC(this.session, n, v); }
    readHC(n) { return this.profile.readHC(this.session, n); }
    writeHC(n, v) { return this.profile.writeHC(this.session, n, v); }
    readSM(n) { return this.profile.readSM(this.session, n); }
    readSR(n) { return this.profile.readSR(this.session, n); }
}

module.exports = { DeltaDevice };
