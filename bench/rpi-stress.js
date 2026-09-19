'use strict';

/**
 * RPI stress test — how low can Class 1 I/O RPI go on this pure-JS stack,
 * measured end-to-end over real UDP loopback (a real EIPAdapter producing,
 * a real Scanner/IOConnection consuming), before jitter or packet loss
 * becomes unacceptable?
 *
 * This exists to answer a concrete question with data instead of guessing:
 * does an RPI of 1-2ms actually require a native (Rust/napi-rs) rewrite of
 * the Class 1 I/O engine, or can Node.js/libuv sustain it on its own? See
 * docs/VIRTUAL_DEVICE_GUIDE.md §14 for the related reconnect/jitter
 * diagnosis this benchmark follows on from.
 *
 * Run: node bench/rpi-stress.js [--durationMs=5000] [--rpis=20,10,5,2,1] [--hires]
 *
 * --hires raises the Windows multimedia timer resolution to 1ms for the
 * duration of the run (see bench/lib/win-hires-timer.js) via koffi/winmm.dll
 * -- no native addon build needed. Compare a run with and without --hires at
 * low RPI (2, 1ms) to see how much of the jitter at that range is just
 * Windows' default ~15.6ms scheduler tick vs. this stack's own overhead.
 * No-op on non-Windows platforms.
 */

const { EIPAdapter } = require('../src/adapter');
const { Scanner } = require('../src/scanner');
const { encodeAssemblyConnectionPath } = require('../src/cip/path');
const hiresTimer = require('./lib/win-hires-timer');

const args = process.argv.slice(2);
function argVal(name, def) {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
}
const hasFlag = (name) => args.includes(`--${name}`);
const DURATION_MS = Number(argVal('durationMs', 5000));
const RPIS = argVal('rpis', '20,10,5,2,1').split(',').map(Number);
const USE_HIRES = hasFlag('hires');

function computeStats(deltasMs) {
    const n = deltasMs.length;
    const avg = deltasMs.reduce((a, b) => a + b, 0) / n;
    const variance = deltasMs.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    const sorted = [...deltasMs].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
        n,
        avg,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        stdev,
        p50: pct(50),
        p90: pct(90),
        p95: pct(95),
        p99: pct(99)
    };
}

async function runOneRpi(rpiMs) {
    const tcpPort = 44818 + Math.floor(Math.random() * 5000) + 1;
    const ioPort = 22220 + Math.floor(Math.random() * 5000) + 1;

    const adapter = new EIPAdapter({
        port: tcpPort,
        ioPort,
        address: '127.0.0.1',
        identity: { productName: 'Bench-RPI-Adapter' },
        quiet: true
    });
    adapter.assembly.set(0x64, Buffer.alloc(4));
    adapter.assembly.set(0x65, Buffer.from([0x01, 0x02, 0x03, 0x04]));
    await adapter.start();

    const scanner = new Scanner('127.0.0.1', { port: tcpPort });
    await scanner.connect();

    const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: 0x64, t2oInstance: 0x65 });
    const conn = await scanner.openConnection({
        connectionPath,
        rpiUs: Math.round(rpiMs * 1000),
        otSize: 4,
        toSize: 4
    });

    const io = scanner.createIoConnection(conn, {
        port: ioPort,
        localPort: 0,
        rpiMs,
        initialOutputData: Buffer.alloc(4)
    });

    const hrTimestamps = [];
    let lost = 0;
    let dup = 0;
    let ooo = 0;
    io.on('data', () => { hrTimestamps.push(process.hrtime.bigint()); });
    io.on('packetLost', (e) => { lost += e.lost || 1; });
    io.on('duplicate', () => { dup++; });
    io.on('outOfOrder', () => { ooo++; });

    await io.start();
    await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
    await io.stop();
    await scanner.closeConnection(conn);
    await scanner.disconnect();
    await adapter.stop();

    if (hrTimestamps.length < 3) {
        return { rpiMs, error: `too few packets received (${hrTimestamps.length})` };
    }
    const deltas = [];
    for (let i = 1; i < hrTimestamps.length; i++) {
        deltas.push(Number(hrTimestamps[i] - hrTimestamps[i - 1]) / 1e6);
    }
    return { rpiMs, received: hrTimestamps.length, lost, dup, ooo, ...computeStats(deltas) };
}

async function main() {
    let hiresStatus = { hires: false, ms: null };
    if (USE_HIRES) {
        hiresStatus = hiresTimer.raise(1);
        console.log(hiresStatus.hires
            ? `[hires] Windows timer resolution raised to ${hiresStatus.ms}ms\n`
            : `[hires] requested but unavailable -- running at default OS timer resolution\n`);
    }

    console.log(`RPI stress test -- duration ${DURATION_MS}ms per RPI, sweeping: ${RPIS.join(', ')} ms\n`);
    const results = [];
    for (const rpiMs of RPIS) {
        console.log(`--- Testing RPI = ${rpiMs}ms ---`);
        const r = await runOneRpi(rpiMs);
        results.push(r);
        if (r.error) {
            console.log(`  ERROR: ${r.error}`);
        } else {
            const expectedPackets = Math.floor(DURATION_MS / rpiMs);
            console.log(`  received=${r.received} (expected ~${expectedPackets}) lost=${r.lost} dup=${r.dup} outOfOrder=${r.ooo}`);
            console.log(`  interval: avg=${r.avg.toFixed(3)}ms min=${r.min.toFixed(3)}ms max=${r.max.toFixed(3)}ms stdev=${r.stdev.toFixed(3)}ms (${(r.stdev / rpiMs * 100).toFixed(1)}% of RPI)`);
            console.log(`  p50=${r.p50.toFixed(3)}ms p90=${r.p90.toFixed(3)}ms p95=${r.p95.toFixed(3)}ms p99=${r.p99.toFixed(3)}ms`);
        }
        console.log('');
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    console.log('=== Summary ===');
    console.log('RPI(ms) | received/expected | lost | avg(ms) | stdev(ms) | stdev%RPI | max(ms)');
    for (const r of results) {
        if (r.error) {
            console.log(`${String(r.rpiMs).padStart(7)} | ERROR: ${r.error}`);
            continue;
        }
        const expectedPackets = Math.floor(DURATION_MS / r.rpiMs);
        console.log(
            `${String(r.rpiMs).padStart(7)} | ${String(r.received).padStart(6)}/${String(expectedPackets).padEnd(6)} | ${String(r.lost).padStart(4)} | ` +
            `${r.avg.toFixed(3).padStart(7)} | ${r.stdev.toFixed(3).padStart(9)} | ${(r.stdev / r.rpiMs * 100).toFixed(1).padStart(8)}% | ${r.max.toFixed(3).padStart(7)}`
        );
    }
    if (hiresStatus.hires) hiresTimer.restore();
}

main().catch((err) => {
    hiresTimer.restore();
    console.error('Fatal error:', err);
    process.exit(1);
});
