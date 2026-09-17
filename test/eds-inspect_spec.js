'use strict';

const assert = require('assert');
const path = require('path');
const { inspectEds } = require('../src/delta/eds-inspect');

const SX3_EDS_PATH = path.join(__dirname, '..', 'eds', '031F000E0F0600010001.eds');

describe('eds-inspect (profile-authoring assist tool)', function () {
    it('parses all 12 Assembly entries from the bundled SX3 EDS', function () {
        const { assemblies } = inspectEds(SX3_EDS_PATH);
        assert.strictEqual(assemblies.length, 12);
        assert.deepStrictEqual(assemblies[0], { assem: 1, name: 'Output(O->T) Data', size: 500 });
        assert.deepStrictEqual(assemblies[1], { assem: 2, name: 'Input(T->O) Data', size: 500 });
    });

    it('parses all 17 Connection entries, including the SYMBOL_ANSI tag connection', function () {
        const { connections } = inspectEds(SX3_EDS_PATH);
        assert.strictEqual(connections.length, 17);

        assert.deepStrictEqual(connections[0], { connection: 1, name: 'Connection1', path: '20 04 24 80 2C 64 2C 65' });
        assert.deepStrictEqual(connections[16], { connection: 17, name: 'Tag Connection', path: 'SYMBOL_ANSI' });

        // Listen-only variants (9-16) substitute 0xC7 (199, the NULL placeholder) for O->T.
        assert.strictEqual(connections[8].path, '20 04 24 80 2C C7 2C 65');
    });
});
