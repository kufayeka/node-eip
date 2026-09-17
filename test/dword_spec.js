'use strict';

const assert = require('assert');
const { combineWords, splitDword, readDword, writeDword } = require('../src/delta/dword');

describe('32-bit (DINT) register-pairing helpers', function () {
    it('combineWords() matches the manual\'s own DINT byte-order example (0x12345678)', function () {
        // low word = 0x5678, high word = 0x1234 -> combined = 0x12345678
        assert.strictEqual(combineWords(0x5678, 0x1234), 0x12345678);
    });

    it('splitDword() is the exact inverse of combineWords() for a positive value', function () {
        const { low, high } = splitDword(0x12345678);
        assert.strictEqual(low, 0x5678);
        assert.strictEqual(high, 0x1234);
        assert.strictEqual(combineWords(low, high), 0x12345678);
    });

    it('round-trips a negative 32-bit value correctly', function () {
        const original = -123456789;
        const { low, high } = splitDword(original);
        assert.strictEqual(combineWords(low, high), original);
    });

    it('round-trips zero and -1', function () {
        const zero = splitDword(0);
        assert.strictEqual(combineWords(zero.low, zero.high), 0);
        const minusOne = splitDword(-1);
        assert.strictEqual(combineWords(minusOne.low, minusOne.high), -1);
    });

    it('readDword() reads Dn as the low word and Dn+1 as the high word', async function () {
        const values = { 100: 0x5678, 101: 0x1234 };
        const read16 = async (n) => values[n];
        assert.strictEqual(await readDword(read16, 100), 0x12345678);
    });

    it('writeDword() writes the low word to Dn and the high word to Dn+1, in that order', async function () {
        const writes = [];
        const write16 = async (n, value) => { writes.push({ n, value }); };
        await writeDword(write16, 100, 0x12345678);
        assert.deepStrictEqual(writes, [
            { n: 100, value: 0x5678 },
            { n: 101, value: 0x1234 }
        ]);
    });
});
