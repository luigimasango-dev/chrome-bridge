// Chrome Bridge — MCP server for OpenCode / Claude Code.
//
// Gives an agent read (and, when explicitly enabled, write) access to Luigi's
// live, logged-in Chrome via a Chrome extension that dials the WebSocket this
// process hosts on 127.0.0.1:8765.
//
// SECURITY MODEL (matches the machine's guardrails):
//   * READ-ONLY by default. navigate/read/scroll/exec_js-read are available.
//   * WRITE actions (click_selector, type_into) are DISABLED unless the env
//     var CHROME_BRIDGE_ALLOW_WRITE=true is set. They return a clear message
//     explaining why. Enabling write is a deliberate, human decision — the
//     same rule that keeps send-capable MCPs out of detached OpenCode runs.
//   * Everything stays on loopback. Nothing here touches the network except
//     the extension's localhost WebSocket.
//
// Protocol with the extension: JSON messages on the WS.
//   Server -> SW: { id, action, params }
//   SW -> Server: { id, ok, result } | { id, ok:false, error }

const { WebSocketServer, WebSocket } = require("ws");
const { Server } = require("http");

const PORT = 8765;
const ALLOW_WRITE = process.env.CHROME_BRIDGE_ALLOW_WRITE === "true";

let bridgeSocket = null;
let pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

const httpServer = new Server();
httpServer.on("request", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, name: "chrome-bridge", connected: !!bridgeSocket, allowWrite: ALLOW_WRITE }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (socket) => {
  bridgeSocket = socket;
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (_) {
      return;
    }
    if (msg.event === "status") return;
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "browser action failed"));
    }
  });
  socket.on("close", () => {
    bridgeSocket = null;
  });
});

httpServer.listen(PORT, "127.0.0.1");

function call(action, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!bridgeSocket || bridgeSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Chrome extension not connected. Load the Chrome Bridge extension and keep a Chrome window open."));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`browser action '${action}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    bridgeSocket.send(JSON.stringify({ id, action, params }));
  });
}

function checkWrite(tool) {
  if (!ALLOW_WRITE) {
    return (
      "write action disabled — " + tool + " is gated behind CHROME_BRIDGE_ALLOW_WRITE=true " +
      "(the machine rule: write-capable browser actions stay out of unattended runs by default)."
    );
  }
  return null;
}

module.exports = { httpServer, wss, call, checkWrite, ALLOW_WRITE, getConnected: () => !!bridgeSocket };
