'use strict';

/**
 * Windows multimedia timer resolution control, via koffi FFI into winmm.dll --
 * no native addon build required.
 *
 * Why this exists: Windows' default system timer tick is ~15.6ms, so
 * setInterval/setTimeout (what IOConnection/_startProducer use for cyclic
 * Class 1 I/O production) cannot reliably fire faster than that by default --
 * an RPI of 1-5ms will visibly coalesce/jitter against that tick regardless of
 * how fast the JS callback itself runs. `timeBeginPeriod(1)` (the same Win32
 * API `timeBeginPeriod`/`timeEndPeriod` pair every low-latency Windows app --
 * games, audio engines -- calls) asks the OS scheduler for 1ms tick
 * granularity for the lifetime of the request, which in turn lets libuv's underlying
 * uv_timer (and therefore setInterval/setTimeout) actually fire close to their
 * requested interval instead of snapping to the ~15.6ms tick.
 *
 * No-op (raise()/restore() both resolve immediately, hires=false) on any
 * platform other than win32, and if koffi/winmm.dll aren't available for any
 * reason -- callers don't need a platform check of their own.
 */

let winmm = null;
let timeBeginPeriod = null;
let timeEndPeriod = null;
let raisedMs = null;

function tryLoad() {
    if (process.platform !== 'win32') return false;
    if (winmm) return true;
    try {
        const koffi = require('koffi');
        winmm = koffi.load('winmm.dll');
        timeBeginPeriod = winmm.func('__stdcall', 'timeBeginPeriod', 'uint32', ['uint32']);
        timeEndPeriod = winmm.func('__stdcall', 'timeEndPeriod', 'uint32', ['uint32']);
        return true;
    } catch (err) {
        console.warn(`[win-hires-timer] koffi/winmm.dll unavailable, running without raised timer resolution: ${err.message}`);
        winmm = null;
        return false;
    }
}

/**
 * Raises the process-wide (system-wide, actually -- Windows' timer resolution
 * request is global, not per-process, but is automatically released if this
 * process exits without calling restore()) timer resolution.
 *
 * @param {number} [ms=1] - Requested resolution in milliseconds (1 is the
 *   practical floor most hardware/drivers actually honor).
 * @returns {{ hires: boolean, ms: number|null }}
 */
function raise(ms = 1) {
    if (!tryLoad()) return { hires: false, ms: null };
    const TIMERR_NOERROR = 0;
    const result = timeBeginPeriod(ms);
    if (result !== TIMERR_NOERROR) {
        console.warn(`[win-hires-timer] timeBeginPeriod(${ms}) failed (code ${result})`);
        return { hires: false, ms: null };
    }
    raisedMs = ms;
    return { hires: true, ms };
}

/** Releases a previously-raised resolution. Safe to call even if raise() was never called or failed. */
function restore() {
    if (!winmm || raisedMs === null) return;
    timeEndPeriod(raisedMs);
    raisedMs = null;
}

module.exports = { raise, restore };
