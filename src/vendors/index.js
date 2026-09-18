'use strict';

/**
 * Universal Vendor Registry Hub
 * Auto-registers built-in vendors.
 */

const delta = require('./delta');
const rockwell = require('./rockwell');

module.exports = {
    delta,
    rockwell
};
