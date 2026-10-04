// main.js — Super Blood Hockey WASM bootstrap
// Based on proven patterns from Carrion, RogueLegacy, and AxiomVerge WASM ports.
//
// KEY RULES:
//   1. STRICT single-handle requestAnimationFrame loop with isRunning gate.
//   2. NO getBoundingClientRect(), NO DOM measurements inside step().
//   3. FPS counter via 500 ms setInterval reading an integer counter (no rAF).
//   4. WebAudio unlock on user gesture (capture-phase, passive).
//   5. MEMFS preload: /Content, /Data, /Names from network fetch + browser cache.
//   6. /save mounted to IDBFS + direct IndexedDB redundancy for persistence.

import { dotnet } from './_framework/dotnet.js';

const canvas    = document.getElementById('canvas');
const progressEl = document.getElementById('loading-progress');
const overlayEl  = document.getElementById('loading') || document.getElementById('loading-overlay');
const fpsEl      = document.getElementById('fps-counter');

// Set the canvas back-buffer size to the game's native resolution.
if (canvas) {
    canvas.width  = 1280;
    canvas.height = 720;
}

// Strip automatic requestFullscreen and click-to-fullscreen event listeners
if (canvas) {
    canvas.requestFullscreen = () => Promise.resolve();
    canvas.webkitRequestFullscreen = () => Promise.resolve();
    canvas.mozRequestFullScreen = () => Promise.resolve();
    canvas.msRequestFullscreen = () => Promise.resolve();
}
document.documentElement.requestFullscreen = () => Promise.resolve();
document.body.requestFullscreen = () => Promise.resolve();
if (globalThis.Module) {
    globalThis.Module.requestFullscreen = () => {};
}

function setStatus(msg) {
    console.log('[SuperBloodHockey] ' + msg);
    if (progressEl) progressEl.textContent = msg;
}

setStatus('Initialising .NET WebAssembly runtime…');

// Attach canvas to global Module immediately for early SDL/WebGL detection.
globalThis.Module = globalThis.Module || {};
if (canvas) globalThis.Module.canvas = canvas;

// ---------------------------------------------------------------------------
// 1. WebAudio autoplay unlock + ScriptProcessor clamp
// ---------------------------------------------------------------------------
const activeAudioContexts = new Set();
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;

if (OrigAudioContext) {
    const WrappedAudioContext = function (...args) {
        let opts = args[0];
        if (!opts || typeof opts !== 'object') opts = {};
        else opts = Object.assign({}, opts);
        if (!opts.sampleRate) opts.sampleRate = 48000;
        const ctx = new OrigAudioContext(opts);
        activeAudioContexts.add(ctx);
        console.log('[SBH Audio] AudioContext created. Rate:', ctx.sampleRate, 'State:', ctx.state);
        ctx.addEventListener('statechange', () =>
            console.log('[SBH Audio] AudioContext state:', ctx.state));
        return ctx;
    };
    WrappedAudioContext.prototype = OrigAudioContext.prototype;

    // Clamp createScriptProcessor bufferSize to a valid power of 2.
    const origCSP = OrigAudioContext.prototype.createScriptProcessor;
    if (origCSP) {
        OrigAudioContext.prototype.createScriptProcessor = function (bufferSize, inCh, outCh) {
            const valid = [256, 512, 1024, 2048, 4096, 8192, 16384];
            let clamped = bufferSize;
            if (!valid.includes(bufferSize)) {
                clamped = valid.reduce((best, p) =>
                    Math.abs(p - bufferSize) < Math.abs(best - bufferSize) ? p : best, 4096);
                console.warn('[SBH Audio] Clamping bufferSize', bufferSize, '->', clamped);
            }
            return origCSP.call(this, clamped, inCh, outCh);
        };
    }

    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
}

function resumeAllAudio() {
    for (const ctx of activeAudioContexts) {
        if (ctx.state === 'suspended') {
            ctx.resume().catch(err => console.warn('[SBH Audio] Resume error:', err));
        }
    }
    const sdl2 = globalThis.Module?.SDL2 || globalThis.SDL2 || window.SDL2;
    if (sdl2?.audioContext && sdl2.audioContext.state === 'suspended') {
        sdl2.audioContext.resume().catch(() => {});
    }
}

