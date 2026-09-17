'use strict';

/**
 * Device-type profile: DVP-ES2-E Series (specifically confirmed against a
 * real DVP32ES2-E). Per Delta's product table (docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf
 * Ch.9), this family is Adapter-capable but NOT Scanner-capable — that's
 * why ISPSoft has no "EIP Builder" I/O-mapping tool for it (that tool
 * configures the Scanner role, which this family doesn't have); it does
 * NOT mean the device can't be read from as an Adapter, which is exactly
 * the role this driver uses it in.
 *
 * ⚠️ Only DVP32ES2-E (product code 771) is empirically confirmed. DVP26SE
 * and DVP12SE share this table row in the manual but have not been tested
 * — their D-table size/instance mapping could differ; re-confirm with the
 * known-pattern technique (README Domain J) before trusting this profile
 * against them.
 *
 * Strategy: this device does NOT implement the vendor-specific Register
 * Objects (Class 0x350-0x359 all return PathDestinationUnknown) — no
 * per-product Assembly documentation exists for the small-PLC family
 * either (Ch.8.5 only documents AH-series/AHRTU). The mapping here was
 * found empirically: writing a known pattern into the PLC's own D-table
 * (via ISPSoft/WPLSoft) and searching every Assembly instance's Data
 * attribute for a byte match found Instance 101 offset 0 = D0 onward,
 * 2 bytes/register, READ-ONLY (Set_Attribute_Single on it returns
 * ServiceNotSupported — it's the device-produced direction). Everything
 * else below is not yet mapped; see the "open item" note in README Domain J
 * about Instance 100's unconfirmed write target.
 */

const { readD } = require('../es2-fallback-profile');

function unsupported(name) {
    // Async so callers get a rejected Promise consistently (matching every
    // other method here), not a synchronous throw.
    return async () => {
        throw new Error(`${name}() is not supported for device type "es2" — no confirmed Assembly-window mapping yet for this register on a DVP32ES2-E. See README Domain J ("Fallback for devices without the Register Objects") to add one once confirmed.`);
    };
}

module.exports = {
    deviceType: 'es2',
    description: 'DVP-ES2-E (confirmed on DVP32ES2-E) / DVP26SE, DVP12SE (same manual family, unconfirmed) — no vendor Register Objects; D read-only via Assembly-window fallback',
    readD,
    readX: unsupported('readX'),
    readXBit: unsupported('readXBit'),
    readY: unsupported('readY'),
    writeY: unsupported('writeY'),
    readYBit: unsupported('readYBit'),
    writeYBit: unsupported('writeYBit'),
    writeD: unsupported('writeD'),
    readM: unsupported('readM'),
    writeM: unsupported('writeM'),
    readS: unsupported('readS'),
    writeS: unsupported('writeS'),
    readT: unsupported('readT'),
    writeT: unsupported('writeT'),
    readC: unsupported('readC'),
    writeC: unsupported('writeC'),
    readHC: unsupported('readHC'),
    writeHC: unsupported('writeHC'),
    readSM: unsupported('readSM'),
    readSR: unsupported('readSR')
};
