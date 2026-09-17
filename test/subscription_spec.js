'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { Subscription, normalizeTag } = require('../src/subscription');

describe('Real-Time Tag Subscription & Watcher Subsystem', function () {

    describe('normalizeTag', function () {
        it('parses basic Delta D registers', function () {
            const d0 = normalizeTag('D0');
            assert.strictEqual(d0.name, 'D0');
            assert.strictEqual(d0.register, 'D');
            assert.strictEqual(d0.index, 0);
            assert.strictEqual(d0.type, 'INT');
            assert.strictEqual(d0.offset, 0);

            const d10 = normalizeTag('D10');
            assert.strictEqual(d10.name, 'D10');
            assert.strictEqual(d10.offset, 20);
        });

        it('parses explicit data types for D registers', function () {
            const real = normalizeTag('D0:REAL');
            assert.strictEqual(real.name, 'D0:REAL');
            assert.strictEqual(real.type, 'REAL');
            assert.strictEqual(real.offset, 0);

            const dint = normalizeTag('D4:DINT');
            assert.strictEqual(dint.name, 'D4:DINT');
            assert.strictEqual(dint.type, 'DINT');
            assert.strictEqual(dint.offset, 8);

            const uint = normalizeTag('D1:UINT');
            assert.strictEqual(uint.type, 'UINT');
            assert.strictEqual(uint.offset, 2);
        });

        it('parses bit registers (Y, M, X)', function () {
            const y0 = normalizeTag('Y0');
            assert.strictEqual(y0.name, 'Y0');
            assert.strictEqual(y0.register, 'Y');
            assert.strictEqual(y0.type, 'BOOL');
            assert.strictEqual(y0.offset, 0);
            assert.strictEqual(y0.bit, 0);

            const y7 = normalizeTag('Y7');
            assert.strictEqual(y7.offset, 0);
            assert.strictEqual(y7.bit, 7);

            const m16 = normalizeTag('M16');
            assert.strictEqual(m16.offset, 2);
            assert.strictEqual(m16.bit, 0);
        });

        it('normalizes custom tag definition objects', function () {
            const tag = normalizeTag({
                name: 'CustomSensor',
                offset: 14,
                type: 'REAL',
                deadband: 0.25
            });
            assert.strictEqual(tag.name, 'CustomSensor');
            assert.strictEqual(tag.offset, 14);
            assert.strictEqual(tag.type, 'REAL');
            assert.strictEqual(tag.deadband, 0.25);
        });
    });

    describe('Polling Mode (TCP 44818)', function () {
        class MockDeltaDevice {
            constructor() {
                this.mockValues = {
                    D0: 100,
                    D1: 200,
                    Y0: false
                };
            }

            async batch(builderFn) {
                const ops = [];
                const builder = {
                    readD: (idx) => ops.push(`D${idx}`),
                    readYBit: (idx) => ops.push(`Y${idx}`),
                    readM: (idx) => ops.push(`M${idx}`)
                };
                builderFn(builder);
                return ops.map((op) => this.mockValues[op] !== undefined ? this.mockValues[op] : 0);
            }
        }

        it('subscribes and emits both change and cyclic events', async function () {
            const mock = new MockDeltaDevice();
            const sub = new Subscription(mock, {
                mode: 'polling',
                interval: 20,
                tags: ['D0', 'D1']
            });

            const changes = [];
            const specificD0Changes = [];
            const cyclicTicks = [];

            sub.on('change', (tag, newVal, oldVal) => {
                changes.push({ tag, newVal, oldVal });
            });

            sub.on('change:D0', (newVal, oldVal) => {
                specificD0Changes.push({ newVal, oldVal });
            });

            sub.on('cyclic', (values) => {
                cyclicTicks.push(values);
            });

            await sub.start();

            // Allow initial poll
            await new Promise((r) => setTimeout(r, 45));

            assert.strictEqual(sub.getValue('D0'), 100);
            assert.strictEqual(sub.getValue('D1'), 200);
            assert.deepStrictEqual(sub.getValues(), { D0: 100, D1: 200 });

            // Initial poll emitted changes
            assert.strictEqual(changes.length, 2);
            assert.strictEqual(specificD0Changes.length, 1);
            assert.strictEqual(specificD0Changes[0].newVal, 100);
            assert.strictEqual(specificD0Changes[0].oldVal, undefined);

            const cyclicCountBefore = cyclicTicks.length;
            assert(cyclicCountBefore >= 1);

            // Change D0 value on device
            mock.mockValues.D0 = 350;

            await new Promise((r) => setTimeout(r, 50));

            // D0 change should fire, but D1 did not change
            assert.strictEqual(sub.getValue('D0'), 350);
            assert.strictEqual(specificD0Changes.length, 2);
            assert.strictEqual(specificD0Changes[1].newVal, 350);
            assert.strictEqual(specificD0Changes[1].oldVal, 100);

            // Cyclic ticks continued
            assert(cyclicTicks.length > cyclicCountBefore);

            await sub.stop();
        });

        it('supports dynamic subscribe and unsubscribe', async function () {
            const mock = new MockDeltaDevice();
            const sub = new Subscription(mock, { mode: 'polling', interval: 25 });

            sub.subscribe(['D0', 'D1']);
            assert.deepStrictEqual(sub.getTags(), ['D0', 'D1']);

            sub.unsubscribe('D1');
            assert.deepStrictEqual(sub.getTags(), ['D0']);
            assert.strictEqual(sub.hasTag('D0'), true);
            assert.strictEqual(sub.hasTag('D1'), false);
        });
    });

    describe('Real-Time Mode (UDP 2222 Class 1 I/O Filtering)', function () {
        class MockIoConnection extends EventEmitter {
            constructor() {
                super();
                this.running = false;
            }
            async start() {
                this.running = true;
            }
            async stop() {
                this.running = false;
            }
        }

        it('decodes and filters incoming Assembly 101 buffer per register', async function () {
            const mockIo = new MockIoConnection();
            const dummyTarget = { scanner: {} };

            const sub = new Subscription(dummyTarget, {
                mode: 'udp',
                ioConnection: mockIo,
                tags: ['D0', 'D1', 'D2:REAL', 'Y0']
            });

            const changes = [];
            const d2FloatChanges = [];
            const cyclicFrames = [];

            sub.on('change', (tag, newVal, oldVal) => {
                changes.push({ tag, newVal, oldVal });
            });

            sub.on('change:D2:REAL', (newVal, oldVal) => {
                d2FloatChanges.push({ newVal, oldVal });
            });

            sub.on('cyclic', (values) => {
                cyclicFrames.push(values);
            });

            await sub.start();

            // Simulate incoming 200-byte Assembly 101 buffer:
            // Byte 0..1: 16-bit CIP Transport Sequence Count
            // D0 (offset 0): byte 2 INT 1234
            // D1 (offset 2): byte 4 INT -500
            // D2:REAL (offset 4): byte 6 Float 3.1415
            // Y0 (offset 0, bit 0): byte 2 bit 0
            const buf1 = Buffer.alloc(200);
            buf1.writeUInt16LE(1, 0); // sequence count
            buf1.writeInt16LE(1234, 2);
            buf1.writeInt16LE(-500, 4);
            buf1.writeFloatLE(3.1415, 6);

            mockIo.emit('data', buf1);

            assert.strictEqual(sub.getValue('D0'), 1234);
            assert.strictEqual(sub.getValue('D1'), -500);
            assert(Math.abs(sub.getValue('D2:REAL') - 3.1415) < 0.0001);
            assert.strictEqual(sub.getValue('Y0'), false);

            assert.strictEqual(changes.length, 4);
            assert.strictEqual(d2FloatChanges.length, 1);
            assert.strictEqual(cyclicFrames.length, 1);

            // Send packet with incremented seq count but identical data — cyclic must fire, change must NOT fire
            const buf1_tick2 = Buffer.from(buf1);
            buf1_tick2.writeUInt16LE(2, 0); // sequence count advance
            mockIo.emit('data', buf1_tick2);
            assert.strictEqual(changes.length, 4, 'Change events must not fire when values are identical');
            assert.strictEqual(cyclicFrames.length, 2, 'Cyclic events must fire on every incoming UDP datagram');

            // Send packet where D0 changes to 9999 and Y0 becomes true (set bit 0 of byte 2)
            const buf2 = Buffer.from(buf1);
            buf2.writeUInt16LE(3, 0);
            buf2.writeInt16LE(9999, 2);
            buf2[2] |= 0x01; // set bit 0 for Y0

            mockIo.emit('data', buf2);

            assert.strictEqual(sub.getValue('D0'), 9999);
            assert.strictEqual(sub.getValue('Y0'), true);
            assert.strictEqual(cyclicFrames.length, 3);

            // Expect 2 new change events: D0 and Y0
            assert.strictEqual(changes.length, 6);
            assert.strictEqual(changes[4].tag, 'D0');
            assert.strictEqual(changes[4].newVal, 9999);
            assert.strictEqual(changes[4].oldVal, 1234);

            assert.strictEqual(changes[5].tag, 'Y0');
            assert.strictEqual(changes[5].newVal, true);
            assert.strictEqual(changes[5].oldVal, false);

            await sub.stop();
        });

        it('respects deadband threshold for analog/REAL values', async function () {
            const mockIo = new MockIoConnection();
            const sub = new Subscription({ scanner: {} }, {
                mode: 'udp',
                dataOffset: 0,
                ioConnection: mockIo,
                tags: [{ name: 'Sensor', offset: 0, type: 'REAL', deadband: 0.5 }]
            });

            const changes = [];
            sub.on('change', (tag, newVal) => changes.push(newVal));

            await sub.start();

            const buf = Buffer.alloc(10);
            buf.writeFloatLE(10.0, 0);
            mockIo.emit('data', buf);
            assert.strictEqual(changes.length, 1);
            assert.strictEqual(changes[0], 10.0);

            // Small fluctuation <= 0.5 deadband
            buf.writeFloatLE(10.3, 0);
            mockIo.emit('data', buf);
            assert.strictEqual(changes.length, 1, 'Fluctuation within deadband must be ignored');

            // Significant change > 0.5 deadband
            buf.writeFloatLE(11.2, 0);
            mockIo.emit('data', buf);
            assert.strictEqual(changes.length, 2);
            assert(Math.abs(changes[1] - 11.2) < 0.001);

            await sub.stop();
        });
    });
});
