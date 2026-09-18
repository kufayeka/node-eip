'use strict';

const { registerProfile } = require('../../device/registry');
const { logixProfile } = require('./profiles/logix');

registerProfile(logixProfile);

module.exports = {
    logix: logixProfile,
    profiles: [logixProfile]
};
