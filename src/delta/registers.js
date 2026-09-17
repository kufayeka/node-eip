'use strict';

/**
 * Delta AH/AS-series Vendor-Specific Register Objects — Delta's own
 * "EtherNet/IP Operation Manual" (DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf,
 * docs/), Chapter 8.12. This is a Delta-specific ADDITIVE layer on top of
 * the vendor-neutral core (reuses the exact same encodeEPath/buildRequest/
 * parseResponse already validated live against generic CIP objects) — not
 * part of the ODVA CIP spec itself, analogous to how src/logix/ will hold
 * Rockwell-specific extensions. Confirmed applicable to the SX3 (AS300 CPU)
 * per the device owner: AS300 and AH-series share the same EIP scanner/
 * adapter implementation.
 *
 * The addressing convention is the same for every register type: the CIP
 * Attribute ID *is* the register number directly — D100 is Class 0x352,
 * Instance 2 (word), Attribute 100. No symbolic/tag lookup, no assembly
 * byte-offset guessing required — this is closer to Modbus's register-number
 * addressing than typical CIP explicit messaging.
 *
 * Bit-mode instances (Instance 1) enumerate every bit of every word
 * sequentially: attribute = wordIndex * 16 + bitIndex (e.g. D0.0 = attribute
 * 0, D0.1 = attribute 1, D1.0 = attribute 16). This formula is this driver's
 * interpretation of the manual's "D0.0=16#00, D0.1=16#01, ... D4096.15"
 * enumeration pattern — validate against a real device before relying on it
 * for anything other than the low word indices the manual explicitly lists.
 */

const { encodeEPath } = require('../cip/path');
const { buildRequest } = require('../cip/message-router');
const { CipCommonServices, CipGeneralStatus } = require('../constants');

const RegisterClass = Object.freeze({
    X: 0x350,  // physical inputs — READ-ONLY
    Y: 0x351,  // physical outputs — read/write
    D: 0x352,  // data registers — read/write
    M: 0x353,  // markers/coils, bit-only — read/write
    S: 0x354,  // steps, bit-only — read/write
    T: 0x355,  // timers (contact + current value) — read/write
    C: 0x356,  // counters (contact + current value) — read/write
    HC: 0x357, // high-speed counters (contact + 32-bit current value) — read/write
    SM: 0x358, // system markers, bit-only — READ-ONLY
    SR: 0x359  // system registers, word-only — READ-ONLY
});

const RegisterInstance = Object.freeze({ Bit: 1, Word: 2 });

// Word-mode data width per register type, per the manual's Data Type table
// (8.2) and each register's own Instance=2 attribute table. HC is the one
// exception at 32 bits (DINT); everything else word-mode is 16 bits (INT).
const WordByteWidth = Object.freeze({
    [RegisterClass.X]: 2,
    [RegisterClass.Y]: 2,
    [RegisterClass.D]: 2,
    [RegisterClass.T]: 2,
    [RegisterClass.C]: 2,
    [RegisterClass.HC]: 4,
    [RegisterClass.SR]: 2
});

const ReadOnlyClasses = new Set([RegisterClass.X, RegisterClass.SM, RegisterClass.SR]);
const BitOnlyClasses = new Set([RegisterClass.M, RegisterClass.S, RegisterClass.SM]);
const WordOnlyClasses = new Set([RegisterClass.SR]);

/**
 * The word-mode Instance number is 2 for every dual-mode register type
 * (bit AND word both available, e.g. D/X/Y/T/C/HC), but for a word-ONLY
 * type like SR — which has no bit mode to share the numbering with — the
 * manual documents its single instance as Instance 1, not 2.
 */
function wordInstance(classId) {
    return WordOnlyClasses.has(classId) ? RegisterInstance.Bit : RegisterInstance.Word;
}

