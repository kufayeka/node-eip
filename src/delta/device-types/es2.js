'use strict';

/**
 * Device-type profile: DVP-ES2-E Series (specifically confirmed against a
 * real DVP32ES2-E). Also covers DVP-SE/DVP-SE2/DVP26SE — Delta's own
 * manual (DVP-ES2/EX2/EC5/SS2/SA2/SX2/SE&TP Operation Manual - Programming,
 * Appendix B.5, "DVP-SE / ES2-E Series PLCs") groups them under one shared
 * object list (Class 0x350-0x356, 0xF5, 0xF6) — see
 * docs/delta-cip-object-reference.md for the full table transcribed from
 * that manual. DVP12SE is a separate, older device using entirely
 * different Class IDs (0x64-0x69) — not implemented here (no profile
 * registered for it yet — see that reference doc if one is ever needed).
 *
 * ⚠️ Only DVP32ES2-E (product code 771) is empirically confirmed for the
 * methods marked as such below. DVP-SE/DVP-SE2/DVP26SE share the same
 * manual object list but have not been individually tested.
 *
 * === 2026-09 correction: this device's real addressing scheme ===
 *
 * Everything below was re-derived from Appendix B.5.2's own Instance/
 * Attribute tables (not the AS/AH-series manual's Ch 8.12, which is what
 * this profile was originally, incorrectly modeled on). The two manuals
 * document DIFFERENT conventions for the SAME class IDs:
 *
 * - **X (0x350) / Y (0x351) / M (0x353) / S (0x354):** Instance 1, flat
 *   Attribute = point number directly (X0=attr 0, X377=attr 255, etc).
 *   This matches what this driver already did — no change needed.
 * - **D (0x352):** Instance 1 (not 2!), flat Attribute = D register number
 *   directly (D0=attr 0, D9999=attr 9999 on ES2-E; up to attr 11999 on
 *   DVP26SE), Data Type INT (16-bit), Access **Set** (writable!). This is
 *   the corrected understanding — the previous implementation treated
 *   Instance 1 as a *bit*-enumeration view (wordIndex*16+bitIndex, the
 *   AS/AH-series manual's OWN convention for D) and used a completely
 *   separate Assembly-window read mechanism for D, having concluded D
 *   write was an unsolved mystery. That bit-enumeration formula was simply
 *   the wrong addressing for this device family: attribute 1600 (from
 *   bitAttribute(100, 0)) is really **D1600** under this device's actual
 *   scheme, not "bit 0 of D100" — a real, valid, writable register, just
 *   not the one being targeted. It never showed up in the Assembly-window
 *   mirror (which only covers D0-D799) because D1600 is outside that
 *   range, not because it was an isolated scratch store. **NOT YET
 *   LIVE-TESTED against the real device as of this writing** (device was
 *   offline) — this is the corrected implementation, pending confirmation.
 * - **T (0x355) / C (0x356) numeric register value:** Instance 2 (this
 *   device's Instance 2 was, for a long time, assumed to not exist at all
 *   — that conclusion was based on limited early testing, not this
 *   manual). Attribute = T/C number directly, Data Type INT — except C's
 *   Attribute 200-255, which the manual documents as DINT (32-bit): the
 *   32-bit counter range lives at high attribute numbers *within this same
 *   Instance 2*, not a separate HC class (HC/0x357 is confirmed absent via
 *   a full class sweep). **NOT YET LIVE-TESTED.**
 * - **Classes 0x357-0x359 (HC/SM/SR) do not exist on this device at all**
 *   (confirmed via a full 0x001-0x3FF class sweep) — unrelated to the
 *   above, still correct.
 *
 * Renamed for clarity now that T/C have two genuinely different meanings:
 * `readT`/`writeT`/`readC`/`writeC` are now the NUMERIC current value
 * (Instance 2, matching what these names mean on the 'sx3' profile, for
 * consistency across profiles) — previously these names meant the
 * *contact* bit, which is now `readTBit`/`writeTBit`/`readCBit`/`writeCBit`.
 */

const { RegisterClass, readXBit, readXBitLabel, readYBit, writeYBit, readYBitLabel, writeYBitLabel, readM, writeM, readS, writeS, readBit, writeBit, readWordAtInstance, writeWordAtInstance } = require('../registers');

function unsupported(name, reason) {
    return async () => {
        throw new Error(`${name}() is not supported for device type "es2" — ${reason}`);
    };
}

// D Register (0x352): Instance 1, flat Attribute = D number. See the file
// header for why this replaces the old Assembly-window-based mechanism.
const readD = (session, n) => readWordAtInstance(session, RegisterClass.D, 1, n);
const writeD = (session, n, value) => writeWordAtInstance(session, RegisterClass.D, 1, n, value);

// T/C numeric register value: Instance 2, flat Attribute = T/C number.
// C's Attribute 200+ is DINT (32-bit) instead of INT (16-bit) — the
// 32-bit counter range, confirmed by the manual to live inside this same
// Instance/Attribute space rather than a separate HC class.
const readT = (session, n) => readWordAtInstance(session, RegisterClass.T, 2, n);
const writeT = (session, n, value) => writeWordAtInstance(session, RegisterClass.T, 2, n, value);
const readC = (session, n) => readWordAtInstance(session, RegisterClass.C, 2, n, n >= 200 ? 4 : 2);
const writeC = (session, n, value) => writeWordAtInstance(session, RegisterClass.C, 2, n, value, n >= 200 ? 4 : 2);

module.exports = {
    deviceType: 'es2',
    description: 'DVP-ES2-E (confirmed on DVP32ES2-E), also DVP-SE/DVP-SE2/DVP26SE (unconfirmed) — vendor Register Objects per manual Appendix B.5.2; D/T/C corrected 2026-09, pending live re-confirmation',

    readX: readXBit,
    readXBit,
    readXBitLabel,
    readY: readYBit,
    writeY: writeYBit,
    readYBit,
    writeYBit,
    readYBitLabel,
    writeYBitLabel,

    readD,
    writeD,

    readM,
    writeM,
    readS,
    writeS,

    readT,
    writeT,
    readTBit: (session, n) => readBit(session, RegisterClass.T, n),
    writeTBit: (session, n, value) => writeBit(session, RegisterClass.T, n, value),
    readC,
    writeC,
    readCBit: (session, n) => readBit(session, RegisterClass.C, n),
    writeCBit: (session, n, value) => writeBit(session, RegisterClass.C, n, value),
    // No separate HC class on this device — the 32-bit counter range is
    // just C's own Instance 2 at Attribute 200+ (DINT instead of INT),
    // which readC/writeC already select automatically. See the file header.
    readC32: readC,
    writeC32: writeC,

    readHC: unsupported('readHC', 'Class 0x357 does not exist on this device (confirmed via a full class-ID sweep)'),
    writeHC: unsupported('writeHC', 'Class 0x357 does not exist on this device (confirmed via a full class-ID sweep) — the 32-bit counter range lives inside the C Register\'s own Instance 2, Attribute 200+, see readC/writeC'),
    readSM: unsupported('readSM', 'Class 0x358 does not exist on this device (confirmed via a full class-ID sweep)'),
    readSR: unsupported('readSR', 'Class 0x359 does not exist on this device (confirmed via a full class-ID sweep)')
};
