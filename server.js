const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const { checkMonitorsOnce, startMonitorLoop, monitorEvents, readMonitors, writeMonitors } = require("./worker");

// ensure at least one static monitor for testing when no monitors
try {
    const cur = readMonitors();
    if (!Array.isArray(cur) || cur.length === 0) {
        const seed = Date.now();
        const monitorsToAdd = [
            { id: 'static-nueva', name: 'Nueva Guinea', url: '192.168.1.1', type: 'ping', interval: 30, lastStatus: null },
            { id: 'muelle-bueyes', name: 'Muelle de los Bueyes', url: '191.98.238.246', type: 'ping', interval: 30, lastStatus: null },
            { id: 'carlos', name: 'Carlos', url: '192.168.1.53', type: 'ping', interval: 30, lastStatus: null },
            { id: 'el-rama', name: 'El Rama', url: '191.98.238.122', type: 'ping', interval: 30, lastStatus: null },
            { id: 'san-carlos', name: 'San Carlos', url: '190.106.18.98', type: 'ping', interval: 30, lastStatus: null }
        ];
        monitorsToAdd.forEach(m => cur.push(m));
        writeMonitors(cur);
        console.log('Added initial monitors for testing:', monitorsToAdd.map(m=>m.name).join(', '));
    }
} catch (e) { console.error('init monitors error', e); }

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/monitors", (req, res) => { res.json(readMonitors()); });

// Server-Sent Events stream for real-time updates
const sseClients = new Set();
app.get('/api/stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('\n');
    // send initial data
    res.write(`data: ${JSON.stringify(readMonitors())}\n\n`);
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
});

// emit updates to SSE clients
monitorEvents.on('update', (monitors) => {
    // keep internal cache in sync when worker emits updates
    writeMonitors(monitors);
    const payload = `data: ${JSON.stringify(monitors)}\n\n`;
    console.log(`server: emitting update to ${sseClients.size} SSE clients, monitors=${monitors.length}`);
    for (const res of Array.from(sseClients)) {
        try { res.write(payload); } catch (e) { sseClients.delete(res); }
    }
});

app.post("/api/monitors", (req, res) => {
    const monitors = readMonitors();
    const id = Date.now().toString(36);
    const m = Object.assign({ id, type: "http", interval: 30, name: "unnamed", lastStatus: null }, req.body);
    monitors.push(m);
    writeMonitors(monitors);
    try { monitorEvents.emit('update', monitors); } catch (e) { }
    res.json(m);
});

app.delete("/api/monitors/:id", (req, res) => {
    let monitors = readMonitors();
    const before = monitors.length;
    monitors = monitors.filter(m => m.id !== req.params.id);
    writeMonitors(monitors);
    try { monitorEvents.emit('update', monitors); } catch (e) { }
    res.json({ removed: before - monitors.length });
});

app.post("/api/check-now", async (req, res) => {
    const result = await checkMonitorsOnce(true);
    res.json(result);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Monitores app listening on port ${port}`);
    startMonitorLoop();
});
