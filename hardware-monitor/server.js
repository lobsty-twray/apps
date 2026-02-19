const express = require("express");
const WebSocket = require("ws");
const si = require("systeminformation");
const path = require("path");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let clients = [];

wss.on("connection", (ws) => {
  clients.push(ws);
  console.log("Client connected. Total clients:", clients.length);

  ws.on("close", () => {
    clients = clients.filter(client => client !== ws);
    console.log("Client disconnected. Total clients:", clients.length);
  });
});

// Broadcast system stats to all connected clients
async function broadcastStats() {
  if (clients.length === 0) return;

  try {
    const [cpu, mem, fsSize, networkStats, graphics, temps] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.networkStats(),
      si.graphics(),
      si.cpuTemperature()
    ]);

    const stats = {
      timestamp: Date.now(),
      cpu: {
        load: Math.round(cpu.currentLoad),
        cores: cpu.cpus ? cpu.cpus.map(c => Math.round(c.load)) : []
      },
      memory: {
        used: mem.used,
        total: mem.total,
        percent: Math.round((mem.used / mem.total) * 100)
      },
      disk: fsSize.map(fs => ({
        fs: fs.fs,
        mount: fs.mount,
        used: fs.used,
        size: fs.size,
        percent: Math.round(fs.use)
      })),
      network: networkStats.map(net => ({
        iface: net.iface,
        rx: net.rx_sec,
        tx: net.tx_sec
      })),
      gpu: graphics.controllers.map(gpu => ({
        model: gpu.model,
        vram: gpu.vram,
        temp: gpu.temperatureGpu || 0,
        utilizationGpu: gpu.utilizationGpu || 0,
        utilizationMemory: gpu.utilizationMemory || 0
      })),
      temps: {
        main: temps.main || 0,
        cores: temps.cores || [],
        max: temps.max || 0
      }
    };

    const message = JSON.stringify(stats);
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
  }
}

// Update stats every 2 seconds
setInterval(broadcastStats, 2000);

server.listen(PORT, () => {
  console.log(`💻 Hardware Monitor running on port ${PORT}`);
});
