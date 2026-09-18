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
const { encodeCpf, CpfItemType } = require('./encapsulation/cpf');
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
const { ConnectionHandler } = require('./adapter/connection-handler');
const { encodeMultipleServiceResponseData } = require('./cip/multiple-service');
const { encodeType, decodeType } = require('./cip/types');
const { EncapsulationCommands, CipGeneralStatus, CipCommonServices, CipClassCodes, EIP_ENCAPSULATION_PORT, EIP_IO_UDP_PORT } = require('./constants');

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
    constructor({ port = EIP_ENCAPSULATION_PORT, ioPort = EIP_IO_UDP_PORT, address, identity, tcpIp, ethernetLink } = {}) {
        super();
        this.port = port;
        this.ioPort = ioPort;
        const iface = getLocalInterfaceDetails(address);
        this.address = address || iface.address;
        this.identity = new IdentityObject(identity);
        this.assembly = new AssemblyObject();
        this.ethernetLink = new EthernetLinkObject({
            macAddress: (ethernetLink && ethernetLink.macAddress) || iface.mac,
            interfaceLabel: (ethernetLink && ethernetLink.interfaceLabel) || iface.name,
            ...ethernetLink
        });
        this.tcpIp = new TcpIpInterfaceObject({
            ip: this.address,
            netmask: iface.netmask,
            hostName: os.hostname(),
            ...tcpIp
        });

        this.objects = new Map();
        this.objects.set(CipClassCodes.Identity, this.identity);
        this.objects.set(CipClassCodes.Assembly, this.assembly);
        this.objects.set(CipClassCodes.TcpIpInterface, this.tcpIp);
        this.objects.set(CipClassCodes.EthernetLink, this.ethernetLink);

        this.connectionHandler = new ConnectionHandler({
            assemblyObject: this.assembly,
            sendDatagram: (buf, remoteAddress, remotePort) => {
                if (!this._udpIo) return;
                const port = remotePort || this.ioPort;
                this._udpIo.send(buf, port, remoteAddress);
            }
        });

        this._sessions = new Map(); // sessionHandle -> socket
        this._nextSessionHandle = 1;
        this._tcpServer = null;
        this._udpListen = null;
        this._udpIo = null;
        this.tags = new Map(); // tagName -> { type, buffer, value }
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
        return this;
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
            this._tcpServer.listen(this.port, () => resolve());
        });
    }

    _startUdpListen() {
        return new Promise((resolve, reject) => {
            this._udpListen = dgram.createSocket('udp4');
            this._udpListen.once('error', reject);
            this._udpListen.on('message', (msg, rinfo) => this._handleUdpListen(msg, rinfo));
            this._udpListen.bind(this.port, () => {
                this._udpListen.setBroadcast(true);
                // Safety net for after startup — e.g. an ICMP port-unreachable
                // surfacing async on a later send() to nobody listening must
                // not crash the process (an unhandled 'error' event throws).
                this._udpListen.removeAllListeners('error');
                this._udpListen.on('error', () => {});
                resolve();
            });
        });
    }

    _startUdpIo() {
        return new Promise((resolve, reject) => {
            this._udpIo = dgram.createSocket('udp4');
            this._udpIo.once('error', reject);
            this._udpIo.on('message', (msg, rinfo) => this.connectionHandler.handleIncomingDatagram(msg, rinfo));
            this._udpIo.bind(this.ioPort, () => {
                this._udpIo.removeAllListeners('error');
                this._udpIo.on('error', () => {});
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
                } catch {
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
                // readSendRRDataResponse()'s name is client-flavored, but the CPF
                // unwrap it does is identical in both directions — reused here.
                const { cipResponse: cipRequestBytes } = readSendRRDataResponse(msg);
                const cipResponseBytes = this._dispatchCipRequest(cipRequestBytes, { remoteAddress: socket.remoteAddress });
                socket.write(buildSendRRData(header.sessionHandle, cipResponseBytes, { senderContext: header.senderContext }));
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

        if (path.classId === CipClassCodes.ConnectionManager) {
            return this._dispatchConnectionManager(request, context);
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
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.PathDestinationUnknown });
        }

        let result;
        if (request.service === CipCommonServices.GetAttributeSingle) {
            result = handler.getAttributeSingle(path.instance, path.attribute, request.data);
        } else if (request.service === CipCommonServices.SetAttributeSingle) {
            result = handler.setAttributeSingle(path.instance, path.attribute, request.data);
        } else if (request.service === CipCommonServices.GetAttributeAll && typeof handler.getAttributesAll === 'function') {
            result = handler.getAttributesAll(path.instance);
        } else {
            result = { generalStatus: CipGeneralStatus.ServiceNotSupported, data: Buffer.alloc(0) };
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
