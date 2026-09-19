'use strict';

/**
 * DeviceBuilder / EDS-export / symbolic-tag scale test — how does building a
 * virtual EIP device with a large number of symbolic tags actually behave as
 * tag count grows toward 100,000? This is a different axis from
 * bench/tag-scale.js's packed-Assembly Class 1 I/O throughput test: this one
 * is about the DECLARATIVE/CONSTRUCTION side (DeviceBuilder.addTag() in a
 * loop, EDS text generation, Adapter/tag-store construction) and a small
 * functional correctness sample over real explicit messaging (Class 3, TCP
 * 44818) -- not about pushing N tags through one live cyclic I/O connection
 * (impractical and unrealistic at this scale; see tag-scale.js's own doc
 * comment for why).
 *
 * Run: node bench/builder-scale.js [--tags=1000,10000,100000] [--sampleReads=20]
 */

const { DeviceBuilder } = require('../src/device/builder');
const { Scanner } = require('../src/scanner');

const args = process.argv.slice(2);
function argVal(name, def) {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
}
const TAG_COUNTS = argVal('tags', '1000,10000,100000').split(',').map(Number);
const SAMPLE_READS = Number(argVal('sampleReads', 20));

function fmtMs(ms) { return `${ms.toFixed(1)}ms`; }

async function runOneCount(n) {
    const builder = new DeviceBuilder({
        vendorId: 0x1337,
        vendorName: 'Kufayeka Automation',
        productCode: 51,
        productName: 'Bench-BuilderScale-Device',
        deviceType: 'Generic Device',
        description: `Builder-scale benchmark device, ${n} tags`
    });

    const addStart = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
        builder.addTag(`Tag${i}`, 'DINT', i);
    }
    const addMs = Number(process.hrtime.bigint() - addStart) / 1e6;

    const edsStart = process.hrtime.bigint();
    const eds = builder.generateEds();
    const edsMs = Number(process.hrtime.bigint() - edsStart) / 1e6;

    const tcpPort = 44818 + Math.floor(Math.random() * 5000) + 1;
    const adapterStart = process.hrtime.bigint();
    const adapter = builder.createAdapter({ port: tcpPort, address: '127.0.0.1', quiet: true });
    await adapter.start();
    const adapterMs = Number(process.hrtime.bigint() - adapterStart) / 1e6;

    // Functional correctness + explicit-message (Class 3, TCP) read latency sample -- reading all
    // N tags individually would take far too long to be a useful benchmark at N=100,000 (that's
    // exactly why real deployments use packed Class 1 I/O for bulk polling, per tag-scale.js), so
    // this times a small, evenly-spread sample and reports both per-tag latency and the
    // extrapolated full-sweep time so the tradeoff is visible without actually paying its cost.
    const scanner = new Scanner('127.0.0.1', { port: tcpPort });
    await scanner.connect();

    const sampleIndices = [];
    const step = Math.max(1, Math.floor(n / SAMPLE_READS));
    for (let i = 0; i < n && sampleIndices.length < SAMPLE_READS; i += step) sampleIndices.push(i);

    const readLatenciesMs = [];
    let mismatches = 0;
    for (const i of sampleIndices) {
        const readStart = process.hrtime.bigint();
        const result = await scanner.readTag(`Tag${i}`, { dataType: 'DINT' });
        readLatenciesMs.push(Number(process.hrtime.bigint() - readStart) / 1e6);
        if (result.value !== i) mismatches++;
    }

    await scanner.disconnect();
    await adapter.stop();

    const avgReadMs = readLatenciesMs.reduce((a, b) => a + b, 0) / readLatenciesMs.length;
    return {
        n,
        addMs,
        edsBytes: Buffer.byteLength(eds),
        edsMs,
        adapterMs,
        avgReadMs,
        mismatches,
        sampled: sampleIndices.length,
        extrapolatedFullSweepMs: avgReadMs * n
    };
}

async function main() {
    console.log(`Builder-scale stress test -- sweeping tag counts: ${TAG_COUNTS.join(', ')} (explicit-read sample size: ${SAMPLE_READS})\n`);
    const results = [];
    for (const n of TAG_COUNTS) {
        console.log(`--- Testing ${n.toLocaleString()} tags ---`);
        let r;
        try {
            r = await runOneCount(n);
        } catch (err) {
            console.log(`  ERROR: ${err.message}`);
            results.push({ n, error: err.message });
            continue;
        }
        results.push(r);
        console.log(`  addTag() loop: ${fmtMs(r.addMs)} (${(r.addMs / n * 1000).toFixed(2)}us/tag)`);
        console.log(`  generateEds(): ${fmtMs(r.edsMs)}, output ${(r.edsBytes / 1024 / 1024).toFixed(2)}MB`);
        console.log(`  createAdapter()+start(): ${fmtMs(r.adapterMs)}`);
        console.log(`  explicit read (Class 3/TCP) sample: avg=${r.avgReadMs.toFixed(2)}ms over ${r.sampled} tags, mismatches=${r.mismatches}`);
        console.log(`  extrapolated full ${n.toLocaleString()}-tag sequential sweep: ~${(r.extrapolatedFullSweepMs / 1000).toFixed(1)}s (sequential Class 3 reads; use Class 1 I/O / batching to go faster)`);
        console.log('');
        if (global.gc) global.gc();
    }

    console.log('=== Summary ===');
    console.log('tags       | addTag(ms) | EDS(MB) | EDS(ms) | adapter(ms) | avgRead(ms) | full-sweep(s)');
    for (const r of results) {
        if (r.error) {
            console.log(`${String(r.n).padStart(10)} | ERROR: ${r.error}`);
            continue;
        }
        console.log(
            `${r.n.toLocaleString().padStart(10)} | ${r.addMs.toFixed(1).padStart(10)} | ${(r.edsBytes / 1024 / 1024).toFixed(2).padStart(7)} | ` +
            `${r.edsMs.toFixed(1).padStart(7)} | ${r.adapterMs.toFixed(1).padStart(11)} | ${r.avgReadMs.toFixed(2).padStart(11)} | ${(r.extrapolatedFullSweepMs / 1000).toFixed(1).padStart(13)}`
        );
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
