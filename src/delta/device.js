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
const { DeltaBatchBuilder } = require('./batch');
const { Subscription } = require('../subscription');

class DeltaDevice {
    constructor(host, deviceType, opts = {}) {
        this.deviceType = deviceType;
        this.profile = deviceTypes.get(deviceType); // throws immediately on an unknown type
        const scannerOpts = {
            autoReconnect: true,
            reconnectDelayMs: 200,
            ...opts
        };
        this.scanner = new Scanner(host, scannerOpts);
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

    /**
     * Executes multiple register operations in a single ODVA CIP Multiple Service Packet (0x0A)
     * over the network, resolving in one round-trip.
     *
     * Example:
     *   await plc.batch(b => {
     *       b.writeYBit(0, false);
     *       b.writeYBit(1, true);
     *       b.writeD(0, 100);
     *   });
     */
    async batch(builderFn) {
        if (typeof builderFn !== 'function') {
            throw new TypeError('batch: builderFn must be a function');
        }
        const builder = new DeltaBatchBuilder();
        builderFn(builder);
        if (builder.operations.length === 0) return [];

        const requests = builder.operations.map(op => ({
            service: op.service,
            path: op.path,
            data: op.data
        }));

        const responses = await this.scanner.sendMultipleRequests(requests);
        return responses.map((res, i) => {
            const op = builder.operations[i];
            if (res.generalStatus !== 0) {
                throw new Error(`${op.label}: batch request failed with CIP status 0x${res.generalStatus.toString(16)}`);
            }
            return op.parse(res.data);
        });
    }

    /**
     * Creates a real-time tag subscription / watcher for this device.
     * Supports both 'polling' (TCP 44818 batch) and 'udp' (Class 1 I/O port 2222) modes.
     *
     * @param {object} [options]
     * @param {'polling'|'udp'|'realtime'} [options.mode='polling'] - Subscription mode
     * @param {number} [options.interval=100] - Polling interval in ms
     * @param {number} [options.rpiMs=20] - UDP RPI in ms
     * @param {Array<string|object>} [options.tags=[]] - Initial tags to subscribe
     * @param {number} [options.deadband=0] - Deadband threshold
     * @returns {Subscription}
     */
    createSubscription(options = {}) {
        return new Subscription(this, options);
    }
}

module.exports = { DeltaDevice };
