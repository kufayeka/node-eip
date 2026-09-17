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
const { EIPSession } = require('./client');

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
    EIPSession
};
