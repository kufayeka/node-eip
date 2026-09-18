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

const net = require('net');
const { EIPSession } = require('./client');
const { encodeEPath, encodeSymbolicPath } = require('./cip/path');
const { buildRequest } = require('./cip/message-router');
const { decodeMessage } = require('./encapsulation/header');
const { scanUdp, scanUdpUnicast, probeTcp } = require('./encapsulation/discovery');
const { buildListServicesRequest, parseListServicesResponse } = require('./encapsulation/services');
const { buildMultipleServiceRequest, parseMultipleServiceResponse } = require('./cip/multiple-service');
const { CipCommonServices, CipGeneralStatus, CipClassCodes, EIP_ENCAPSULATION_PORT } = require('./constants');
const { decodeIdentityAttributesAll } = require('./cip/objects/identity');
const { decodeInterfaceConfiguration, decodeCipString } = require('./cip/objects/tcp-ip');
const { formatMacAddress, decodeInterfaceFlags } = require('./cip/objects/ethernet-link');
const { readLargeData, writeLargeData } = require('./cip/fragmentation');
const { encodeType, decodeType } = require('./cip/types');
const { Subscription } = require('./subscription');

function formatCipError(label, response) {
    const extra = response.additionalStatus.map((w) => '0x' + w.toString(16)).join(', ');
    return new Error(`${label}: general status 0x${response.generalStatus.toString(16)}${extra ? `, additional status: ${extra}` : ''}`);
}

