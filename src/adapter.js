'use strict';

/**
 * Public EIP Adapter API (Phase 3) — this driver acting as the TARGET, not
 * just the originator. Accepts sessions, serves the generic CIP object
 * model (Identity, Assembly), and accepts Forward_Open for real cyclic I/O
 * — built entirely from the same vendor-neutral pieces the Scanner side
 * already validated live (encapsulation header/CPF, message-router framing,
 * path encode/decode, connection-manager, io-connection): nothing here is
 * new wire-protocol knowledge, only the serving side of it.
 *
 * Per this project's compliance principle (README): must be connectable
 * from any conformant Scanner, not just this driver's own — every method
 * used to answer requests is the same generic Get_Attribute_Single/
 * Set_Attribute_Single/Forward_Open framing already proven against real
 * Delta hardware, just running in reverse.
 */

const { EventEmitter } = require('events');
const net = require('net');
const dgram = require('dgram');
const os = require('os');
const { encodeMessage, decodeMessage } = require('./encapsulation/header');
const { encodeCpf, decodeCpf, CpfItemType } = require('./encapsulation/cpf');
const { encodeIdentityItem } = require('./encapsulation/identity');
const { buildSendRRData, readSendRRDataResponse } = require('./encapsulation/rrdata');
const { readRegisterSessionRequest, buildRegisterSessionResponse } = require('./encapsulation/session');
const { buildListServicesResponse, buildNopResponse } = require('./encapsulation/services');
const { parseRequest, buildResponse } = require('./cip/message-router');
const { decodeEPath } = require('./cip/path');
const {
    ConnectionManagerServices,
    parseForwardOpenRequest,
    parseLargeForwardOpenRequest,
    buildForwardOpenResponse,
    parseForwardCloseRequest,
    buildForwardCloseResponse
} = require('./cip/connection-manager');
const { IdentityObject } = require('./cip/objects/identity');
const { AssemblyObject } = require('./cip/objects/assembly');
const { TcpIpInterfaceObject } = require('./cip/objects/tcp-ip');
const { EthernetLinkObject } = require('./cip/objects/ethernet-link');
const { MessageRouterObject } = require('./cip/objects/message-router');
const { QoSObject } = require('./cip/objects/qos');
const { PortObject } = require('./cip/objects/port');
const { DeviceLevelRingObject } = require('./cip/objects/dlr');
const { ConnectionManagerObject } = require('./cip/objects/connection-manager-object');
const { DeltaRegisterStore, DeltaRegisterObject } = require('./cip/objects/delta-registers');
const { GenericCipObject } = require('./cip/objects/generic-object');
const { ConnectionHandler } = require('./adapter/connection-handler');
const { encodeMultipleServiceResponseData } = require('./cip/multiple-service');
const { encodeType, decodeType } = require('./cip/types');
const { EncapsulationCommands, EncapsulationStatus, CipGeneralStatus, CipCommonServices, CipClassCodes, EIP_ENCAPSULATION_PORT, EIP_IO_UDP_PORT } = require('./constants');

function getLocalInterfaceDetails(targetAddress) {
    const interfaces = os.networkInterfaces();
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries || []) {
            if (entry.family === 'IPv4') {
                if (targetAddress && entry.address === targetAddress) {
                    return { name, address: entry.address, netmask: entry.netmask, mac: entry.mac };
                }
            }
        }
    }
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries || []) {
            if (!entry.internal && entry.family === 'IPv4') {
                return { name, address: entry.address, netmask: entry.netmask, mac: entry.mac };
            }
        }
    }
    return { name: 'eth0', address: '127.0.0.1', netmask: '255.255.255.0', mac: '00:00:00:00:00:00' };
}

