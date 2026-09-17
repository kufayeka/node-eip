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

const net = require('net');
const dgram = require('dgram');
const os = require('os');
const { encodeMessage, decodeMessage } = require('./encapsulation/header');
const { encodeCpf, CpfItemType } = require('./encapsulation/cpf');
const { encodeIdentityItem } = require('./encapsulation/identity');
const { buildSendRRData, readSendRRDataResponse } = require('./encapsulation/rrdata');
const { readRegisterSessionRequest, buildRegisterSessionResponse } = require('./encapsulation/session');
const { parseRequest, buildResponse } = require('./cip/message-router');
const { decodeEPath } = require('./cip/path');
const {
    ConnectionManagerServices,
    parseForwardOpenRequest,
    buildForwardOpenResponse,
    parseForwardCloseRequest,
    buildForwardCloseResponse
} = require('./cip/connection-manager');
const { IdentityObject } = require('./cip/objects/identity');
const { AssemblyObject } = require('./cip/objects/assembly');
const { ConnectionHandler } = require('./adapter/connection-handler');
const { EncapsulationCommands, CipGeneralStatus, CipCommonServices, CipClassCodes, EIP_ENCAPSULATION_PORT, EIP_IO_UDP_PORT } = require('./constants');

function firstNonInternalIPv4() {
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (!entry.internal && entry.family === 'IPv4') return entry.address;
        }
    }
    return '127.0.0.1';
}

class EIPAdapter {
    constructor({ port = EIP_ENCAPSULATION_PORT, ioPort = EIP_IO_UDP_PORT, address, identity } = {}) {
        this.port = port;
        this.ioPort = ioPort;
        this.address = address || firstNonInternalIPv4();
        this.identity = new IdentityObject(identity);
        this.assembly = new AssemblyObject();

        this.objects = new Map();
        this.objects.set(CipClassCodes.Identity, this.identity);
        this.objects.set(CipClassCodes.Assembly, this.assembly);

        this.connectionHandler = new ConnectionHandler({
            assemblyObject: this.assembly,
            sendDatagram: (buf, remoteAddress) => this._udpIo && this._udpIo.send(buf, this.ioPort, remoteAddress)
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
            this._udpIo.on('message', (msg) => this.connectionHandler.handleIncomingDatagram(msg));
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
        if (!decoded || decoded.header.command !== EncapsulationCommands.ListIdentity) return;
        const cpf = encodeCpf([{ typeId: CpfItemType.ListIdentityResponse, data: this._buildIdentityItemBuffer() }]);
        const response = encodeMessage({ command: EncapsulationCommands.ListIdentity, senderContext: decoded.header.senderContext }, cpf);
        this._udpListen.send(response, rinfo.port, rinfo.address);
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
            default:
                // ListServices/ListInterfaces/SendUnitData not yet implemented — silently ignored.
                return {};
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

        const handler = this.objects.get(path.classId);
        if (!handler) {
            return buildResponse({ service: request.service, generalStatus: CipGeneralStatus.PathDestinationUnknown });
        }

        let result;
        if (request.service === CipCommonServices.GetAttributeSingle) {
            result = handler.getAttributeSingle(path.instance, path.attribute);
        } else if (request.service === CipCommonServices.SetAttributeSingle) {
            result = handler.setAttributeSingle(path.instance, path.attribute, request.data);
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
        if (request.service === ConnectionManagerServices.ForwardOpen) {
            const parsed = parseForwardOpenRequest(request.data);
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
}

module.exports = { EIPAdapter };
