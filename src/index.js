'use strict';

const constants = require('./constants');
const header = require('./encapsulation/header');
const cpf = require('./encapsulation/cpf');
const identity = require('./encapsulation/identity');
const session = require('./encapsulation/session');
const discovery = require('./encapsulation/discovery');
const rrdata = require('./encapsulation/rrdata');
const path = require('./cip/path');
const messageRouter = require('./cip/message-router');
const connectionManager = require('./cip/connection-manager');
const ioConnection = require('./cip/io-connection');
const identityObject = require('./cip/objects/identity');
const assemblyObject = require('./cip/objects/assembly');
const { EIPSession } = require('./client');
const { Scanner } = require('./scanner');
const { EIPAdapter } = require('./adapter');
const { IOConnection, SequenceTracker } = require('./cip/io-connection');
const eds = require('./cip/eds');
const { EdsFile } = eds;
const fragmentation = require('./cip/fragmentation');
const { FragmentReader, FragmentWriter, readLargeData, writeLargeData } = fragmentation;
const { Subscription, normalizeTag } = require('./subscription');

const {
    Device,
    DeviceProfile,
    BatchBuilder,
    registerProfile,
    getProfile,
    listProfiles
} = require('./device');
const vendors = require('./vendors');

class DeltaDevice extends Device {
    constructor(host, deviceType = 'delta:sx3', options = {}) {
        const key = deviceType.startsWith('delta:') ? deviceType : `delta:${deviceType}`;
        super(host, key, options);
    }
}

module.exports = {
    constants,
    encapsulation: {
        ...header,
        ...cpf,
        ...identity,
        ...session,
        ...discovery,
        ...rrdata
    },
    cip: {
        ...path,
        ...messageRouter,
        ...connectionManager,
        ...ioConnection,
        eds,
        fragmentation,
        objects: {
            ...identityObject,
            ...assemblyObject
        }
    },
    EIPSession,
    Scanner,
    Device,
    DeltaDevice,
    DeviceProfile,
    BatchBuilder,
    registerProfile,
    getProfile,
    listProfiles,
    vendors,
    EIPAdapter,
    IOConnection,
    SequenceTracker,
    EdsFile,
    FragmentReader,
    FragmentWriter,
    readLargeData,
    writeLargeData,
    encodeSymbolicPath: path.encodeSymbolicPath,
    decodeSymbolicPath: path.decodeSymbolicPath,
    encodeAnsiSymbolSegment: path.encodeAnsiSymbolSegment,
    decodeAnsiSymbolSegment: path.decodeAnsiSymbolSegment,
    encodeTagConnectionPath: path.encodeTagConnectionPath,
    Subscription,
    normalizeTag
};

