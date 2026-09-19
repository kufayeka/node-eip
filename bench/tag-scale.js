'use strict';

/**
 * Tag-count scale stress test — how many "tags" (packed 2-byte WORDs, the
 * realistic industrial pattern: D-registers packed into one or a few
 * Assembly instances, not one CIP connection per tag) can a single
 * EIPAdapter <-> Scanner Class 1 I/O session actually move, end to end over
 * real UDP loopback, at a given RPI?
 *
 * Why packed assemblies, not one connection per tag: a real Scanner (PLC)
 * polls tags this way — CIP Vol 1's own Large Forward Open connection size
 * caps out at 65535 bytes (32767 WORDs) per connection, so this driver
 * splits a tag count larger than that across the minimum number of parallel
 * Class 1 connections needed, mirroring how a real Data Exchange table
 * would be laid out across multiple Connection entries. One-symbolic-
 * connection-per-tag does not scale to 100,000 by design (100,000 UDP
 * sockets + timers) and isn't how a real deployment would do it either —
 * see bench/builder-scale.js for symbolic-tag/EDS construction scale
 * instead, which is the part of that path that actually matters at N=100k.
 *
 * Run: node bench/tag-scale.js [--tags=1000,10000,100000] [--rpiMs=10]
 *      [--durationMs=5000] [--hires] [--bytesPerTag=2]
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

const TAG_COUNTS = argVal('tags', '1000,10000,100000').split(',').map(Number);
const RPI_MS = Number(argVal('rpiMs', 10));
const DURATION_MS = Number(argVal('durationMs', 5000));
const BYTES_PER_TAG = Number(argVal('bytesPerTag', 2));
const USE_HIRES = hasFlag('hires');

// 65535 is the Large Forward Open ceiling, but T->O production adds its own mandatory 2-byte
// transport Sequence Count plus ~18 bytes of CPF/UDP framing on top of the Assembly data before
// it ever hits the wire (see connection-handler.js's maxToSize comment — this exact benchmark is
// what surfaced both boundary bugs: a UInt16LE overflow right at 65535, and an EMSGSIZE failure
// from IPv4's real 65507-byte max UDP payload short of that). Mirror connection-handler.js's own
// effective ceiling here so this benchmark's own connection planning doesn't hit the same walls.
const MAX_UDP_PAYLOAD_BYTES = 65507;
const CPF_TO_FRAMING_OVERHEAD = 2 + 12 + 4 + 2;
const LARGE_FORWARD_OPEN_MAX_BYTES = Math.min(65535 - 2, MAX_UDP_PAYLOAD_BYTES - CPF_TO_FRAMING_OVERHEAD);
const MAX_TAGS_PER_CONNECTION = Math.floor(LARGE_FORWARD_OPEN_MAX_BYTES / BYTES_PER_TAG);

function computeStats(deltasMs) {
    if (deltasMs.length === 0) return null;
    const n = deltasMs.length;
    const avg = deltasMs.reduce((a, b) => a + b, 0) / n;
    const variance = deltasMs.reduce((a, b) => a + (b - avg) ** 2, 0) / n;
    const stdev = Math.sqrt(variance);
    const sorted = [...deltasMs].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return { n, avg, min: sorted[0], max: sorted[sorted.length - 1], stdev, p50: pct(50), p95: pct(95), p99: pct(99) };
}

/** Splits `totalTags` across the minimum number of connections, each <= MAX_TAGS_PER_CONNECTION. */
function planConnections(totalTags) {
    const numConns = Math.max(1, Math.ceil(totalTags / MAX_TAGS_PER_CONNECTION));
    const plan = [];
    let remaining = totalTags;
    for (let i = 0; i < numConns; i++) {
        const tags = Math.min(MAX_TAGS_PER_CONNECTION, remaining);
        plan.push({ o2tInstance: 0x64 + i * 2, t2oInstance: 0x65 + i * 2, tags, bytes: tags * BYTES_PER_TAG });
        remaining -= tags;
    }
    return plan;
}