function bitAttribute(wordIndex, bitIndex) {
    if (bitIndex < 0 || bitIndex > 15) {
        throw new RangeError(`bitAttribute: bitIndex must be 0-15, got ${bitIndex}`);
    }
    return wordIndex * 16 + bitIndex;
}

function registerPath(classId, instance, attribute) {
    return encodeEPath({ classId, instance, attribute });
}

function assertGetSuccess(response, label) {
    if (response.generalStatus !== CipGeneralStatus.Success) {
        throw new Error(`${label}: general status 0x${response.generalStatus.toString(16)}, additional status: ${response.additionalStatus.map((w) => '0x' + w.toString(16)).join(', ')}`);
    }
}

/** Reads one word-mode register (e.g. D100, HC0) as a signed integer. */
async function readWord(session, classId, registerNumber) {
    if (WordByteWidth[classId] === undefined) {
        throw new Error(`readWord: register class 0x${classId.toString(16)} has no word-mode instance`);
    }
    const path = registerPath(classId, wordInstance(classId), registerNumber);
    const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });
    const response = await session.sendUnconnected(request);
    assertGetSuccess(response, `readWord(0x${classId.toString(16)}, ${registerNumber})`);

    return WordByteWidth[classId] === 4 ? response.data.readInt32LE(0) : response.data.readInt16LE(0);
}

/** Writes one word-mode register. Throws if the register type is read-only. */
async function writeWord(session, classId, registerNumber, value) {
    if (ReadOnlyClasses.has(classId)) {
        throw new Error(`writeWord: register class 0x${classId.toString(16)} is read-only`);
    }
    if (WordByteWidth[classId] === undefined) {
        throw new Error(`writeWord: register class 0x${classId.toString(16)} has no word-mode instance`);
    }
    const width = WordByteWidth[classId];
    const data = Buffer.alloc(width);
    if (width === 4) data.writeInt32LE(value, 0); else data.writeInt16LE(value, 0);

    const path = registerPath(classId, wordInstance(classId), registerNumber);
    const request = buildRequest({ service: CipCommonServices.SetAttributeSingle, path, data });
    const response = await session.sendUnconnected(request);
    assertGetSuccess(response, `writeWord(0x${classId.toString(16)}, ${registerNumber})`);
}

/** Reads one bit — either a bit-only type (M/S/SM) by its own number, or a bit within a word-capable type via {word, bit}. */
async function readBit(session, classId, registerNumberOrWord, bitIndex) {
    const attribute = BitOnlyClasses.has(classId) || bitIndex === undefined
        ? registerNumberOrWord
        : bitAttribute(registerNumberOrWord, bitIndex);
    if (WordOnlyClasses.has(classId)) {
        throw new Error(`readBit: register class 0x${classId.toString(16)} has no bit-mode instance`);
    }
    const path = registerPath(classId, RegisterInstance.Bit, attribute);
    const request = buildRequest({ service: CipCommonServices.GetAttributeSingle, path });
    const response = await session.sendUnconnected(request);
    assertGetSuccess(response, `readBit(0x${classId.toString(16)}, ${attribute})`);
    return response.data.readUInt8(0) !== 0;
}

/**
 * D's bit-mode instance is documented (and confirmed live against a real
 * DVP32ES2-E) as returning/expecting a 2-byte value even though it's a
 * single-bit read/write, unlike every other bit-mode register type here
 * (X/Y/M/S/T/C), which use a plain 1-byte BOOL. A 1-byte write to D's
 * bit-mode instance is rejected outright (general status 0x01) — this
 * isn't optional padding, the device requires the full 2 bytes.
 */
const TwoByteBitWriteClasses = new Set([RegisterClass.D]);

