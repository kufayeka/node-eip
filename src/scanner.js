'use strict';

/**
 * Public EIP Scanner API — wraps the low-level pieces (EIPSession,
 * cip/path.js, cip/message-router.js, cip/connection-manager.js,
 * delta/registers.js) that examples/*.js have been driving directly, into
 * one object with a friendlier surface. Vendor-neutral by default; Delta
 * register convenience methods are included because they're additive and
 * harmless to expose (they simply won't work against a non-Delta device,
 * or a Delta device that doesn't implement them — see README Domain J),
 * not because this class is Delta-specific.
 */

const { EIPSession } = require('./client');
const { encodeEPath } = require('./cip/path');
const { buildRequest } = require('./cip/message-router');
const { scanUdp, scanUdpUnicast, probeTcp } = require('./encapsulation/discovery');
const { CipCommonServices, CipGeneralStatus } = require('./constants');
const deltaRegisters = require('./delta/registers');

function formatCipError(label, response) {
    const extra = response.additionalStatus.map((w) => '0x' + w.toString(16)).join(', ');
    return new Error(`${label}: general status 0x${response.generalStatus.toString(16)}${extra ? `, additional status: ${extra}` : ''}`);
}

class Scanner {
    constructor(host, opts) {
        this.host = host;
        this.session = new EIPSession(host, opts);
    }

    /** Discovers EIP devices on the local network(s) via UDP broadcast ListIdentity. */
    static discover(opts) {
        return scanUdp(opts);
    }

    /** ListIdentity via UDP unicast to a known host. */
    static discoverAt(host, opts) {
        return scanUdpUnicast(host, opts);
    }

    /** ListIdentity via TCP (no session needed) to a known host. */
    static probe(host, opts) {
        return probeTcp(host, opts);
    }

    async connect() {
        return this.session.connect();
    }

    async disconnect() {
        return this.session.close();
    }

    /**
     * Generic explicit-messaging read (Get_Attribute_Single) — works against
     * any CIP object on any conformant device, not just Delta's.
     * @returns {Buffer} raw attribute data
     */
    async getAttribute({ classId, instance, attribute }) {
        const path = encodeEPath({ classId, instance, attribute });
        const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });
        const response = await this.session.sendUnconnected(request);
        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw formatCipError(`getAttribute(0x${classId.toString(16)}/${instance}/${attribute})`, response);
        }
        return response.data;
    }

    /**
     * Generic explicit-messaging write (Set_Attribute_Single). Remember:
     * for Assembly Object Data attributes, `data.length` must match the
     * object's *current* Size attribute exactly (see README Domain B) — a
     * mismatch is rejected with general status 0x15.
     */
    async setAttribute({ classId, instance, attribute, data }) {
        const path = encodeEPath({ classId, instance, attribute });
        const request = buildRequest({ service: CipCommonServices.SetAttributeSingle, path, data });
        const response = await this.session.sendUnconnected(request);
        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw formatCipError(`setAttribute(0x${classId.toString(16)}/${instance}/${attribute})`, response);
        }
    }

    /** Forward_Open — see cip/connection-manager.js's buildForwardOpenRequest() for the full option list. */
    async openConnection(forwardOpenParams) {
        return this.session.openConnection(forwardOpenParams);
    }

    /** Forward_Close a connection previously returned by openConnection(). */
    async closeConnection(connection) {
        return this.session.closeConnection(connection);
    }

    // Delta AH/AS-series vendor-specific register convenience (README Domain J).
    // Each delegates to delta/registers.js, bound to this scanner's session.
    readX(n) { return deltaRegisters.readX(this.session, n); }
    readXBit(n) { return deltaRegisters.readXBit(this.session, n); }
    readY(n) { return deltaRegisters.readY(this.session, n); }
    writeY(n, v) { return deltaRegisters.writeY(this.session, n, v); }
    readYBit(n) { return deltaRegisters.readYBit(this.session, n); }
    writeYBit(n, v) { return deltaRegisters.writeYBit(this.session, n, v); }
    readD(n) { return deltaRegisters.readD(this.session, n); }
    writeD(n, v) { return deltaRegisters.writeD(this.session, n, v); }
    readM(n) { return deltaRegisters.readM(this.session, n); }
    writeM(n, v) { return deltaRegisters.writeM(this.session, n, v); }
    readS(n) { return deltaRegisters.readS(this.session, n); }
    writeS(n, v) { return deltaRegisters.writeS(this.session, n, v); }
    readT(n) { return deltaRegisters.readT(this.session, n); }
    writeT(n, v) { return deltaRegisters.writeT(this.session, n, v); }
    readC(n) { return deltaRegisters.readC(this.session, n); }
    writeC(n, v) { return deltaRegisters.writeC(this.session, n, v); }
    readHC(n) { return deltaRegisters.readHC(this.session, n); }
    writeHC(n, v) { return deltaRegisters.writeHC(this.session, n, v); }
    readSM(n) { return deltaRegisters.readSM(this.session, n); }
    readSR(n) { return deltaRegisters.readSR(this.session, n); }
}

module.exports = { Scanner };
