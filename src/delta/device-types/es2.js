'use strict';

/**
 * Device-type profile: DVP-ES2-E Series (specifically confirmed against a
 * real DVP32ES2-E). Per Delta's product table (docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf
 * Ch.9), this family is Adapter-capable but NOT Scanner-capable — that's
 * why ISPSoft has no "EIP Builder" I/O-mapping tool for it (that tool
 * configures the Scanner role, which this family doesn't have); it does
 * NOT mean the device can't be read from/written to as an Adapter, which
 * is exactly the role this driver uses it in.
 *
 * ⚠️ Only DVP32ES2-E (product code 771) is empirically confirmed. DVP26SE
 * and DVP12SE share this table row in the manual but have not been tested
 * — re-confirm with the known-pattern technique (README Domain J) before
 * trusting this profile against them.
 *
 * Strategy, fully reverse-engineered live (2026-09) against real hardware,
 * cross-validated by writing distinguishing patterns into the PLC's own
 * X/D/M/Y tables via WPLSoft/ISPSoft, then reading them back over CIP —
 * and separately, writing over CIP and confirming the physical device's
 * own live monitor showed the change:
 *
 * - This device DOES implement Delta's vendor-specific Register Objects
 *   (Class 0x350-0x356: X/Y/D/M/S/T/C) — the earlier conclusion that they
 *   didn't exist was wrong; it tested only the WORD-mode instance
 *   (Instance 2), which this device genuinely doesn't support. The
 *   BIT-mode instance (Instance 1) works for all of them.
 * - Classes 0x357-0x359 (HC/SM/SR) do not exist on this device at all
 *   (confirmed via a full 0x001-0x3FF class sweep).
 * - **Read** via bit-mode is real and live for X, Y, M, S, T, C — cross-
 *   validated exactly against values written through WPLSoft/ISPSoft.
 * - **Write** via bit-mode is real and live for Y, M, S, T, C — confirmed
 *   by writing through this driver and visually observing the change in
 *   WPLSoft/ISPSoft's own live monitor. X is correctly rejected (general
 *   status 0x0E AttributeNotSettable) — it's a physical input, read-only.
 * - **D is the one exception.** Its bit-mode instance is a real, working
 *   read/write store — but a completely SEPARATE one from the PLC's actual
 *   D-table: writes made through Class 0x352 never show up in the
 *   Assembly-window mirrors below (which ARE proven connected to the real
 *   D-table, via the same known-pattern technique), even with a delay or
 *   an active Forward_Open connection kept alive throughout. Exhaustively
 *   tried every O->T Assembly instance this device has (100, 102, 104,
 *   106, 108, 110, 112, 114 — one per Connection1-8), writing a unique
 *   marker to each and scanning all 8 T->O instances plus the D-mirror for
 *   it — none propagated anywhere. So: read D through the Assembly-window
 *   mirrors as normal, but there is currently NO confirmed way to write D
 *   on this device via CIP — see README Domain J for the full
 *   investigation trail (including the Connection2 configuration-assembly
 *   lead, still unresolved).
 * - D's bit-mode instance also has an undocumented quirk if you use it
 *   directly: it expects a 2-byte payload per bit (not the standard 1-byte
 *   BOOL every other type here uses) — registers.js's writeBit() already
 *   handles this.
 * - T and C here only expose their bit-mode "contact" (on/off) state, not
 *   a numeric current value — this device's word-mode instance (which is
 *   what carries the numeric elapsed-time/count on the 'sx3' profile)
 *   isn't supported at all.
 *
 * D read range (D0-D799, in 8 windows of 100): each Connection's T->O
 * Assembly instance (101, 103, 105, 107, 109, 111, 113, 115) mirrors a
 * separate, sequential 100-word D block — D0-99, D100-199, ..., D700-799
 * respectively. This mapping is specific to THIS ONE device's current
 * ISPSoft I/O configuration, not a general DVP-ES2-series convention —
 * re-confirm with the known-pattern technique before reusing it against
 * another ES2. D0-D99 and D100-D199 were confirmed via a written marker
 * each (`10` and `1111`); D200-D299/D300-D399/D600-D699/D700-D799 read
 * all-zero on this device (nothing distinguishing to match yet, but follow
 * the identical per-Connection pattern); D400-D499 and D500-D599 are
 * confirmed by virtue of already containing genuine non-zero live PLC data
 * consistent with the same pattern.
 */

const { makeWordWindow } = require('../assembly-window');
const { RegisterClass, readXBit, readXBitLabel, readYBit, writeYBit, readYBitLabel, writeYBitLabel, readM, writeM, readS, writeS, readBit, writeBit } = require('../registers');

const D_WINDOWS = [
    { instance: 101, base: 0 },
    { instance: 103, base: 100 },
    { instance: 105, base: 200 },
    { instance: 107, base: 300 },
    { instance: 109, base: 400 },
    { instance: 111, base: 500 },
    { instance: 113, base: 600 },
    { instance: 115, base: 700 }
];

const D_WINDOW_CACHE = new Map(
    D_WINDOWS.map((w) => [w.base, makeWordWindow({ instance: w.instance, base: w.base, writable: false })])
);

function windowFor(n) {
    const w = D_WINDOWS.find((w) => n >= w.base && n < w.base + 100);
    if (!w) {
        throw new RangeError(`readD: D${n} is outside the confirmed readable range for this device (D0-D799, in 8 windows of 100)`);
    }
    return D_WINDOW_CACHE.get(w.base);
}

async function readD(session, n) {
    return windowFor(n).read(session, n);
}

function unsupported(name, reason) {
    return async () => {
        throw new Error(`${name}() is not supported for device type "es2" — ${reason}`);
    };
}

module.exports = {
    deviceType: 'es2',
    description: 'DVP-ES2-E (confirmed on DVP32ES2-E) — vendor Register Objects, bit-mode only (Class 0x350-0x356); D read is Assembly-window (Instances 101-115, D0-D799), D write unresolved',

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
    D_WINDOWS,
    writeD: unsupported('writeD', 'no working write path found after exhausting every avenue tried: Class 0x352 bit-mode write, explicit Set_Attribute_Single on all 8 O->T Assembly instances (100/102/104/106/108/110/112/114), Assembly writes during an active Forward_Open connection, and a Forward_Open with a custom Connection2 configuration data segment — none propagate to the PLC\'s actual D-table. See README Domain J.'),

    readM,
    writeM,
    readS,
    writeS,

    readT: (session, n) => readBit(session, RegisterClass.T, n),
    writeT: (session, n, value) => writeBit(session, RegisterClass.T, n, value),
    readC: (session, n) => readBit(session, RegisterClass.C, n),
    writeC: (session, n, value) => writeBit(session, RegisterClass.C, n, value),

    readHC: unsupported('readHC', 'Class 0x357 does not exist on this device (confirmed via a full class-ID sweep)'),
    writeHC: unsupported('writeHC', 'Class 0x357 does not exist on this device (confirmed via a full class-ID sweep)'),
    readSM: unsupported('readSM', 'Class 0x358 does not exist on this device (confirmed via a full class-ID sweep)'),
    readSR: unsupported('readSR', 'Class 0x359 does not exist on this device (confirmed via a full class-ID sweep)')
};