class EIPAdapter extends EventEmitter {
    constructor({ port = EIP_ENCAPSULATION_PORT, ioPort = EIP_IO_UDP_PORT, address, identity, tcpIp, ethernetLink, quiet = false, strictDuplicateConnections = false } = {}) {
        super();
        this.quiet = Boolean(quiet);
        this.port = port;
        this.ioPort = ioPort;
        const iface = getLocalInterfaceDetails(address);
        this.address = (address && address !== '0.0.0.0') ? address : iface.address;
        this.identity = new IdentityObject(identity);
        this.assembly = new AssemblyObject();
        this.messageRouter = new MessageRouterObject();
        this.qos = new QoSObject();
        this.portObj = new PortObject({ portName: 'Port 1' });
        this.dlr = new DeviceLevelRingObject();
        this.connectionManagerObj = new ConnectionManagerObject();
        this.deltaStore = new DeltaRegisterStore();

        this.ethernetLink = new EthernetLinkObject({
            macAddress: (ethernetLink && ethernetLink.macAddress) || iface.mac,
            interfaceLabel: (ethernetLink && ethernetLink.interfaceLabel) || iface.name,
            ...ethernetLink
        });
        this.tcpIp = new TcpIpInterfaceObject({
            ip: this.address,
            netmask: iface.netmask,
            gateway: (tcpIp && tcpIp.gateway) || (this.address.includes('.') ? this.address.replace(/\.\d+$/, '.1') : '0.0.0.0'),
            hostName: os.hostname(),
            ...tcpIp
        });

        this.tags = new Map(); // tagName -> { type, buffer, value }

        this.objects = new Map();
        this.objects.set(CipClassCodes.Identity, this.identity);
        this.objects.set(CipClassCodes.MessageRouter, this.messageRouter);
        this.objects.set(CipClassCodes.Assembly, this.assembly);
        this.objects.set(CipClassCodes.ConnectionManager, this.connectionManagerObj);
        this.objects.set(CipClassCodes.DLR, this.dlr);
        this.objects.set(CipClassCodes.QoS, this.qos);
        this.objects.set(CipClassCodes.Port, this.portObj);
        this.objects.set(CipClassCodes.TcpIpInterface, this.tcpIp);
        this.objects.set(CipClassCodes.EthernetLink, this.ethernetLink);

        // Register Delta Vendor Specific Objects (0x350..0x359, 0x370..0x376)
        const deltaClasses = [0x350, 0x351, 0x352, 0x353, 0x354, 0x355, 0x356, 0x357, 0x358, 0x359, 0x370, 0x371, 0x372, 0x373, 0x374, 0x375, 0x376];
        for (const c of deltaClasses) {
            this.objects.set(c, new DeltaRegisterObject(c, this.deltaStore));
        }

        this.connectionHandler = new ConnectionHandler({
            assemblyObject: this.assembly,
            identity: this.identity,
            connectionManagerObject: this.connectionManagerObj,
            quiet: this.quiet,
            strictDuplicateConnections: Boolean(strictDuplicateConnections),
            tagStore: this.tags,
            tcpIpObject: this.tcpIp,
            // Lets the ConnectionHandler write incoming O->T Class 1 datagrams
            // into a symbolic tag (Produced/Consumed Tag connection) while
            // this object still owns value-decoding and event emission —
            // exactly the same tagWrite/tagChange contract as an explicit
            // Set_Attribute_Single write to the tag (see _dispatchCipRequest below).
            onTagWrite: (tagName, payload) => {
                const tag = this.tags.get(tagName);
                if (!tag) return;
                const oldVal = tag.value;
                tag.buffer = Buffer.from(payload);
                try { tag.value = decodeType(tag.type, tag.buffer).value; } catch {}
                this.emit('tagWrite', tagName, tag.value, oldVal, { source: 'io' });
                if (tag.value !== oldVal) {
                    this.emit('tagChange', tagName, tag.value, oldVal, { source: 'io' });
                }
            },
            sendDatagram: (buf, remoteAddress, remotePort, options = {}) => {
                if (!this._udpIo) return;
                let targetIp = options.multicast ? this.tcpIp.multicastAddress : remoteAddress;
                if (typeof targetIp === 'string' && targetIp.startsWith('::ffff:')) {
                    targetIp = targetIp.slice(7);
                }
                const port = remotePort || this.ioPort || 2222;
                this._udpIo.send(buf, port, targetIp, () => {});
            }
        });

        this._sessions = new Map(); // sessionHandle -> socket
        this._nextSessionHandle = 1;
        this._tcpServer = null;
        this._udpListen = null;
        this._udpIo = null;
    }

