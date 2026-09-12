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
//     same rule that keeps send-capable MCPs out of unattended runs by default.
//   * Everything stays on loopback. Nothing here touches the network except
//     the extension's localhost WebSocket.
//
// Protocol with the extension: JSON messages on the WS.
//   Server -> SW: { id, action, params }
//   SW -> Server: { id, ok, result } | { id, ok:false, error }
//   SW -> Server: { event: "status", connected: true, tabCount, activeUrl }
// WS clients (test scripts, automation) speak the same { id, action } dialect;
// the server remaps ids so concurrent clients can safely reuse small ids.

const { WebSocketServer, WebSocket } = require("ws");
const { Server } = require("http");

const PORT = 8765;
const WS_TIMEOUT_MS = 30000;
const ALLOW_WRITE = process.env.CHROME_BRIDGE_ALLOW_WRITE === "true";

// Extension connection (the Chrome extension dials in and identifies with a
// { event: "status" } message; see background.js sendStatus()).
let extensionSocket = null;
// serverId -> { socket, clientId, timer } for WS-forwarded requests.
const wsRoutes = new Map();
let nextId = 1;

function getMcpPending() {
  return globalThis.__chrome_bridge_mcp_pending ||
    (globalThis.__chrome_bridge_mcp_pending = new Map());
}

const httpServer = new Server();
httpServer.on("request", (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, name: "chrome-bridge", connected: !!extensionSocket, allowWrite: ALLOW_WRITE }));
});

const wss = new WebSocketServer({ server: httpServer });

function failWsRoute(serverId, errMsg) {
  const route = wsRoutes.get(serverId);
  if (!route) return;
  wsRoutes.delete(serverId);
  clearTimeout(route.timer);
  try {
    if (route.socket.readyState === WebSocket.OPEN) {
      route.socket.send(JSON.stringify({ id: route.clientId, ok: false, error: errMsg }));
    }
  } catch (_) {}
}

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (_) {
      return;
    }

    // Extension identifies itself with "status" events
    if (msg.event === "status") {
      extensionSocket = socket;
      return;
    }

    // Response (has id, no action): only the extension should send these.
    if (msg.id !== undefined && msg.action === undefined) {
      if (socket !== extensionSocket) return;
      // stdio/MCP direct calls first (shared id space, so no collision)
      const mcpPending = globalThis.__chrome_bridge_mcp_pending;
      if (mcpPending && mcpPending.has(msg.id)) {
        const p = mcpPending.get(msg.id);
        mcpPending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "browser action failed"));
        return;
      }
      // WS-forwarded calls: route back to the originating socket + client id
      const route = wsRoutes.get(msg.id);
      if (!route) return;
      wsRoutes.delete(msg.id);
      clearTimeout(route.timer);
      const reply = { id: route.clientId, ok: !!msg.ok };
      if (msg.result !== undefined) reply.result = msg.result;
      if (msg.error !== undefined) reply.error = msg.error;
      if (!msg.ok && reply.error === undefined) reply.error = "browser action failed";
      try {
        if (route.socket.readyState === WebSocket.OPEN) {
          route.socket.send(JSON.stringify(reply));
        }
      } catch (_) {}
      return;
    }

    // Request from a WS client (has id and action): forward to extension
    // with a server-allocated id so concurrent clients can reuse ids safely.
    if (msg.id !== undefined && msg.action !== undefined) {
      if (socket === extensionSocket) return; // extension never issues actions
      if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: msg.id, ok: false, error: "Chrome extension not connected" }));
        return;
      }
      const serverId = nextId++;
      const timer = setTimeout(() => {
        failWsRoute(serverId, `browser action '${msg.action}' timed out after ${WS_TIMEOUT_MS}ms`);
      }, WS_TIMEOUT_MS);
      wsRoutes.set(serverId, { socket, clientId: msg.id, timer });
      try {
        extensionSocket.send(JSON.stringify({ id: serverId, action: msg.action, params: msg.params }));
      } catch (e) {
        failWsRoute(serverId, String((e && e.message) || e));
      }
      return;
    }
  });

  socket.on("close", () => {
    if (socket === extensionSocket) {
      extensionSocket = null;
      // Fail everything waiting on the dead extension so callers time out fast
      // with a clear cause instead of hanging to their own timeout.
      const mcpPending = globalThis.__chrome_bridge_mcp_pending;
      if (mcpPending) {
        for (const [, p] of mcpPending.entries()) {
          p.reject(new Error("Chrome extension disconnected"));
        }
        mcpPending.clear();
      }
      for (const serverId of [...wsRoutes.keys()]) {
        failWsRoute(serverId, "Chrome extension disconnected");
      }
    } else {
      // Client gone: drop its routes (timers cleared, no reply possible).
      for (const [serverId, route] of [...wsRoutes.entries()]) {
        if (route.socket === socket) {
          wsRoutes.delete(serverId);
          clearTimeout(route.timer);
        }
      }
    }
  });
});

httpServer.listen(PORT, "127.0.0.1");

function call(action, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // This function is used by the MCP server (stdio transport).
    // It sends via the extension socket directly, sharing the id space
    // with WS-forwarded requests so replies route unambiguously.
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Chrome extension not connected. Load the Chrome Bridge extension and keep a Chrome window open."));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      getMcpPending().delete(id);
      reject(new Error(`browser action '${action}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    getMcpPending().set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    try {
      extensionSocket.send(JSON.stringify({ id, action, params }));
    } catch (e) {
      getMcpPending().delete(id);
      clearTimeout(timer);
      reject(e);
    }
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

module.exports = { httpServer, wss, call, checkWrite, ALLOW_WRITE, getConnected: () => !!extensionSocket };
