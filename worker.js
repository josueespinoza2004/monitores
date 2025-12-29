const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require('child_process');
const EventEmitter = require('events');
const monitorEvents = new EventEmitter();

const DATA_DIR = path.join(__dirname, "data");
const MONITORS_FILE = path.join(DATA_DIR, "monitors.json");

// default to in-memory mode unless explicitly disabled
const IN_MEMORY = !(process.env.IN_MEMORY === '0' || process.env.IN_MEMORY === 'false');

// load monitors into memory cache (skip file read when in-memory mode)
let MONITORS_CACHE = [];
try {
    if (!IN_MEMORY && fs.existsSync(MONITORS_FILE)) MONITORS_CACHE = JSON.parse(fs.readFileSync(MONITORS_FILE, "utf8")) || [];
    else MONITORS_CACHE = [];
} catch (e) { MONITORS_CACHE = []; }

function readMonitors() { return Array.isArray(MONITORS_CACHE) ? MONITORS_CACHE.slice() : []; }

function writeMonitors(arr) {
    MONITORS_CACHE = Array.isArray(arr) ? arr.slice() : [];
    if (!IN_MEMORY) {
        try { fs.writeFileSync(MONITORS_FILE, JSON.stringify(MONITORS_CACHE, null, 2)); } catch (e) { console.error('worker writeMonitors error', e); }
    }
}

// helper to write and emit updates
function writeMonitorsAndEmit(arr) {
    writeMonitors(arr);
    try { monitorEvents.emit('update', arr); } catch (e) { }
}

function httpCheck(url, timeout = 10000) {
    return new Promise((resolve) => {
        try {
            // ensure URL has protocol
            let u = url;
            if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
            const lib = u.startsWith("https") ? https : http;
            const req = lib.get(u, (res) => {
                resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, code: res.statusCode });
            });
            req.on("error", () => resolve({ ok: false }));
            req.setTimeout(timeout, () => { req.abort(); resolve({ ok: false }); });
        } catch (e) { resolve({ ok: false }); }
    });
}

async function checkMonitorsOnce(force = false) {
    const monitors = readMonitors();
    const now = Date.now();
    for (const m of monitors) {
        try {
            const intervalMs = (m.interval || 60) * 1000;
            if (!force && m.lastChecked && (m.lastChecked + intervalMs) > now) {
                // not yet time to check this monitor
                continue;
            }
            if (m.type === "http") {
                const r = await httpCheck(m.url, 10000);
                    m.lastStatus = r.ok ? "up" : "down";
                    m.lastChecked = now;
                    m.lastCode = r.code || null;
                    // append heartbeat
                    if (!Array.isArray(m.history)) m.history = [];
                    m.history.push({ t: now, status: m.lastStatus, code: m.lastCode });
                console.log(`worker: monitor=${m.id} name=${m.name} status=${m.lastStatus} code=${m.lastCode}`);
            } else if (m.type === 'ping') {
                // use system ping -c 1 -W 1
                const target = m.url || m.target;
                if (!target) {
                    m.lastStatus = 'unknown';
                    m.lastChecked = now;
                } else {
                    const r = await pingOnce(target);
                    m.lastStatus = r.ok ? 'up' : 'down';
                    m.lastChecked = now;
                    m.lastPing = (typeof r.ping === 'number') ? r.ping : null;
                    m.lastCode = r.ok ? 0 : 1;
                    if (!Array.isArray(m.history)) m.history = [];
                    m.history.push({ t: now, status: m.lastStatus, code: m.lastCode, ping: m.lastPing, out: r.stdout, err: r.stderr });
                    console.log(`worker: ping monitor=${m.id} name=${m.name} status=${m.lastStatus} ping=${m.lastPing} code=${m.lastCode}`);
                }
            } else {
                m.lastStatus = "unknown";
                m.lastChecked = now;
            }
        } catch (e) {
            m.lastStatus = "down";
            m.lastChecked = now;
            if (!Array.isArray(m.history)) m.history = [];
            m.history.push({ t: now, status: m.lastStatus, code: null, err: String(e) });
            console.error(`worker: error monitor=${m.id} name=${m.name} err=${String(e)}`);
        }
            // trim history to reasonable size (keep ~ 7 days if interval small). Max entries: 7*24*60 = 10080
            if (Array.isArray(m.history)) {
                const maxEntries = 10080;
                if (m.history.length > maxEntries) m.history = m.history.slice(m.history.length - maxEntries);
                // compute uptime percentages
                const since24 = now - 24*60*60*1000;
                const since30d = now - 30*24*60*60*1000;
                const entries24 = m.history.filter(h => h.t >= since24);
                const entries30 = m.history.filter(h => h.t >= since30d);
                const up24 = entries24.length ? (entries24.filter(h => h.status==='up').length / entries24.length) * 100 : null;
                const up30 = entries30.length ? (entries30.filter(h => h.status==='up').length / entries30.length) * 100 : null;
                m.uptime24 = up24 !== null ? Math.round(up24*100)/100 : null;
                m.uptime30 = up30 !== null ? Math.round(up30*100)/100 : null;
            } else {
                m.uptime24 = null;
                m.uptime30 = null;
            }
    }
    writeMonitorsAndEmit(monitors);
    return monitors;
}