    /** Defines (or resets) an Assembly instance's data buffer — call before start(), or any time after. */
    defineAssembly(instance, sizeBytes) {
        this.assembly.define(instance, sizeBytes);
        return this;
    }

    /**
     * Defines a named symbolic tag on the adapter (§26, §27).
     *
     * @param {string} name Tag name (e.g. "TotalCount", "Motor.Speed")
     * @param {string|object} [typeOrOpts='DINT'] Data type name or options object
     * @param {any} [initialValue=0]
     */
    defineTag(name, typeOrOpts = 'DINT', initialValue = 0) {
        let type = typeof typeOrOpts === 'string' ? typeOrOpts : (typeOrOpts.type || 'DINT');
        let val = typeof typeOrOpts === 'object' && typeOrOpts.value !== undefined ? typeOrOpts.value : initialValue;
        const buf = encodeType(type, val);
        this.tags.set(name, { type, buffer: buf, value: val });
        return this;
    }

    getTag(name) {
        return this.tags.get(name);
    }

    setTag(name, value) {
        const tag = this.tags.get(name);
        if (!tag) {
            throw new Error(`EIPAdapter: tag "${name}" is not defined`);
        }
        if (Buffer.isBuffer(value)) {
            tag.buffer = Buffer.from(value);
            try {
                tag.value = decodeType(tag.type, tag.buffer).value;
            } catch {}
        } else {
            tag.value = value;
            tag.buffer = encodeType(tag.type, value);
        }
        return this;
    }

    /** Registers a handler for an additional CIP object class (must expose getAttributeSingle/setAttributeSingle). */
    registerObject(classId, handler) {
        this.objects.set(classId, handler);
        if (this.messageRouter && typeof this.messageRouter.addClass === 'function') {
            this.messageRouter.addClass(classId);
        }
        return this;
    }

    /**
     * Explicitly triggers production for an Application-Object-trigger connection producing the
     * given T->O Assembly instance or symbolic tag name — see
     * ConnectionHandler.triggerProduction()'s doc comment for what this trigger type means and
     * why it needs an explicit call at all (it's the one CIP production trigger a Scanner's RPI
     * timer and Change-of-State comparison can't drive by themselves). No-op if no currently-open
     * connection to that instance/tag actually negotiated Application Object trigger.
     *
     * @param {number|string} t2oInstanceOrTagName
     * @returns {number} how many connections were actually triggered
     */
    triggerProduction(t2oInstanceOrTagName) {
        return this.connectionHandler.triggerProduction(t2oInstanceOrTagName);
    }

    async start() {
        await this._startTcp();
        await this._startUdpListen();
        await this._startUdpIo();
    }

    async stop() {
        this.connectionHandler.closeAll();
        for (const socket of this._sessions.values()) socket.destroy();
        this._sessions.clear();

        await Promise.all([
            this._tcpServer ? new Promise((resolve) => this._tcpServer.close(resolve)) : Promise.resolve(),
            this._udpListen ? new Promise((resolve) => this._udpListen.close(resolve)) : Promise.resolve(),
            this._udpIo ? new Promise((resolve) => this._udpIo.close(resolve)) : Promise.resolve()
        ]);
    }

    _startTcp() {
        return new Promise((resolve, reject) => {
            this._tcpServer = net.createServer((socket) => this._handleTcpConnection(socket));
            this._tcpServer.once('error', reject);
            this._tcpServer.listen(this.port, () => {
                resolve();
            });
        });
    }

    /**
     * Probes whether another process already has `port` bound, WITHOUT the reuseAddr option
     * that this adapter's own real sockets use. reuseAddr lets multiple sockets (including ones
     * from a completely different process, e.g. a leftover eip_device.js from a previous test)
     * silently share the same UDP port with no error at all — the OS then splits incoming
     * datagrams between them unpredictably, so ONE of the processes quietly loses some of the
     * PLC's own I/O packets. That looks exactly like corrupted/jumpy data with no diagnostic. A
     * non-reuseAddr probe bind fails loudly (EADDRINUSE) if anything else already holds the
     * port, so we can at least warn instead of silently sharing it.
     * @returns {Promise<boolean>} true if the port already appears to be in use elsewhere.
     */
    _probePortInUse(port, address) {
        return new Promise((resolve) => {
            const probe = dgram.createSocket({ type: 'udp4', reuseAddr: false });
            probe.once('error', () => {
                try { probe.close(); } catch { /* already closed */ }
                resolve(true);
            });
            probe.bind(port, address, () => {
                probe.close(() => resolve(false));
            });
        });
    }

