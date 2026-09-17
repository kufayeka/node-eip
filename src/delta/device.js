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
const { readDword, writeDword } = require('./dword');

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
    // Octal I/O labels (e.g. 'X10' = decimal 8) — see docs/dvp-plc-device-ranges.md.
    readXBitLabel(label) { return this.profile.readXBitLabel(this.session, label); }
    readY(n) { return this.profile.readY(this.session, n); }
    writeY(n, v) { return this.profile.writeY(this.session, n, v); }
    readYBit(n) { return this.profile.readYBit(this.session, n); }
    writeYBit(n, v) { return this.profile.writeYBit(this.session, n, v); }
    readYBitLabel(label) { return this.profile.readYBitLabel(this.session, label); }
    writeYBitLabel(label, v) { return this.profile.writeYBitLabel(this.session, label, v); }
    readD(n) { return this.profile.readD(this.session, n); }
    writeD(n, v) { return this.profile.writeD(this.session, n, v); }
    readM(n) { return this.profile.readM(this.session, n); }
    writeM(n, v) { return this.profile.writeM(this.session, n, v); }
    readS(n) { return this.profile.readS(this.session, n); }
    writeS(n, v) { return this.profile.writeS(this.session, n, v); }
    readT(n) { return this.profile.readT(this.session, n); }
    writeT(n, v) { return this.profile.writeT(this.session, n, v); }
    readTBit(n) { return this.profile.readTBit(this.session, n); }
    writeTBit(n, v) { return this.profile.writeTBit(this.session, n, v); }
    readC(n) { return this.profile.readC(this.session, n); }
    writeC(n, v) { return this.profile.writeC(this.session, n, v); }
    readCBit(n) { return this.profile.readCBit(this.session, n); }
    writeCBit(n, v) { return this.profile.writeCBit(this.session, n, v); }
    readHC(n) { return this.profile.readHC(this.session, n); }
    writeHC(n, v) { return this.profile.writeHC(this.session, n, v); }
    readSM(n) { return this.profile.readSM(this.session, n); }
    readSR(n) { return this.profile.readSR(this.session, n); }

    /**
     * 32-bit D access via register pairing (Dn = low word, Dn+1 = high
     * word) — see dword.js. Rides on whatever readD/writeD already does
     * for the active profile, so it inherits the same capabilities and
     * limitations for the active profile.
     */
    readD32(n) { return readDword(this.readD.bind(this), n); }
    writeD32(n, value) { return writeDword(this.writeD.bind(this), n, value); }

    /**
     * 32-bit counter access — delegated to the profile, since the
     * underlying mechanism genuinely differs per device family: a
     * separate HC class (0x357) on 'sx3', vs. C's own Instance 2 at high
     * attribute numbers on 'es2' (no HC class exists there at all).
     */
    readC32(n) { return this.profile.readC32(this.session, n); }
    writeC32(n, value) { return this.profile.writeC32(this.session, n, value); }
}

module.exports = { DeltaDevice };
