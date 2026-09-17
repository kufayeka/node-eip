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
 * Confirmed via: the device owner wrote D0=10, D1=0, D2=20, D3=0, D4=30,
 * ... into the PLC's own D-table (through ISPSoft/WPLSoft, not this
 * driver), then a full Assembly sweep + byte-pattern search found an exact
 * match at Instance 101, offset 0 — i.e. Instance 101's Data attribute IS
 * a live, read-only mirror of D0 onward, 2 bytes per register.
 */

const { makeWordWindow } = require('./assembly-window');

// Instance 101 ("Input"/T->O direction) — read confirmed; write confirmed
// REJECTED (Set_Attribute_Single -> general status 0x08 ServiceNotSupported),
// consistent with this being data the device produces, not accepts.
const D_READ = makeWordWindow({ instance: 101, base: 0, writable: false });

// Instance 100 ("Output"/O->T direction) accepts Set_Attribute_Single
// (general status 0x00 Success) but a written marker pattern (1000..1019
// at word offsets 0..19) was NOT observed mirrored back into D0..D19 via
// the Instance 101 read window — so instance 100 is writable at the wire
// level, but what it's actually wired to in the PLC's own register table
// (if anything) is UNCONFIRMED. Needs the device owner to check their own
// D/Y register monitor for the 1000-1019 marker before this can be wired
// up as a write path.
const D_WRITE_TARGET_UNCONFIRMED = { instance: 100 };

module.exports = {
    D_READ,
    D_WRITE_TARGET_UNCONFIRMED,
    readD: (session, n) => D_READ.read(session, n)
};
