'use strict';

/**
 * Confirmed assembly-window mapping for ONE specific real device: a
 * DVP32ES2-E at 192.168.68.111, as configured by its owner's current
 * ISPSoft project. This is NOT a general DVP-ES2-series convention —
 * different project I/O mapping configuration on another ES2 device would
 * produce different offsets, or none at all. Re-confirm with the
 * known-pattern technique (README Domain J) before reusing against any
 * other device.
 *
 * Confirmed via TWO rounds of the known-pattern technique:
 *
 * 1. The device owner wrote D0=10, D1=0, D2=20, D3=0, D4=30, ... into the
 *    PLC's own D-table via ISPSoft/WPLSoft (not this driver). A full
 *    Assembly sweep + byte-pattern search found an exact match at
 *    Instance 101, offset 0 — a live, read-only mirror of D0 onward.
 * 2. The device owner separately configured an EIP Builder exchange table
 *    on a real SX3 (acting as EtherNet/IP Scanner) writing its own D100
 *    into this ES2's D100. That write landed as expected (confirmed via
 *    WPLSoft), and searching every Assembly instance afterward for the
 *    written value (1111) found it at **Instance 103, offset 0** — proving
 *    Instance 101 only covers D0-D99 (200 bytes = 100 words), and D100+
 *    lives in *separate* windows on the other Connections' T->O
 *    instances. Checking all 8 following the same pattern (Instance 101,
 *    103, 105, 107, 109, 111, 113, 115 = Connections 1-8's T->O side, each
 *    covering 100 consecutive D words) found genuine, non-zero, live PLC
 *    data already present in the D400-D499 and D500-D599 windows —
 *    confirming those two additionally without needing a written pattern.
 *
 * Read-only: Set_Attribute_Single on Instance 101 (and, by the same
 * direction logic, presumably every other T->O instance) is rejected with
 * general status 0x08 ServiceNotSupported — consistent with these being
 * the device-produced direction. The matching O->T instances (100, 102,
 * 104, ...) DO accept Set_Attribute_Single at the wire level, and the
 * SX3-to-ES2 exchange DOES successfully write through *some* mechanism,
 * but no CIP-level path this driver has tried (explicit Set_Attribute_Single
 * on any O->T instance targeting any Connection, cyclic O->T data via
 * Forward_Open on Connection1 or Connection2, with or without a 32-bit
 * Run/Idle header, with or without a Connection Configuration Data
 * segment) reproduces it — see README Domain J's "D write" notes.
 */

const { makeWordWindow } = require('./assembly-window');

/**
 * Confirmed D-table windows: each Assembly instance covers 100 consecutive
 * D words (200 bytes), read-only, matching one Connection's T->O side.
 * D0-D99 and D100-D199 are individually confirmed via the known-pattern
 * technique; D200-D299/D300-D399/D600-D699/D700-D799 follow the same
 * proven per-connection pattern but haven't individually had a written
 * marker confirmed (they read all-zero, so there's nothing distinguishing
 * to have matched yet); D400-D499 and D500-D599 are confirmed by virtue of
 * containing genuine non-zero live PLC data lining up with the same
 * pattern, not a written test marker specifically.
 */
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

// Kept for direct access / tests; readD(session, n) below is the normal entry point.
const D_READ = D_WINDOW_CACHE.get(0);

// Instance 100 ("Output"/O->T direction) accepts Set_Attribute_Single
// (general status 0x00 Success) but no method tried makes a written value
// show up anywhere real — see the file header for everything attempted.
const D_WRITE_TARGET_UNCONFIRMED = { instance: 100 };

async function readD(session, n) {
    return windowFor(n).read(session, n);
}

module.exports = {
    D_READ,
    D_WINDOWS,
    D_WRITE_TARGET_UNCONFIRMED,
    readD
};
