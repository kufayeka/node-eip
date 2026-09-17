'use strict';

/**
 * Device-type profile: DVP-SV3/SX3 Series (and, per Delta's own product
 * table in docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf Ch.9, the same
 * "DVP-SV3/SX3 Series" row also covers DVP-ES3/EX3 — grouped as one family
 * in the manual, both listed as both Adapter- and Scanner-capable).
 *
 * ⚠️ Only the specific device actually tested (a DVP-SX3, product code
 * 3846) is empirically confirmed — every method here is validated live
 * against it (README Domain J). DVP-ES3/EX3/SV3 share the manual entry but
 * have NOT been individually tested; treat as "expected to work, not yet
 * confirmed" until checked against real hardware of those exact models.
 *
 * Strategy: this family implements Delta's documented vendor-specific
 * Register Objects (Class 0x350-0x359) directly — every method here is a
 * thin passthrough to ../registers.js.
 */

const registers = require('../registers');

module.exports = {
    deviceType: 'sx3',
    description: 'DVP-SV3/SX3 (confirmed) / DVP-ES3/EX3 (same manual family, unconfirmed) — vendor Register Objects, Class 0x350-0x359',
    readX: registers.readX,
    readXBit: registers.readXBit,
    readXBitLabel: registers.readXBitLabel,
    readY: registers.readY,
    writeY: registers.writeY,
    readYBit: registers.readYBit,
    writeYBit: registers.writeYBit,
    readYBitLabel: registers.readYBitLabel,
    writeYBitLabel: registers.writeYBitLabel,
    readD: registers.readD,
    writeD: registers.writeD,
    readM: registers.readM,
    writeM: registers.writeM,
    readS: registers.readS,
    writeS: registers.writeS,
    readT: registers.readT,
    writeT: registers.writeT,
    readTBit: (session, n) => registers.readBit(session, registers.RegisterClass.T, n),
    writeTBit: (session, n, value) => registers.writeBit(session, registers.RegisterClass.T, n, value),
    readC: registers.readC,
    writeC: registers.writeC,
    readCBit: (session, n) => registers.readBit(session, registers.RegisterClass.C, n),
    writeCBit: (session, n, value) => registers.writeBit(session, registers.RegisterClass.C, n, value),
    readHC: registers.readHC,
    writeHC: registers.writeHC,
    // 32-bit counter access is a separate CIP class (HC) on this device
    // family, unlike 'es2' where it lives inside C's own Instance 2 at
    // high attribute numbers — see device-types/es2.js.
    readC32: registers.readHC,
    writeC32: registers.writeHC,
    readSM: registers.readSM,
    readSR: registers.readSR
};