/** Writes one bit — see readBit() for addressing. Throws if the register type is read-only. */
async function writeBit(session, classId, registerNumberOrWord, bitIndexOrValue, maybeValue) {
    if (ReadOnlyClasses.has(classId)) {
        throw new Error(`writeBit: register class 0x${classId.toString(16)} is read-only`);
    }
    const hasBitIndex = maybeValue !== undefined;
    const attribute = BitOnlyClasses.has(classId) || !hasBitIndex
        ? registerNumberOrWord
        : bitAttribute(registerNumberOrWord, bitIndexOrValue);
    const value = hasBitIndex ? maybeValue : bitIndexOrValue;

    const path = registerPath(classId, RegisterInstance.Bit, attribute);
    const data = TwoByteBitWriteClasses.has(classId)
        ? Buffer.from([value ? 0x01 : 0x00, 0x00])
        : Buffer.from([value ? 0x01 : 0x00]);
    const request = buildRequest({ service: CipCommonServices.SetAttributeSingle, path, data });
    const response = await session.sendUnconnected(request);
    assertGetSuccess(response, `writeBit(0x${classId.toString(16)}, ${attribute})`);
}

/**
 * Composes a full-word write from 16 sequential single-bit writes — for
 * device families that implement only the bit-mode instance (Instance 1)
 * and reject the word-mode instance (Instance 2) outright (confirmed on a
 * real DVP32ES2-E: word-mode Set_Attribute_Single for D returns
 * PathDestinationUnknown, but 16 individual bit writes via Instance 1
 * work and are read back correctly through the word-level mirror). Slower
 * (16 round trips instead of 1) but works anywhere writeBit() does. Value
 * is treated as a 16-bit pattern (bit 15 written as bit 15 = 1, not
 * sign-extended).
 */
async function writeWordViaBits(session, classId, wordIndex, value) {
    for (let bit = 0; bit < 16; bit++) {
        await writeBit(session, classId, wordIndex, bit, (value >> bit) & 1);
    }
}

// Friendly per-type wrappers — the ergonomic, Modbus-register-like surface.
const readX = (session, n) => readWord(session, RegisterClass.X, n);
const readXBit = (session, n) => readBit(session, RegisterClass.X, n);
const readY = (session, n) => readWord(session, RegisterClass.Y, n);
const writeY = (session, n, value) => writeWord(session, RegisterClass.Y, n, value);
const readYBit = (session, n) => readBit(session, RegisterClass.Y, n);
const writeYBit = (session, n, value) => writeBit(session, RegisterClass.Y, n, value);
const readD = (session, n) => readWord(session, RegisterClass.D, n);
const writeD = (session, n, value) => writeWord(session, RegisterClass.D, n, value);
const readM = (session, n) => readBit(session, RegisterClass.M, n);
const writeM = (session, n, value) => writeBit(session, RegisterClass.M, n, value);
const readS = (session, n) => readBit(session, RegisterClass.S, n);
const writeS = (session, n, value) => writeBit(session, RegisterClass.S, n, value);
const readT = (session, n) => readWord(session, RegisterClass.T, n);
const writeT = (session, n, value) => writeWord(session, RegisterClass.T, n, value);
const readC = (session, n) => readWord(session, RegisterClass.C, n);
const writeC = (session, n, value) => writeWord(session, RegisterClass.C, n, value);
const readHC = (session, n) => readWord(session, RegisterClass.HC, n);
const writeHC = (session, n, value) => writeWord(session, RegisterClass.HC, n, value);
const readSM = (session, n) => readBit(session, RegisterClass.SM, n);
const readSR = (session, n) => readWord(session, RegisterClass.SR, n);

module.exports = {
    RegisterClass,
    RegisterInstance,
    bitAttribute,
    registerPath,
    wordInstance,
    readWord,
    writeWord,
    readBit,
    writeBit,
    writeWordViaBits,
    readX,
    readXBit,
    readY,
    writeY,
    readYBit,
    writeYBit,
    readD,
    writeD,
    readM,
    writeM,
    readS,
    writeS,
    readT,
    writeT,
    readC,
    writeC,
    readHC,
    writeHC,
    readSM,
    readSR
};
