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
const { EIPSession } = require('./client');
const { Scanner } = require('./scanner');
const { DeltaDevice } = require('./delta/device');

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
        ...ioConnection
    },
    delta: {
        ...deltaRegisters,
        ...deltaAssemblyWindow,
        ...deltaEdsInspect,
        deviceTypes: deltaDeviceTypes
    },
    EIPSession,
    Scanner,
    DeltaDevice
};
