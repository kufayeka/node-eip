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
const deltaRegisters = require('./delta/registers');
const deltaAssemblyWindow = require('./delta/assembly-window');
const deltaDeviceTypes = require('./delta/device-types');
const deltaEdsInspect = require('./delta/eds-inspect');
const identityObject = require('./cip/objects/identity');
const assemblyObject = require('./cip/objects/assembly');
const { EIPSession } = require('./client');
const { Scanner } = require('./scanner');
const { DeltaDevice } = require('./delta/device');
const { EIPAdapter } = require('./adapter');
const { IOConnection, SequenceTracker } = require('./cip/io-connection');
const eds = require('./cip/eds');
const { EdsFile } = eds;

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
        objects: {
            ...identityObject,
            ...assemblyObject
        }
    },
    delta: {
        ...deltaRegisters,
        ...deltaAssemblyWindow,
        ...deltaEdsInspect,
        deviceTypes: deltaDeviceTypes
    },
    EIPSession,
    Scanner,
    DeltaDevice,
    EIPAdapter,
    IOConnection,
    SequenceTracker,
    EdsFile
};
