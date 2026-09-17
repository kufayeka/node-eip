'use strict';

/**
 * Device-type profile: DVP-ES3/EX3 Series. Registered under its own name
 * for clarity, but it's the exact same strategy and implementation as
 * 'sx3' — Delta's own product table (docs/DELTA_IA-PLC_EtherNet-IP_OP_EN_20251021.pdf
 * Ch.9) groups DVP-SV3/SX3 and DVP-ES3/EX3 under one "DVP-SV3/SX3 Series"
 * family row, both Adapter- and Scanner-capable. ES3's own EDS file
 * (eds/DELTA_IA-PLC_DVPES3-V01-08_EIP_EP_20240401/) was independently
 * confirmed structurally identical to the SX3's (same Assembly sizes,
 * same 17 Connections/paths) — strong evidence they share the same CIP
 * object model.
 *
 * ⚠️ Unconfirmed against real hardware — no physical ES3/EX3 has been
 * tested against this driver. See sx3.js's own header for what IS
 * empirically confirmed (a real DVP-SX3, product code 3846). Treat this
 * profile as "expected to work, not yet confirmed" until checked live.
 */

const sx3 = require('./sx3');

module.exports = {
    ...sx3,
    deviceType: 'es3',
    description: 'DVP-ES3/EX3 (same manual family + identical EDS structure as sx3, unconfirmed on real hardware) — vendor Register Objects, Class 0x350-0x359'
};