class Scanner {
    constructor(hostOrOpts, opts) {
        let host;
        let options;
        if (typeof hostOrOpts === 'object' && hostOrOpts !== null) {
            host = hostOrOpts.host;
            options = hostOrOpts;
        } else {
            host = hostOrOpts;
            options = opts;
        }
        this.host = host;
        this.session = new EIPSession(host, options);
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

    /**
     * Queries supported encapsulation services via ListServices (0x0004) over TCP without establishing a session.
     */
    static async listServices(host, { port = EIP_ENCAPSULATION_PORT, timeoutMs = 3000 } = {}) {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            let buffer = Buffer.alloc(0);
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error(`Scanner.listServices: timed out connecting to ${host}:${port}`));
            }, timeoutMs);

            socket.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });

            socket.connect(port, host, () => {
                const req = buildListServicesRequest();
                socket.write(req);
            });

            socket.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                const msg = decodeMessage(buffer);
                if (!msg) return;
                clearTimeout(timer);
                socket.destroy();
                try {
                    const parsed = parseListServicesResponse(msg);
                    resolve(parsed);
                } catch (err) {
                    reject(err);
                }
            });
        });
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
     * Generic explicit-messaging read for all attributes of an object instance (Get_Attribute_All, 0x01).
     * If reading Identity Object (Class 0x01), returns both the raw buffer and a decoded object.
     * @returns {{ data: Buffer, decoded?: object }}
     */
    async getAttributesAll({ classId, instance = 1 }) {
        const path = encodeEPath({ classId, instance });
        const request = buildRequest({ service: CipCommonServices.GetAttributeAll, path });
        const response = await this.session.sendUnconnected(request);
        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw formatCipError(`getAttributesAll(0x${classId.toString(16)}/${instance})`, response);
        }
        let decoded = null;
        if (classId === CipClassCodes.Identity) {
            try {
                decoded = decodeIdentityAttributesAll(response.data);
            } catch {}
        }
        return { data: response.data, decoded };
    }

    /**
     * Reads Identity Object (Class 0x01, Instance 1) attributes via Get_Attribute_All (§7, §9).
     * @param {number} [instance=1]
     * @returns {Promise<object>} Decoded identity object (vendorId, productCode, productName, revision, etc.)
     */
    async getIdentity(instance = 1) {
        const res = await this.getAttributesAll({ classId: CipClassCodes.Identity, instance });
        return res.decoded || { raw: res.data };
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

    /**
     * Reads a large CIP attribute using progressive fragmentation (§33, §34).
     * Automatically handles CIP status 0x06 (Partial Transfer) until completion.
     *
     * @param {object} options
     * @param {number} options.classId
     * @param {number} [options.instance=1]
     * @param {number} [options.attribute=3]
     * @param {number} [options.chunkSize=480]
     * @param {number} [options.maxTotalBytes=10485760]
     * @returns {Promise<{ data: Buffer, fragmentsCount: number, totalBytes: number }>}
     */
    async readLargeAttribute({ classId, instance = 1, attribute = 3, chunkSize = 480, maxTotalBytes } = {}) {
        const path = encodeEPath({ classId, instance, attribute });
        return readLargeData(this.session, {
            path,
            chunkSize,
            maxTotalBytes
        });
    }

    /**
     * Writes a large CIP attribute using progressive chunking with 32-bit offsets (§33, §34).
     *
     * @param {object} options
     * @param {number} options.classId
     * @param {number} [options.instance=1]
     * @param {number} [options.attribute=3]
     * @param {Buffer} options.data
     * @param {number} [options.chunkSize=480]
     * @returns {Promise<{ ok: true, bytesWritten: number, fragmentsCount: number }>}
     */
    async writeLargeAttribute({ classId, instance = 1, attribute = 3, data, chunkSize = 480 } = {}) {
        const path = encodeEPath({ classId, instance, attribute });
        return writeLargeData(this.session, {
            path,
            data,
            chunkSize
        });
    }

    /**
     * Reads a symbolic tag per ANSI Extended Symbol Addressing (§26, §27).
     *
     * @param {string} tagPath e.g. "TotalCount", "Motor.Speed", "Tanks[3]"
     * @param {object} [options]
     * @param {number} [options.service=0x0E] CIP Service (default: Get_Attribute_Single 0x0E)
     * @param {string} [options.dataType] Optional CIP data type name to auto-decode (e.g. "DINT", "REAL", "BOOL")
     * @returns {Promise<{ data: Buffer, value?: any }>}
     */
    async readTag(tagPath, { service = CipCommonServices.GetAttributeSingle, dataType } = {}) {
        const path = encodeSymbolicPath(tagPath);
        const request = buildRequest({ service, path });
        const response = await this.session.sendUnconnected(request);
        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw formatCipError(`readTag("${tagPath}")`, response);
        }
        let value;
        if (dataType) {
            const decoded = decodeType(dataType, response.data);
            value = decoded.value;
        }
        return { data: response.data, value };
    }

    /**
     * Writes a symbolic tag per ANSI Extended Symbol Addressing (§26, §27).
     *
     * @param {string} tagPath e.g. "TotalCount", "Motor.Speed", "Tanks[3]"
     * @param {any} value Value or Buffer to write
     * @param {object} [options]
     * @param {number} [options.service=0x10] CIP Service (default: Set_Attribute_Single 0x10)
     * @param {string} [options.dataType] Optional CIP data type name if value is not a Buffer
     * @returns {Promise<void>}
     */
    async writeTag(tagPath, value, { service = CipCommonServices.SetAttributeSingle, dataType } = {}) {
        const path = encodeSymbolicPath(tagPath);
        let payload;
        if (Buffer.isBuffer(value)) {
            payload = value;
        } else if (dataType) {
            payload = encodeType(dataType, value);
        } else if (typeof value === 'number') {
            payload = Number.isInteger(value) ? encodeType('DINT', value) : encodeType('REAL', value);
        } else if (typeof value === 'boolean') {
            payload = encodeType('BOOL', value);
        } else if (typeof value === 'string') {
            payload = encodeType('STRING', value);
        } else {
            throw new TypeError(`writeTag: could not infer payload format for value ${value}; specify dataType`);
        }

        const request = buildRequest({ service, path, data: payload });
        const response = await this.session.sendUnconnected(request);
        if (response.generalStatus !== CipGeneralStatus.Success) {
            throw formatCipError(`writeTag("${tagPath}")`, response);
        }
    }

    /**
     * Sends multiple CIP requests in a single round-trip using Multiple Service Packet (0x0A) (§25).
     * If the remote device rejects service 0x0A with ServiceNotSupported (0x08), and fallbackToIndividual
     * is enabled (default), automatically executes each request individually via the session queue.
     *
     * @param {Array<Buffer|{service?: number, path?: Buffer, data?: Buffer, classId?: number, instance?: number, attribute?: number}>} requests
     * @param {object} [opts]
     * @param {boolean} [opts.fallbackToIndividual=true]
     * @returns {Promise<Array<{service: number, generalStatus: number, additionalStatus: number[], data: Buffer}>>}
     */
    async sendMultipleRequests(requests, { fallbackToIndividual = true } = {}) {
        if (!Array.isArray(requests) || requests.length === 0) {
            throw new TypeError('sendMultipleRequests: requests must be a non-empty array');
        }

        const normalizedRequests = requests.map((req) => {
            if (Buffer.isBuffer(req)) return req;
            let path = req.path;
            if (path && !Buffer.isBuffer(path)) {
                path = encodeEPath(path);
            } else if (!path && (req.classId !== undefined || req.instance !== undefined)) {
                path = encodeEPath({
                    classId: req.classId,
                    instance: req.instance,
                    attribute: req.attribute
                });
            }
            return buildRequest({
                service: req.service || CipCommonServices.GetAttributeSingle,
                path: path || Buffer.alloc(0),
                data: req.data || Buffer.alloc(0)
            });
        });

        const multiRequest = buildMultipleServiceRequest(normalizedRequests);
        const response = await this.session.sendUnconnected(multiRequest);

        if (response.generalStatus === CipGeneralStatus.Success || response.generalStatus === CipGeneralStatus.EmbeddedServiceError) {
            return parseMultipleServiceResponse(response.data);
        }

        // Check if device does not support Multiple Service Packet (0x0A)
        if (fallbackToIndividual && response.generalStatus === CipGeneralStatus.ServiceNotSupported) {
            return Promise.all(
                normalizedRequests.map(async (reqBuf) => {
                    const resp = await this.session.sendUnconnected(reqBuf);
                    return {
                        service: resp.service,
                        generalStatus: resp.generalStatus,
                        additionalStatus: resp.additionalStatus,
                        data: resp.data
                    };
                })
            );
        }

        throw formatCipError('sendMultipleRequests', response);
    }

    /**
     * Batch-reads multiple attributes in a single round-trip via Multiple Service Packet (0x0A).
     *
     * @param {Array<{classId: number, instance?: number, attribute?: number}>} targets
     * @param {object} [opts]
     * @returns {Promise<Array<{classId: number, instance: number, attribute: number, generalStatus: number, data: Buffer, error?: Error}>>}
     */
    async getAttributesMultiple(targets, opts) {
        const requests = targets.map((t) => ({
            service: CipCommonServices.GetAttributeSingle,
            classId: t.classId,
            instance: t.instance !== undefined ? t.instance : 1,
            attribute: t.attribute !== undefined ? t.attribute : 1
        }));
        const responses = await this.sendMultipleRequests(requests, opts);
        return responses.map((resp, i) => {
            const ok = resp.generalStatus === CipGeneralStatus.Success;
            return {
                classId: targets[i].classId,
                instance: targets[i].instance !== undefined ? targets[i].instance : 1,
                attribute: targets[i].attribute !== undefined ? targets[i].attribute : 1,
                generalStatus: resp.generalStatus,
                data: resp.data,
                error: ok ? null : formatCipError(`getAttribute(${targets[i].classId}/${targets[i].instance}/${targets[i].attribute})`, resp)
            };
        });
    }

    /** Forward_Open — see cip/connection-manager.js's buildForwardOpenRequest() for the full option list. */
    async openConnection(forwardOpenParams, opts) {
        return this.session.openConnection(forwardOpenParams, opts);
    }

    /** Large_Forward_Open (0x5B) with 32-bit connection parameters for sizes up to 65535 bytes. */
    async openLargeConnection(forwardOpenParams) {
        return this.session.openLargeConnection(forwardOpenParams);
    }

    /** Forward_Close a connection previously returned by openConnection(). */
    async closeConnection(connection) {
        return this.session.closeConnection(connection);
    }

    /**
     * Opens a connection configured automatically from an ODVA EDS profile (§43, §44, §45).
     * @param {import('./cip/eds').EdsFile} eds - Parsed EdsFile instance
     * @param {number|string} [connectionNameOrId=1] - Connection profile (e.g. 1 or "Connection1")
     * @param {object} [overrides] - Optional overrides for parameters
     * @returns {Promise<object>} Connection handle
     */
    async openConnectionFromEds(eds, connectionNameOrId = 1, overrides = {}) {
        const params = eds.buildForwardOpenParams(connectionNameOrId, overrides);
        return this.openConnection(params, overrides);
    }

    /**
     * Creates and returns a Class 1 Real-Time IOConnection (§14, §15, §16, §17).
     * @param {object} connection - Return value of openConnection() / openLargeConnection()
     * @param {object} [opts] - Additional IOConnection options
     * @returns {IOConnection}
     */
    createIoConnection(connection, opts) {
        return this.session.createIoConnection(connection, opts);
    }

    /** Current session state (e.g. 'DISCONNECTED', 'CONNECTING', 'REGISTERED'). */
    get state() {
        return this.session.state;
    }

    /** True if session is currently registered and ready for commands. */
    get connected() {
        return this.session.state === 'REGISTERED' || this.session.state === 'ACTIVE';
    }

    /** Sends Encapsulation NOP (0x0000) heartbeat / ping message. */
    async sendNop(opts) {
        return this.session.sendNop(opts);
    }

    /**
     * Convenience ping — tests connection liveness.
     * By default uses lightweight Identity Object attribute read (universally supported, e.g. Delta SX3).
     * If useNop is true, sends Encapsulation NOP (0x0000).
     */
    async ping(optionsOrData) {
        const useNop = typeof optionsOrData === 'object' && optionsOrData !== null && optionsOrData.useNop;
        const data = Buffer.isBuffer(optionsOrData) ? optionsOrData : (optionsOrData && optionsOrData.data);
        if (useNop) {
            const res = await this.session.sendNop({ data });
            return res.ok;
        }
        try {
            const val = await this.getAttribute({ classId: 0x01, instance: 1, attribute: 1 });
            return Boolean(val && val.length >= 2);
        } catch {
            return false;
        }
    }

    /**
     * Reads and decodes TCP/IP Interface Object (Class 0xF5) configuration from the remote device.
     */
    async getTcpIpConfig({ instance = 1 } = {}) {
        const [statusBuf, configBuf, hostBuf] = await Promise.all([
            this.getAttribute({ classId: CipClassCodes.TcpIpInterface, instance, attribute: 1 }).catch(() => null),
            this.getAttribute({ classId: CipClassCodes.TcpIpInterface, instance, attribute: 5 }).catch(() => null),
            this.getAttribute({ classId: CipClassCodes.TcpIpInterface, instance, attribute: 6 }).catch(() => null)
        ]);

        const status = statusBuf && statusBuf.length >= 4 ? statusBuf.readUInt32LE(0) : undefined;
        const config = configBuf ? decodeInterfaceConfiguration(configBuf) : null;
        const hostName = hostBuf ? decodeCipString(hostBuf, 0) : '';

        return {
            status,
            ...config,
            hostName
        };
    }

    /**
     * Reads and decodes Ethernet Link Object (Class 0xF6) information from the remote device.
     */
    async getEthernetLinkInfo({ instance = 1 } = {}) {
        const [speedBuf, flagsBuf, macBuf, labelBuf] = await Promise.all([
            this.getAttribute({ classId: CipClassCodes.EthernetLink, instance, attribute: 1 }).catch(() => null),
            this.getAttribute({ classId: CipClassCodes.EthernetLink, instance, attribute: 2 }).catch(() => null),
            this.getAttribute({ classId: CipClassCodes.EthernetLink, instance, attribute: 3 }).catch(() => null),
            this.getAttribute({ classId: CipClassCodes.EthernetLink, instance, attribute: 10 }).catch(() => null)
        ]);

        const speedMbps = speedBuf && speedBuf.length >= 4 ? speedBuf.readUInt32LE(0) : undefined;
        const flagsDword = flagsBuf && flagsBuf.length >= 4 ? flagsBuf.readUInt32LE(0) : undefined;
        const flags = flagsDword !== undefined ? decodeInterfaceFlags(flagsDword) : null;
        const macAddress = macBuf ? formatMacAddress(macBuf) : '';
        const interfaceLabel = labelBuf && labelBuf.length > 1 ? labelBuf.subarray(1, 1 + labelBuf[0]).toString('ascii') : '';

        return {
            speedMbps,
            macAddress,
            interfaceLabel,
            flags
        };
    }

    /**
     * Creates a real-time tag subscription / watcher.
     * Supports both 'polling' (TCP 44818) and 'udp' (Class 1 I/O port 2222) modes.
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

module.exports = { Scanner };
