'use strict';

/**
 * Phase 2 smoke test: Forward_Open / Forward_Close (Connection Manager)
 * against a real device, using ground truth pulled straight from Delta
 * SX-3's own EDS file (eds/031F000E0F0600010001.eds), Connection1:
 *   Path: 20 04 24 80 2C 64 2C 65
 *     -> Class 0x04 (Assembly), Instance 0x80 (128, Config),
 *        ConnPoint 0x64 (100, O->T), ConnPoint 0x65 (101, T->O)
 *   RPI default: 20,000 us (20 ms); IO data size default: 200 bytes
 *
 * This only proves Forward_Open/Forward_Close framing is correct — it does
 * NOT yet consume the resulting cyclic I/O data stream (that's the next
 * piece: SendUnitData / raw UDP with a Sequenced Address Item).
 *
 * Usage: node examples/forward-open.js <host>
 */

const { EIPSession } = require('../src/client');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');

async function main() {
    const host = process.argv[2] || '192.168.68.250';

    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });

    const session = new EIPSession(host);
    await session.connect();
    console.log(`Session registered: handle=0x${session.sessionHandle.toString(16)}`);

    let connection;
    try {
        console.log('\nForward_Open — Delta SX-3 Connection1 (Class 0x04 Instance 0x80, ConnPoints 100/101)...');
        connection = await session.openConnection({
            connectionPath,
            rpiUs: 20000,
            otSize: 200,
            toSize: 200
        });
        console.log('OK:', JSON.stringify({
            otNetworkConnectionId: '0x' + connection.otNetworkConnectionId.toString(16),
            toNetworkConnectionId: '0x' + connection.toNetworkConnectionId.toString(16),
            otApiUs: connection.otApiUs,
            toApiUs: connection.toApiUs,
            connectionSerialNumber: '0x' + connection.connectionSerialNumber.toString(16)
        }, null, 2));
    } finally {
        if (connection) {
            console.log('\nForward_Close...');
            const closed = await session.closeConnection(connection);
            console.log('OK:', JSON.stringify({ connectionSerialNumber: '0x' + closed.connectionSerialNumber.toString(16) }));
        }
        await session.close();
        console.log('\nSession closed.');
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