async function runOneTagCount(totalTags) {
    const plan = planConnections(totalTags);
    const tcpPort = 44818 + Math.floor(Math.random() * 5000) + 1;
    const ioPort = 22220 + Math.floor(Math.random() * 5000) + 1;

    const adapter = new EIPAdapter({
        port: tcpPort,
        ioPort,
        address: '127.0.0.1',
        identity: { productName: 'Bench-TagScale-Adapter' },
        quiet: true
    });

    const setupStart = process.hrtime.bigint();
    for (const conn of plan) {
        adapter.assembly.set(conn.o2tInstance, Buffer.alloc(conn.bytes));
        adapter.assembly.set(conn.t2oInstance, Buffer.alloc(conn.bytes));
    }
    await adapter.start();

    const scanner = new Scanner('127.0.0.1', { port: tcpPort });
    await scanner.connect();

    const ioConnections = [];
    for (const conn of plan) {
        const connectionPath = encodeAssemblyConnectionPath({ configInstance: 0x80, o2tInstance: conn.o2tInstance, t2oInstance: conn.t2oInstance });
        const opened = await scanner.openConnection({
            connectionPath,
            rpiUs: Math.round(RPI_MS * 1000),
            otSize: conn.bytes,
            toSize: conn.bytes
        });
        const io = scanner.createIoConnection(opened, {
            port: ioPort,
            localPort: 0,
            rpiMs: RPI_MS,
            initialOutputData: Buffer.alloc(conn.bytes)
        });
        io._benchTags = conn.tags;
        io._benchBytes = conn.bytes;
        io._hrTimestamps = [];
        io.on('data', () => io._hrTimestamps.push(process.hrtime.bigint()));
        ioConnections.push({ conn, opened, io });
    }
    const setupMs = Number(process.hrtime.bigint() - setupStart) / 1e6;

    await Promise.all(ioConnections.map(({ io }) => io.start()));
    await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

    const memAfter = process.memoryUsage();

    await Promise.all(ioConnections.map(({ io }) => io.stop()));
    await Promise.all(ioConnections.map(({ opened }) => scanner.closeConnection(opened)));
    await scanner.disconnect();
    await adapter.stop();

    // Pool inter-arrival deltas across all connections (they run at the same RPI, so this is a
    // fair aggregate view of production jitter under this total tag load).
    let allDeltas = [];
    let totalPackets = 0;
    let totalBytesMoved = 0;
    for (const { io } of ioConnections) {
        totalPackets += io._hrTimestamps.length;
        totalBytesMoved += io._hrTimestamps.length * io._benchBytes;
        for (let i = 1; i < io._hrTimestamps.length; i++) {
            allDeltas.push(Number(io._hrTimestamps[i] - io._hrTimestamps[i - 1]) / 1e6);
        }
    }

    const stats = computeStats(allDeltas);
    const throughputBytesPerSec = totalBytesMoved / (DURATION_MS / 1000);
    const throughputTagsPerSec = (totalBytesMoved / BYTES_PER_TAG) / (DURATION_MS / 1000);

    return {
        totalTags,
        connections: plan.length,
        setupMs,
        totalPackets,
        throughputBytesPerSec,
        throughputTagsPerSec,
        rssAfterMB: memAfter.rss / 1024 / 1024,
        heapUsedAfterMB: memAfter.heapUsed / 1024 / 1024,
        stats
    };
}

async function main() {
    let hiresStatus = { hires: false, ms: null };
    if (USE_HIRES) {
        hiresStatus = hiresTimer.raise(1);
        console.log(hiresStatus.hires
            ? `[hires] Windows timer resolution raised to ${hiresStatus.ms}ms\n`
            : `[hires] requested but unavailable -- running at default OS timer resolution\n`);
    }

    console.log(`Tag-scale stress test -- RPI=${RPI_MS}ms, duration=${DURATION_MS}ms/count, ${BYTES_PER_TAG}B/tag, sweeping tags: ${TAG_COUNTS.join(', ')}`);
    console.log(`(max ${MAX_TAGS_PER_CONNECTION} tags per Class 1 connection under the 65535B Large Forward Open cap)\n`);

    const results = [];
    for (const totalTags of TAG_COUNTS) {
        console.log(`--- Testing ${totalTags.toLocaleString()} tags ---`);
        let r;
        try {
            r = await runOneTagCount(totalTags);
        } catch (err) {
            console.log(`  ERROR: ${err.message}`);
            results.push({ totalTags, error: err.message });
            continue;
        }
        results.push(r);
        console.log(`  connections=${r.connections} setup=${r.setupMs.toFixed(1)}ms`);
        console.log(`  packets=${r.totalPackets} throughput=${(r.throughputBytesPerSec / 1024).toFixed(1)}KB/s (${Math.round(r.throughputTagsPerSec).toLocaleString()} tags/s produced)`);
        if (r.stats) {
            console.log(`  T->O interval: avg=${r.stats.avg.toFixed(3)}ms stdev=${r.stats.stdev.toFixed(3)}ms p95=${r.stats.p95.toFixed(3)}ms p99=${r.stats.p99.toFixed(3)}ms`);
        }
        console.log(`  memory after: rss=${r.rssAfterMB.toFixed(1)}MB heapUsed=${r.heapUsedAfterMB.toFixed(1)}MB`);
        console.log('');
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (global.gc) global.gc();
    }

    console.log('=== Summary ===');
    console.log('tags       | conns | setup(ms) | KB/s     | tags/s      | avg(ms) | p99(ms) | rss(MB)');
    for (const r of results) {
        if (r.error) {
            console.log(`${String(r.totalTags).padStart(10)} | ERROR: ${r.error}`);
            continue;
        }
        console.log(
            `${r.totalTags.toLocaleString().padStart(10)} | ${String(r.connections).padStart(5)} | ${r.setupMs.toFixed(1).padStart(9)} | ` +
            `${(r.throughputBytesPerSec / 1024).toFixed(1).padStart(8)} | ${Math.round(r.throughputTagsPerSec).toLocaleString().padStart(11)} | ` +
            `${r.stats ? r.stats.avg.toFixed(3).padStart(7) : '   n/a'} | ${r.stats ? r.stats.p99.toFixed(3).padStart(7) : '   n/a'} | ${r.rssAfterMB.toFixed(1).padStart(7)}`
        );
    }
    if (hiresStatus.hires) hiresTimer.restore();
}

main().catch((err) => {
    hiresTimer.restore();
    console.error('Fatal error:', err);
    process.exit(1);
});