    async _warnIfPortInUse(port, address, label) {
        const inUse = await this._probePortInUse(port, address);
        if (inUse) {
            console.warn(
                `\x1b[33m[WARNING]\x1b[0m Port ${port} (${label}) appears to already be in use by ` +
                `another process (e.g. a previous eip_device.js/adapter instance left running). ` +
                `This socket binds with reuseAddr, so it will start anyway, but the OS can then ` +
                `split incoming datagrams between the two processes unpredictably — this looks ` +
                `like corrupted or dropped data with no error. Stop any other process bound to ` +
                `this port before relying on timing/data captured from this run.`
            );
        }
    }

    _startUdpListen() {
        return new Promise((resolve, reject) => {
            this._udpListen = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this._udpListen.once('error', reject);
            this._udpListen.on('message', (msg, rinfo) => this._handleUdpListen(msg, rinfo));
            this._udpListen.bind(this.port, () => {
                this._udpListen.setBroadcast(true);
                this._udpListen.removeAllListeners('error');
                this._udpListen.on('error', (err) => {
                    console.error('\x1b[31m[UDP 44818 ERROR]\x1b[0m', err.message);
                });
                resolve();
            });
        });
    }

    async _startUdpIo() {
        const bindAddr = (this.address && this.address !== '0.0.0.0') ? this.address : undefined;
        await this._warnIfPortInUse(this.ioPort, bindAddr, 'Class 1 I/O');
        return new Promise((resolve, reject) => {
            this._udpIo = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            this._udpIo.once('error', reject);
            this._udpIo.on('message', (msg, rinfo) => this.connectionHandler.handleIncomingDatagram(msg, rinfo));
            this._udpIo.bind(this.ioPort, bindAddr, () => {
                // TTL 1 for multicast Class 1 I/O production — matches OpENer's own default and
                // the assumption behind the off-subnet rejection check in connection-handler.js
                // (a TTL-1 multicast datagram can't reach past the local subnet's first router
                // anyway, so a Scanner outside it is rejected at Forward_Open time instead).
                try { this._udpIo.setMulticastTTL(1); } catch {}
                this._udpIo.removeAllListeners('error');
                this._udpIo.on('error', (err) => {
                    console.error('\x1b[31m[UDP 2222 ERROR]\x1b[0m', err.message);
                });
                resolve();
            });
        });
    }

    _buildIdentityItemBuffer() {
        return encodeIdentityItem({
            socketAddress: { address: this.address, port: this.port },
            vendorId: this.identity.vendorId,
            deviceType: this.identity.deviceType,
            productCode: this.identity.productCode,
            revision: this.identity.revision,
            serialNumber: this.identity.serialNumber,
            productName: this.identity.productName,
            status: this.identity.status,
            state: this.identity.state
        });
    }

    _handleUdpListen(msg, rinfo) {
        const decoded = decodeMessage(msg);
        if (!decoded) return;
        if (decoded.header.command === EncapsulationCommands.ListIdentity) {
            const cpf = encodeCpf([{ typeId: CpfItemType.ListIdentityResponse, data: this._buildIdentityItemBuffer() }]);
            const response = encodeMessage({ command: EncapsulationCommands.ListIdentity, senderContext: decoded.header.senderContext }, cpf);
            this._udpListen.send(response, rinfo.port, rinfo.address);
        } else if (decoded.header.command === EncapsulationCommands.ListServices) {
            const response = buildListServicesResponse({ senderContext: decoded.header.senderContext });
            this._udpListen.send(response, rinfo.port, rinfo.address);
        }
    }