// User-gesture unlock — capture phase, passive
const unlockAudio = () => resumeAllAudio();
['click','keydown','keyup','mousedown','mouseup','pointerdown','touchstart','touchend'].forEach(evt => {
    window.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    document.addEventListener(evt, unlockAudio, { capture: true, passive: true });
    if (canvas) canvas.addEventListener(evt, unlockAudio, { capture: true, passive: true });
});

// ---------------------------------------------------------------------------
// 2. FPS counter — 500 ms setInterval, reads integer frame counter.
//    NO rAF loop for FPS (a single rAF is owned exclusively by the game loop).
// ---------------------------------------------------------------------------
let _fpsFrameCount = 0;

setInterval(() => {
    const fps = _fpsFrameCount * 2; // sampled every 500 ms → ×2 = per-second
    _fpsFrameCount = 0;
    if (fpsEl) {
        fpsEl.textContent = fps + ' FPS';
        if (fps >= 50) {
            fpsEl.style.color = '#4ade80';
            fpsEl.style.borderColor = 'rgba(74,222,128,0.35)';
        } else if (fps >= 28) {
            fpsEl.style.color = '#facc15';
            fpsEl.style.borderColor = 'rgba(250,204,21,0.35)';
        } else {
            fpsEl.style.color = '#f87171';
            fpsEl.style.borderColor = 'rgba(248,113,113,0.35)';
        }
    }
    // Periodic audio resume (only if user has interacted)
    if (navigator.userActivation && navigator.userActivation.hasBeenActive) {
        resumeAllAudio();
    }
}, 500);

// ---------------------------------------------------------------------------
// 3. Utility: directory helpers for Emscripten FS
// ---------------------------------------------------------------------------
function getDirname(filePath) {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.substring(0, idx);
}

function ensureDirectoryExists(fs, dirPath) {
    if (!dirPath || dirPath === '/' || dirPath === '.') return;
    const parts = dirPath.split('/').filter(p => p.length > 0);
    let current = '';
    for (const part of parts) {
        current += '/' + part;
        try {
            if (typeof fs.analyzePath === 'function') {
                if (!fs.analyzePath(current).exists) fs.mkdir(current);
            } else {
                fs.mkdir(current);
            }
        } catch (_) { /* dir may already exist */ }
    }
}

// ---------------------------------------------------------------------------
// 4. Asset manifest generation helper (builds list at runtime from deployed files)
//    We use a simple directory-listing approach via a manifest.json if present,
//    otherwise fall back to fetching each known subdirectory.
// ---------------------------------------------------------------------------
const ASSET_CACHE_NAME = 'sbh-assets-v1';

/**
 * Fetch a file URL. Uses browser Cache Storage to avoid re-downloading.
 */
