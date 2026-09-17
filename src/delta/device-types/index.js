'use strict';

/**
 * Registry of Delta device-type profiles. Explicit by design — a caller
 * states the device type up front (e.g. `new DeltaDevice(host, 'sx3')`)
 * rather than the driver guessing from Identity at connect time, because
 * CIP capability turned out not to be reliably inferable that way (see
 * README Domain J: a DVP32ES2-E answers generic CIP and even accepts
 * Set_Attribute_Single on some Assembly instances, so "does this request
 * succeed" alone can't safely distinguish device families).
 *
 * To add a new PLC type: create src/delta/device-types/<name>.js exporting
 * the same method shape as sx3.js/es2.js (readX/readY/writeY/readD/writeD/
 * readM/writeM/readS/writeS/readT/writeT/readC/writeC/readHC/writeHC/
 * readSM/readSR — methods with no confirmed mapping yet should throw a
 * clear "not supported for this device type" error rather than being
 * omitted, so callers get one consistent shape to code against), then
 * register() it below. docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf
 * Ch.9's product tables are the starting point for which real models a new
 * profile should claim to cover — but confirm empirically (README Domain J's
 * known-pattern technique) before trusting it against real hardware.
 */

const profiles = new Map();

function register(key, profile) {
    profiles.set(key, profile);
}

function get(key) {
    const profile = profiles.get(key);
    if (!profile) {
        throw new Error(`Unknown Delta device type "${key}". Registered types: ${[...profiles.keys()].join(', ') || '(none)'}. Define a new profile in src/delta/device-types/ and register it in index.js.`);
    }
    return profile;
}

function list() {
    return [...profiles.keys()];
}

register('sx3', require('./sx3'));
register('es3', require('./es3'));
register('es2', require('./es2'));

module.exports = { register, get, list };