    _handleTcpConnection(socket) {
        let buffer = Buffer.alloc(0);
        let sessionHandle = 0;

        // Encapsulation Session Inactivity Timeout — CIP Vol 2 §2-4.6, TCP/IP Interface Object
        // Attribute 13 (this.tcpIp.inactivityTimeoutSec, default 120s per its own constructor).
        // Without this, a session that registers and then goes silent (a half-hung client, one
        // that never sends a proper UnRegisterSession or FIN) leaks its socket and session handle
        // forever — found via an ODVA compliance audit of this file, confirmed by grepping for any
        // socket.setTimeout()/inactivity handling here and finding none. Read once per connection
        // at accept time (a later Set_Attribute_Single change to the timeout value applies to
        // subsequent connections, not retroactively to ones already open — a reasonable, simple
        // choice, not a spec requirement either way). 0 means "disabled", matching the attribute's
        // own documented semantics for this object.
        const inactivityTimeoutSec = this.tcpIp.inactivityTimeoutSec;
        if (inactivityTimeoutSec > 0) {
            socket.setTimeout(inactivityTimeoutSec * 1000);
            socket.on('timeout', () => {
                if (!this.quiet) {
                    console.warn(`[TCP INACTIVITY TIMEOUT] closing session after ${inactivityTimeoutSec}s of silence`);
                }
                socket.destroy();
            });
        }

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            for (;;) {
                const msg = decodeMessage(buffer);
                if (!msg) return;
                buffer = buffer.subarray(msg.bytesConsumed);
                try {
                    const result = this._handleEncapsulationMessage(socket, msg, sessionHandle);
                    if (result && result.sessionHandle !== undefined) sessionHandle = result.sessionHandle;
                    if (result && result.closed) return;
                } catch (err) {
                    console.error('[TCP MSG ERR]', err);
                    // Malformed request from a client — drop the connection rather than crash the adapter.
                    socket.destroy();
                    return;
                }
            }
        });

        socket.on('close', () => {
            if (sessionHandle) this._sessions.delete(sessionHandle);
        });
        socket.on('error', () => {}); // e.g. ECONNRESET from an abruptly-closed client — nothing to do
    }

    _handleEncapsulationMessage(socket, msg, currentSessionHandle) {
        const { header, data } = msg;

        switch (header.command) {
            case EncapsulationCommands.ListServices: {
                socket.write(buildListServicesResponse({ senderContext: header.senderContext }));
                return {};
            }
            case EncapsulationCommands.ListIdentity: {
                const cpf = encodeCpf([{ typeId: CpfItemType.ListIdentityResponse, data: this._buildIdentityItemBuffer() }]);
                socket.write(encodeMessage({ command: EncapsulationCommands.ListIdentity, senderContext: header.senderContext }, cpf));
                return {};
            }
            case EncapsulationCommands.ListInterfaces: {
                // ODVA CIP Vol 2, section 2-4.4: Returns CPF with 0 items when no sub-interfaces
                const emptyCpf = Buffer.alloc(2);
                emptyCpf.writeUInt16LE(0, 0);
                socket.write(encodeMessage({ command: EncapsulationCommands.ListInterfaces, senderContext: header.senderContext }, emptyCpf));
                return {};
            }
            case EncapsulationCommands.RegisterSession: {
                readRegisterSessionRequest({ data }); // validated for shape; protocol version not currently gated
                const sessionHandle = this._nextSessionHandle++;
                this._sessions.set(sessionHandle, socket);
                socket.write(buildRegisterSessionResponse({ sessionHandle, senderContext: header.senderContext }));
                return { sessionHandle };
            }
            case EncapsulationCommands.UnRegisterSession: {
                this._sessions.delete(header.sessionHandle);
                socket.destroy();
                return { closed: true };
            }
            case EncapsulationCommands.SendRRData: {
                // ODVA CIP Vol 2, 2-4.7: every SendRRData must carry an
                // already-registered session handle — reject anything else
                // with InvalidSessionHandle rather than silently servicing
                // it (ported from OpENer's encap.c, HandleReceivedSendRequestResponseDataCommand,
                // which calls CheckRegisteredSessions() before dispatching).
                if (!this._sessions.has(header.sessionHandle)) {
                    socket.write(encodeMessage({
                        command: header.command,
                        sessionHandle: header.sessionHandle,
                        status: EncapsulationStatus.InvalidSessionHandle,
                        senderContext: header.senderContext
                    }));
                    return {};
                }
                // readSendRRDataResponse()'s name is client-flavored, but the CPF
                // unwrap it does is identical in both directions — reused here.
                const { cipResponse: cipRequestBytes } = readSendRRDataResponse(msg);
                const cipResponseBytes = this._dispatchCipRequest(cipRequestBytes, { remoteAddress: socket.remoteAddress });
                socket.write(buildSendRRData(header.sessionHandle, cipResponseBytes, { senderContext: header.senderContext }));
                return {};
            }
            case EncapsulationCommands.SendUnitData: {
                // ODVA CIP Vol 2, section 2-4.9: Connected Explicit Messaging (Class 3)
                if (!this._sessions.has(header.sessionHandle)) {
                    socket.write(encodeMessage({
                        command: header.command,
                        sessionHandle: header.sessionHandle,
                        status: EncapsulationStatus.InvalidSessionHandle,
                        senderContext: header.senderContext
                    }));
                    return {};
                }
                if (!data || data.length < 6) {
                    return {};
                }
                const { items } = decodeCpf(data.subarray(6));
                const addrItem = items.find((item) => item.typeId === CpfItemType.ConnectedAddress);
                const dataItem = items.find((item) => item.typeId === CpfItemType.ConnectedTransportData);
                const connectionId = addrItem && addrItem.data.length >= 4 ? addrItem.data.readUInt32LE(0) : 0;
                let cipRequestBytes = (dataItem && dataItem.data) || Buffer.alloc(0);
                let sequenceCount;
                if (cipRequestBytes.length >= 2) {
                    sequenceCount = cipRequestBytes.readUInt16LE(0);
                    cipRequestBytes = cipRequestBytes.subarray(2);
                }

                const cipResponseBytes = this._dispatchCipRequest(cipRequestBytes, { remoteAddress: socket.remoteAddress, connectionId });

                const conn = this.connectionHandler.connections.get(connectionId)
                    || Array.from(this.connectionHandler.connections.values()).find(c => c.toNetworkConnectionId === connectionId);
                const respConnId = conn ? conn.toNetworkConnectionId : connectionId;

                const respAddrBuf = Buffer.alloc(4);
                respAddrBuf.writeUInt32LE(respConnId >>> 0, 0);

                let respDataBuf = cipResponseBytes;
                if (sequenceCount !== undefined) {
                    const seqBuf = Buffer.alloc(2);
                    seqBuf.writeUInt16LE(sequenceCount, 0);
                    respDataBuf = Buffer.concat([seqBuf, cipResponseBytes]);
                }

                const respCpf = encodeCpf([
                    { typeId: CpfItemType.ConnectedAddress, data: respAddrBuf },
                    { typeId: CpfItemType.ConnectedTransportData, data: respDataBuf }
                ]);
                const prefix = Buffer.alloc(6);
                prefix.writeUInt32LE(0, 0); // Interface Handle (0 for CIP)
                prefix.writeUInt16LE(0, 4); // Timeout

                const fullPayload = Buffer.concat([prefix, respCpf]);
                socket.write(encodeMessage({
                    command: EncapsulationCommands.SendUnitData,
                    sessionHandle: header.sessionHandle,
                    senderContext: header.senderContext
                }, fullPayload));
                return {};
            }
            case EncapsulationCommands.NOP: {
                socket.write(buildNopResponse({
                    sessionHandle: header.sessionHandle,
                    senderContext: header.senderContext,
                    data
                }));
                return {};
            }
            default: {
                // ODVA spec: respond with InvalidCommand (0x0001) for unsupported encapsulation commands
                const errorResponse = encodeMessage({
                    command: header.command,
                    sessionHandle: header.sessionHandle,
                    status: EncapsulationStatus.InvalidCommand,
                    senderContext: header.senderContext
                });
                socket.write(errorResponse);
                return {};
            }
        }
    }

    _dispatchCipRequest(cipRequestBytes, context) {
        let request;
        try {
            request = parseRequest(cipRequestBytes);
        } catch {
            return buildResponse({ service: 0, generalStatus: CipGeneralStatus.MessageFormatError });
        }

        let path;
        try {
            path = decodeEPath(request.path);
        } catch {
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.PathSegmentError });
        }

        const svcHex = '0x' + request.service.toString(16).padStart(2, '0').toUpperCase();
        const classHex = path.classId !== undefined ? '0x' + path.classId.toString(16).padStart(2, '0').toUpperCase() : 'N/A';
        const instStr = path.instance !== undefined ? path.instance : 'N/A';
        const attrStr = path.attribute !== undefined ? path.attribute : 'N/A';
        const remoteStr = (context && context.remoteAddress) || 'client';

        if (path.classId === CipClassCodes.ConnectionManager) {
            if (
                request.service === ConnectionManagerServices.ForwardOpen ||
                request.service === ConnectionManagerServices.LargeForwardOpen ||
                request.service === ConnectionManagerServices.ForwardClose ||
                request.service === 0x52 // Unconnected_Send
            ) {
                const resp = this._dispatchConnectionManager(request, context);
                const statusHex = '0x' + (resp[2] !== undefined ? resp[2].toString(16).padStart(2, '0') : '00').toUpperCase();
                if (!this.quiet) {
                    console.log(`\x1b[35m[CIP ROUTE]\x1b[0m ${remoteStr} | ConnMgr Svc: ${svcHex} -> Status: ${statusHex}`);
                }
                return resp;
            }
            // Other services (e.g. GetAttributeSingle 0x0E, GetAttributeAll 0x01) fall through to this.connectionManagerObj!
        }

        if (request.service === CipCommonServices.MultipleServicePacket) {
            return this._dispatchMultipleService(request, context);
        }

        // Handle Symbolic Tag Addressing (§26, §27)
        if (path.tagPath || (path.symbols && path.symbols.length > 0)) {
            const tagName = path.tagPath || path.symbols[0];
            const tag = this.tags.get(tagName);
            if (!tag) {
                return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.PathDestinationUnknown });
            }
            if (request.service === CipCommonServices.GetAttributeSingle || request.service === 0x4c) {
                return buildResponse({
                    service: request.service,
                    generalStatus: CipGeneralStatus.Success,
                    data: tag.buffer
                });
            }
            if (request.service === CipCommonServices.SetAttributeSingle || request.service === 0x4d) {
                const oldVal = tag.value;
                tag.buffer = Buffer.from(request.data);
                try {
                    tag.value = decodeType(tag.type, tag.buffer).value;
                } catch {}
                this.emit('tagWrite', tagName, tag.value, oldVal, context);
                if (tag.value !== oldVal) {
                    this.emit('tagChange', tagName, tag.value, oldVal, context);
                }
                return buildResponse({
                    service: request.service,
                    generalStatus: CipGeneralStatus.Success,
                    data: Buffer.alloc(0)
                });
            }
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.ServiceNotSupported });
        }

        const handler = this.objects.get(path.classId);
        if (!handler) {
            if (!this.quiet) {
                console.log(`\x1b[33m[CIP UNKNOWN]\x1b[0m ${remoteStr} | Svc: ${svcHex} | Class: ${classHex} (Missing) | Inst: ${instStr}`);
            }
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.PathDestinationUnknown });
        }

        let result;
        if (typeof handler.handleService === 'function') {
            result = handler.handleService(request.service, path, request.data);
            if (result && result.generalStatus === CipGeneralStatus.ServiceNotSupported) {
                result = null; // fallback to standard service handling
            }
        }
        if (!result) {
            if (request.service === CipCommonServices.GetAttributeSingle || request.service === 0x32) {
                result = handler.getAttributeSingle(path.instance, path.attribute, request.data);
            } else if (request.service === CipCommonServices.SetAttributeSingle || request.service === 0x33) {
                result = handler.setAttributeSingle(path.instance, path.attribute, request.data);
            } else if (request.service === CipCommonServices.GetAttributeAll && typeof handler.getAttributesAll === 'function') {
                result = handler.getAttributesAll(path.instance);
            } else {
                result = { generalStatus: CipGeneralStatus.ServiceNotSupported, data: Buffer.alloc(0) };
            }
        }

        const statusHex = '0x' + (result.generalStatus !== undefined ? result.generalStatus.toString(16).padStart(2, '0') : '00').toUpperCase();
        if (!this.quiet) {
            console.log(`\x1b[36m[CIP EXPLICIT]\x1b[0m ${remoteStr} | Svc: ${svcHex} | Class: ${classHex} | Inst: ${instStr} | Attr: ${attrStr} -> Status: ${statusHex} (${(result.data && result.data.length) || 0}B)`);
        }

        return buildResponse({
            service: request.service,
            generalStatus: result.generalStatus,
            additionalStatus: result.additionalStatus || [],
            data: result.data || Buffer.alloc(0)
        });
    }

    _dispatchConnectionManager(request, context) {
        if (request.service === ConnectionManagerServices.ForwardOpen || request.service === ConnectionManagerServices.LargeForwardOpen) {
            const parsed = request.service === ConnectionManagerServices.LargeForwardOpen
                ? parseLargeForwardOpenRequest(request.data)
                : parseForwardOpenRequest(request.data);
            const result = this.connectionHandler.openConnection(parsed, context);
            if (!result.ok) {
                const extHex = '0x' + (result.extendedStatus ? result.extendedStatus.toString(16).padStart(4, '0') : '0000').toUpperCase();
                if (!this.quiet) {
                    console.log(`\x1b[31m[ConnMgr Open REJECT]\x1b[0m General: 0x${result.generalStatus.toString(16)} | Extended: ${extHex} | Path: ${parsed.connectionPath.toString('hex')}`);
                }
                return buildResponse({ service: request.service, generalStatus: result.generalStatus, additionalStatus: [result.extendedStatus] });
            }
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.Success, data: buildForwardOpenResponse(result.response) });
        }
        if (request.service === ConnectionManagerServices.ForwardClose) {
            const parsed = parseForwardCloseRequest(request.data);
            const result = this.connectionHandler.closeConnection(parsed);
            if (!result.ok) {
                return buildResponse({ service: request.service, generalStatus: result.generalStatus, additionalStatus: [result.extendedStatus] });
            }
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.Success, data: buildForwardCloseResponse(result.response) });
        }
        if (request.service === ConnectionManagerServices.UnconnectedSend) {
            // CIP Vol 1, Section 3-5.5.3 (Unconnected_Send)
            if (!request.data || request.data.length < 4) {
                return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.NotEnoughData });
            }
            const msgReqSize = request.data.readUInt16LE(2);
            if (request.data.length < 4 + msgReqSize) {
                return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.NotEnoughData });
            }
            const embeddedReq = request.data.subarray(4, 4 + msgReqSize);
            const embeddedResp = this._dispatchCipRequest(embeddedReq, context);
            return buildResponse({
                service: request.service,
                generalStatus: CipGeneralStatus.Success,
                data: embeddedResp
            });
        }
        if (request.service === CipCommonServices.GetAttributeSingle) {
            const path = decodeEPath(request.path);
            if (path.instance === 0 && path.attribute === 1) {
                const b = Buffer.alloc(2);
                b.writeUInt16LE(1, 0); // Revision
                return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.Success, data: b });
            }
            if (path.instance === 1) {
                const b = Buffer.alloc(2);
                b.writeUInt16LE(0, 0);
                return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.Success, data: b });
            }
        }
        return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.ServiceNotSupported });
    }

    _dispatchMultipleService(request, context) {
        const data = request.data;
        if (!Buffer.isBuffer(data) || data.length < 2) {
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.NotEnoughData });
        }
        const count = data.readUInt16LE(0);
        if (data.length < 2 + count * 2) {
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.NotEnoughData });
        }
        const offsets = [];
        for (let i = 0; i < count; i++) {
            offsets.push(data.readUInt16LE(2 + i * 2));
        }

        const subResponses = [];
        for (let i = 0; i < count; i++) {
            const start = offsets[i];
            const end = (i + 1 < count) ? offsets[i + 1] : data.length;
            const subReqBytes = data.subarray(start, end);
            const subRespBytes = this._dispatchCipRequest(subReqBytes, context);
            subResponses.push(subRespBytes);
        }

        const responsePayload = encodeMultipleServiceResponseData(subResponses);
        return buildResponse({
            service: request.service,
            generalStatus: CipGeneralStatus.Success,
            data: responsePayload
        });
    }
}

module.exports = { EIPAdapter };