async function fetchCached(cache, url) {
    if (cache) {
        try {
            const hit = await cache.match(url);
            if (hit) {
                const buf = await hit.arrayBuffer();
                if (buf.byteLength > 0) return buf;
            }
        } catch (_) {}
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
    const buf = await resp.arrayBuffer();
    if (cache && buf.byteLength > 0) {
        try { await cache.put(url, new Response(buf)); } catch (_) {}
    }
    return buf;
}

/**
 * Preload all assets from /Content, /Data, /Names into Emscripten MEMFS.
 * Uses Content/manifest.json if present; otherwise skips gracefully.
 */
async function preloadAssets(FS) {
    if (!FS) { console.warn('[SBH] FS not available, skipping asset preload.'); return; }

    let cache = null;
    if (typeof caches !== 'undefined') {
        try { cache = await caches.open(ASSET_CACHE_NAME); } catch (_) {}
    }

    // ---------- Content ----------
    let contentFiles = [];
    try {
        const r = await fetch('Content/manifest.json', { cache: 'no-store' });
        if (r.ok) contentFiles = await r.json();
    } catch (_) {}

    if (contentFiles.length > 0) {
        ensureDirectoryExists(FS, '/Content');
        const total = contentFiles.length;
        setStatus(`Loading: 0 / ${total} (0%)`);
        let count = 0;
        const CONC = 6;
        let nextIdx = 0;

        async function worker() {
            while (nextIdx < contentFiles.length) {
                const idx = nextIdx++;
                const rel  = contentFiles[idx];
                const url  = 'Content/' + rel;
                const virt = '/Content/' + rel;
                ensureDirectoryExists(FS, getDirname(virt));
                try {
                    const buf = await fetchCached(cache, url);
                    FS.writeFile(virt, new Uint8Array(buf));
                } catch (e) {
                    console.warn('[SBH] Asset load failed:', url, e);
                }
                count++;
                if (count % 5 === 0 || count === total) {
                    const pct = Math.round((count / total) * 100);
                    setStatus(`Loading: ${count} / ${total} (${pct}%)`);
                    await new Promise(r => setTimeout(r, 0));
                }
            }
        }

        const workers = [];
        for (let i = 0; i < Math.min(CONC, contentFiles.length); i++) workers.push(worker());
        await Promise.all(workers);
        console.log('[SBH] Preloaded', contentFiles.length, 'Content assets.');
    } else {
        console.log('[SBH] No Content/manifest.json found — Content will be read from MEMFS if previously populated.');
    }

    // ---------- Data ----------
    let dataFiles = [];
    try {
        const r = await fetch('Data/manifest.json', { cache: 'no-store' });
        if (r.ok) dataFiles = await r.json();
    } catch (_) {}

    if (dataFiles.length > 0) {
        ensureDirectoryExists(FS, '/Data');
        setStatus('Pre-loading Data files…');
        for (const rel of dataFiles) {
            const url  = 'Data/' + rel;
            const virt = '/Data/' + rel;
            ensureDirectoryExists(FS, getDirname(virt));
            try {
                const buf = await fetchCached(cache, url);
                FS.writeFile(virt, new Uint8Array(buf));
            } catch (e) {
                console.warn('[SBH] Data load failed:', url, e);
            }
        }
        console.log('[SBH] Preloaded', dataFiles.length, 'Data files.');
    } else {
        // Ensure /Data dir exists even if no manifest
        ensureDirectoryExists(FS, '/Data');
    }

    // ---------- Names ----------
    let namesFiles = [];
    try {
        const r = await fetch('Names/manifest.json', { cache: 'no-store' });
        if (r.ok) namesFiles = await r.json();
    } catch (_) {}

    if (namesFiles.length > 0) {
        ensureDirectoryExists(FS, '/Names');
        setStatus('Pre-loading Names files…');
        for (const rel of namesFiles) {
            const url  = 'Names/' + rel;
            const virt = '/Names/' + rel;
            ensureDirectoryExists(FS, getDirname(virt));
            try {
                const buf = await fetchCached(cache, url);
                FS.writeFile(virt, new Uint8Array(buf));
            } catch (e) {
                console.warn('[SBH] Names load failed:', url, e);
            }
        }
        console.log('[SBH] Preloaded', namesFiles.length, 'Names files.');
    } else {
        ensureDirectoryExists(FS, '/Names');
    }
}

// ---------------------------------------------------------------------------
// 5. Save data persistence (IDBFS + IndexedDB direct redundancy)
// ---------------------------------------------------------------------------
const SAVE_DB_NAME    = 'superbloodhockey-save-db';
const SAVE_STORE_NAME = 'saves';
let isIDBFSMounted  = false;
let isSyncing       = false;
let saveIsDirty     = false;

function openSaveDB() {
    return new Promise(resolve => {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        try {
            const req = indexedDB.open(SAVE_DB_NAME, 1);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(SAVE_STORE_NAME))
                    db.createObjectStore(SAVE_STORE_NAME);
            };
            req.onsuccess  = () => resolve(req.result);
            req.onerror    = () => resolve(null);
        } catch (_) { resolve(null); }
    });
}

