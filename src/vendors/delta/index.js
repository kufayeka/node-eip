'use strict';

/**
 * Delta Electronics Vendor Package
 */

const { registerProfile } = require('../../device/registry');
const { es2Profile } = require('./profiles/es2');
const { sx3Profile } = require('./profiles/sx3');
const { dvp12seProfile } = require('./profiles/dvp12se');

// Auto-register Delta profiles
registerProfile(es2Profile);
registerProfile(sx3Profile);
registerProfile(dvp12seProfile);

module.exports = {
    es2: es2Profile,
    sx3: sx3Profile,
    dvp12se: dvp12seProfile,
    profiles: [es2Profile, sx3Profile, dvp12seProfile]
};
