'use strict';

const { DeviceProfile } = require('./profile');
const { BatchBuilder } = require('./batch-builder');
const { Device } = require('./device');
const { registerProfile, getProfile, hasProfile, listProfiles } = require('./registry');

// Auto-register built-in vendor profiles
require('../vendors');

class DeltaDevice extends Device {
    constructor(host, deviceType = 'delta:sx3', options = {}) {
        const key = deviceType.startsWith('delta:') ? deviceType : `delta:${deviceType}`;
        super(host, key, options);
    }
}

module.exports = {
    DeviceProfile,
    BatchBuilder,
    Device,
    DeltaDevice,
    registerProfile,
    getProfile,
    hasProfile,
    listProfiles
};