async function restoreSavesFromIDB(FS) {
    const db = await openSaveDB();
    if (!db) return;
    return new Promise(resolve => {
        try {
            const tx    = db.transaction(SAVE_STORE_NAME, 'readonly');
            const store = tx.objectStore(SAVE_STORE_NAME);
            const req   = store.openCursor();
            req.onsuccess = e => {
                const cursor = e.target.result;
                if (cursor) {
                    const path = cursor.key;
                    if (path.includes('Phobia') || path.includes('Carrion') || path.includes('carrion')) {
                        cursor.continue();
                        return;
                    }
                    const data = cursor.value;
                    try {
                        ensureDirectoryExists(FS, getDirname(path));
                        FS.writeFile(path, data);
                        console.log('[SBH] Restored save:', path);
                    } catch (err) {
                        console.warn('[SBH] Restore save failed:', path, err);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        } catch (err) {
            console.warn('[SBH] IDB restore error:', err);
            resolve();
        }
    });
}

function collectFiles(FS, dir) {
    let results = [];
    try {
        if (typeof FS.analyzePath === 'function' && !FS.analyzePath(dir).exists) return results;
        const entries = FS.readdir(dir);
        for (const entry of entries) {
            if (entry === '.' || entry === '..') continue;
            if (entry.includes('Phobia') || entry.includes('Carrion') || entry.includes('carrion')) continue;
            const full = (dir === '/' ? '/' : dir + '/') + entry;
            try {
                const stat = FS.stat(full);
                if (FS.isDir(stat.mode)) {
                    results = results.concat(collectFiles(FS, full));
                } else if (FS.isFile(stat.mode)) {
                    results.push(full);
                }
            } catch (_) {}
        }
    } catch (_) {}
    return results;
}

async function persistSavesToIDB(FS, force = false) {
    if (!FS || isSyncing) return;
    if (!saveIsDirty && !force) return;
    isSyncing = true;
    try {
        if (isIDBFSMounted && typeof FS?.syncfs === 'function' && FS?.filesystems?.IDBFS) {
            await new Promise(resolve => {
                FS.syncfs(false, err => {
                    if (err) console.warn('[SBH] IDBFS flush error:', err);
                    resolve();
                });
            });
        }

        const db = await openSaveDB();
        if (!db) { saveIsDirty = false; return; }

        let saveFiles = [...collectFiles(FS, '/save'), ...collectFiles(FS, '/Franchises')];
        try {
            if (typeof FS.analyzePath === 'function' && FS.analyzePath('/SubparBloopHokeyCon.fig').exists) {
                saveFiles.push('/SubparBloopHokeyCon.fig');
            }
        } catch (_) {}
        saveFiles = saveFiles.filter(p => !p.includes('Phobia') && !p.includes('Carrion') && !p.includes('carrion'));
        if (saveFiles.length === 0) { saveIsDirty = false; return; }

        await new Promise(resolve => {
            try {
                const tx    = db.transaction(SAVE_STORE_NAME, 'readwrite');
                const store = tx.objectStore(SAVE_STORE_NAME);
                for (const filePath of saveFiles) {
                    try {
                        const data = FS.readFile(filePath);
                        store.put(data, filePath);
                    } catch (err) {
                        console.warn('[SBH] Save write failed:', filePath, err);
                    }
                }
                tx.oncomplete = () => resolve();
                tx.onerror    = () => resolve();
            } catch (err) {
                console.warn('[SBH] IDB persist error:', err);
                resolve();
            }
        });
        saveIsDirty = false;
    } catch (err) {
        console.warn('[SBH] persistSavesToIDB error:', err);
    } finally {
        isSyncing = false;
    }
}

async function mountSave(FS) {
    if (!FS) { console.warn('[SBH] FS not available, skipping save mount.'); return; }

    ensureDirectoryExists(FS, '/save');
    ensureDirectoryExists(FS, '/save/SuperBloodHockey');
    ensureDirectoryExists(FS, '/Franchises');

    // Intercept FS.writeFile to dirty-mark saves
    const origWrite = FS.writeFile;
    if (origWrite && !FS._sbhSaveHookInstalled) {
        FS._sbhSaveHookInstalled = true;
        FS.writeFile = function (path, data, options) {
            if (typeof path === 'string') {
                if (path.startsWith('/save') || path.startsWith('/Franchises') || path.startsWith('Franchises') || path.includes('SubparBloopHokeyCon.fig')) {
                    saveIsDirty = true;
                }
            }
            return origWrite.call(this, path, data, options);
        };
    }

    if (typeof FS.mount === 'function' && FS.filesystems?.IDBFS) {
        try {
            FS.mount(FS.filesystems.IDBFS, {}, '/save');
            await new Promise(resolve => {
                FS.syncfs(true, err => {
                    if (err) console.warn('[SBH] IDBFS initial sync error:', err);
                    resolve();
                });
            });
            isIDBFSMounted = true;
            console.log('[SBH] /save mounted to IDBFS.');
        } catch (e) {
            console.warn('[SBH] IDBFS mount failed, using IDB direct mode:', e);
        }
    }

    console.log('[SBH] Restoring saves from IndexedDB…');
    await restoreSavesFromIDB(FS);
}

// ---------------------------------------------------------------------------
// 6. Main bootstrap
// ---------------------------------------------------------------------------

// STRICT single-handle rAF loop with re-entrancy protection.
let currentRafId = null;
let isRunning    = false;

window.notifyGameReady = () => {
    const loader = document.getElementById('loading') || document.getElementById('loading-overlay');
    if (loader) {
        loader.classList.add('hidden');
        loader.style.opacity = '0';
        loader.style.pointerEvents = 'none';
        loader.style.display = 'none';
    }
};

try {
    const runtime = await dotnet
        .withEnvironmentVariable('FNA_PLATFORM_BACKEND', 'SDL2')
        .withDiagnosticTracing(false)
        .withModuleConfig({ canvas: canvas })
        .create();

    // Ensure canvas is wired across all Module references
    if (runtime.Module && canvas) runtime.Module.canvas = canvas;
    if (canvas) globalThis.Module.canvas = canvas;

    // Register JSImport handlers
    if (typeof runtime.setModuleImports === 'function') {
        runtime.setModuleImports('main.js', {

            // Called by C# Program.cs to hand us the per-frame LoopStep action.
            // We start the SINGLE authoritative rAF loop here.
            setMainLoop: (cb) => {
                if (isRunning) return;
                isRunning = true;
                console.log('[SBH JS] setMainLoop: Starting rAF game loop.');
                if (currentRafId !== null) cancelAnimationFrame(currentRafId);

                function step() {
                    try {
                        cb();
                    } catch (err) {
                        console.error('[SBH JS loop frame error]', err);
                    }
                    _fpsFrameCount++;
                    currentRafId = requestAnimationFrame(step);
                }
                currentRafId = requestAnimationFrame(step);
            },

            // Called by C# on the first successfully rendered frame.
            notifyGameReady: () => {
                console.log('[SBH JS] notifyGameReady: First frame rendered!');
                window._gameReady = true;
                const loader = document.getElementById('loading') || document.getElementById('loading-overlay');
                if (loader) {
                    loader.classList.add('hidden');
                    loader.style.opacity = '0';
                    loader.style.pointerEvents = 'none';
                    loader.style.display = 'none';
                }
            },
        });
    }

    // Resolve Emscripten FS
    const FS = runtime.Module?.FS || runtime.FS || globalThis.Module?.FS;

    setStatus('Mounting save storage…');
    await mountSave(FS);

    setStatus('Pre-loading game assets…');
    await preloadAssets(FS);

    // Periodic save flush (non-blocking)
    const flushSaves = (force = false) => {
        try { persistSavesToIDB(FS, force); } catch (_) {}
    };
    setInterval(() => flushSaves(false), 10000);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSaves(true);
    });
    window.addEventListener('beforeunload', () => flushSaves(true));

    setStatus('Starting game engine…');
    // Small yield so the browser can paint the status message before the
    // game's LoadContent blocks the thread.
    await new Promise(r => setTimeout(r, 50));

    // Launch .NET runtime — this calls Program.Main() which creates Game1
    // and registers the per-frame callback via JSImport setMainLoop above.
    await dotnet.run();

} catch (err) {
    console.error('[SBH Fatal Error]', err);
    if (progressEl) progressEl.textContent = 'Fatal Error: ' + (err.message || err);
}