function pingOnce(target) {
    return new Promise((resolve) => {
        // Spawn system ping and parse output. Support Linux and macOS flags where possible.
        const args = process.platform === 'darwin' ? ['-c', '1', '-W', '1000', target] : ['-c', '1', '-W', '1', target];
        const p = spawn('ping', args);
        let finished = false;
        let stdout = '';
        let stderr = '';
        p.stdout && p.stdout.on('data', (d) => { stdout += d.toString(); });
        p.stderr && p.stderr.on('data', (d) => { stderr += d.toString(); });
        p.on('error', (err) => { if (!finished) { finished = true; resolve({ ok:false, ping:null, stdout, stderr: String(err) }); } });
        p.on('close', (code) => {
            if (finished) return;
            finished = true;
            // parse stdout for RTT (support rtt avg line, english 'time' and spanish 'tiempo')
            let ping = null;
            let ok = code === 0;
            try {
                // try rtt min/avg/max/mdev = min/avg/max/mdev (common on Linux)
                const rttMatch = stdout.match(/rtt\s[^=]*=\s*[0-9.]+\/([0-9.]+)\//) || stdout.match(/round-trip\s[^=]*=\s*[0-9.]+\/([0-9.]+)\//);
                if (rttMatch) {
                    ping = Math.round(parseFloat(rttMatch[1]) * 100) / 100; // keep two decimals
                } else {
                    // try time=NN ms or tiempo=NN ms or variants
                    const timeMatch = stdout.match(/(?:time|tiempo)=\s*([0-9]+(?:\.[0-9]+)?)\s*ms/) || stdout.match(/time\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*ms/);
                    if (timeMatch) ping = Math.round(parseFloat(timeMatch[1]) * 100) / 100;
                }
                // fallback: if exit code non-zero but output contains response, set ok true
                if (!ok) {
                    if (/bytes from/.test(stdout) || /icmp_seq/.test(stdout) || /ttl=/.test(stdout) || /tiempo=/.test(stdout)) ok = true;
                }
            } catch (e) { }
            resolve({ ok, ping, stdout, stderr });
        });
        // safety timeout
        setTimeout(() => { if (!finished) { finished = true; try { p.kill(); } catch (e){} resolve({ ok:false, ping:null, stdout, stderr:'timeout' }); } }, 5000);
    });
}

function startMonitorLoop() {
    // run a lightweight scheduler every second that only checks monitors when due
    setInterval(() => {
        checkMonitorsOnce().catch(() => {});
    }, 1000);
    // initial run (do not force everything, let interval rules apply)
    checkMonitorsOnce().catch(() => {});
}

module.exports = { checkMonitorsOnce, startMonitorLoop, monitorEvents, readMonitors, writeMonitors };
