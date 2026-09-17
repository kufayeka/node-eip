'use strict';

/**
 * 32-bit (DINT) access built from two adjacent 16-bit registers — Delta's
 * standard convention for treating a register pair as one 32-bit value
 * (e.g. ladder's 32-bit move/compare instructions operating on `Dn`/`Dn+1`):
 * the LOW word is the lower-numbered register, the HIGH word is the next
 * one up, matching the manual's own DINT byte-order example (`DINT =
 * 0x12345678` → bytes `78 56 34 12`, i.e. little-endian at the byte level,
 * which is exactly what low-word-first/high-word-second gives you at the
 * word level too).
 *
 * This is a register-pairing *convention*, not a separate CIP object — it
 * works by combining two ordinary 16-bit reads/writes, so it rides on
 * whatever `readD`/`writeD` (or any other 16-bit accessor) already does
 * for the active device-type profile. On a profile where the underlying
 * 16-bit write isn't available (e.g. `'es2'`'s `writeD`), the 32-bit
 * version fails the same way, for the same reason — there's no separate
 * "32-bit register object" to fall back on.
 *
 * NOT the same thing as Delta's HC (High-speed Counter, Class 0x357) —
 * that's a genuinely separate CIP object for 32-bit counters, already
 * covered by readHC/writeHC in registers.js. Word-pairing here is only
 * for types that don't have their own dedicated 32-bit CIP object (D, and
 * potentially T if a given timer was declared 32-bit in the ladder
 * program — unconfirmed, see README Domain J).
 */

/** Combines two signed 16-bit words (as returned by a 16-bit read) into one signed 32-bit value. */
function combineWords(low, high) {
    const lowU = low & 0xffff;
    const highU = high & 0xffff;
    return ((highU << 16) | lowU) | 0; // forces a signed 32-bit result
}

/** Splits a signed 32-bit value into { low, high } signed 16-bit words, ready for two 16-bit writes. */
function splitDword(value) {
    const v = value >>> 0; // reinterpret as unsigned 32-bit for the bit split
    const toSigned16 = (word) => (word > 0x7fff ? word - 0x10000 : word);
    return {
        low: toSigned16(v & 0xffff),
        high: toSigned16((v >>> 16) & 0xffff)
    };
}

/** Reads a 32-bit value from two adjacent registers via any `read(n)`-shaped 16-bit accessor (session already bound). */
async function readDword(read16, n) {
    const low = await read16(n);
    const high = await read16(n + 1);
    return combineWords(low, high);
}

/** Writes a 32-bit value across two adjacent registers via any `write(n, value)`-shaped 16-bit accessor (session already bound). */
async function writeDword(write16, n, value) {
    const { low, high } = splitDword(value);
    await write16(n, low);
    await write16(n + 1, high);
}

module.exports = { combineWords, splitDword, readDword, writeDword };
