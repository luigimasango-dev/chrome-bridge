// Regression test for issue #2: `list_tabs` over WS timed out while connected:true.
//
// Cause: the server never routed WS responses back to the WS requester —
// client {id,action} requests were forwarded (or dropped) but the reply path
// only resolved internal MCP promises, so the WS client hung to timeout.
//
// This test is headless-safe (no Chrome): it spawns the real bridge server,
// connects a fake extension (identifies via {event:"status"}) plus real WS
// clients, and asserts a full list_tabs round-trip. It FAILS on the pre-fix
// server (client times out) and PASSES with the routing fix. It also runs two
// clients with the SAME id concurrently to prove server-side id remapping.
//
// Run: node test/ws_routing.mjs  (exit 0 = pass)
// Env: BRIDGE_PORT defaults to 8765. Fails fast if the port is already in use
// (stop any real bridge first) so results are never ambiguous.

import { spawn } from "node:child_process";
import path from "node:path";
import http from "node:http";
import WebSocket from "ws";

const PORT = Number(process.env.BRIDGE_PORT || 8765);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const TIMEOUT_MS = 8000;

function httpHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
  });
}

function waitFor(cond, { timeout = 10000, step = 150, label = "condition" } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await cond()) return resolve();
      } catch (_) {}
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, step);
    };
    tick();
  });
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function clientCall(ws, id, action, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error(`client timed out waiting for reply to '${action}' (id ${id}) — routing bug present`));
    }, TIMEOUT_MS);
    function onMsg(data) {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.id !== id || msg.action !== undefined) return;
      clearTimeout(timer);
      ws.off("message", onMsg);
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error || "browser action failed"));
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ id, action, params }));
  });
}

async function main() {
  // Refuse to run against a live bridge — results would be ambiguous.
  const pre = await httpHealth();
  if (!pre.error) {
    throw new Error(`port ${PORT} already serves (stop the real bridge first): ${pre.body}`);
  }

  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(path.join(REPO_ROOT, "server", "bridge.js"))})`], {
    cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  let childOut = "";
  child.stdout.on("data", (c) => { childOut += c; });
  child.stderr.on("data", (c) => { childOut += c; });
  const killChild = () => { try { child.kill(); } catch (_) {} };

  try {
    await waitFor(async () => !(await httpHealth()).error, { timeout: 10000, label: "bridge HTTP health" });
    const health = await httpHealth();
    const parsed = JSON.parse(health.body);
    if (parsed.connected) throw new Error("expected connected:false before fake extension identifies");

    // Fake extension: connect + identify via status event, like background.js.
    const ext = await connectWs();
    ext.send(JSON.stringify({ event: "status", connected: true, tabCount: 2, activeUrl: "https://example.com" }));
    await waitFor(async () => {
      const h = await httpHealth();
      try { return h.body && JSON.parse(h.body).connected === true; } catch { return false; }
    }, { timeout: 5000, label: "extension registration (connected:true)" });

    // Fake extension behaviour: answer any {id,action} with a canned result,
    // echoing the SERVER-allocated id (not the client's) — the server must
    // remap it back to the client's id on the right socket.
    const FAKE_TABS = [{ id: 11, title: "Example", url: "https://example.com", active: true }];
    ext.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.id === undefined || msg.action === undefined) return;
      const result = msg.action === "list_tabs" ? FAKE_TABS : { echo: msg.action };
      ext.send(JSON.stringify({ id: msg.id, ok: true, result }));
    });

    // Phase 1: single list_tabs round-trip (the exact issue #2 repro shape).
    const client = await connectWs();
    const tabs = await clientCall(client, 1, "list_tabs", {});
    if (!Array.isArray(tabs) || tabs.length !== 1 || tabs[0].url !== "https://example.com") {
      throw new Error("unexpected list_tabs result: " + JSON.stringify(tabs));
    }
    console.log("phase 1 PASS: list_tabs round-trip returned", JSON.stringify(tabs));

    // Phase 2: two clients, SAME id, concurrent — proves id remapping.
    const cA = await connectWs();
    const cB = await connectWs();
    const [rA, rB] = await Promise.all([
      clientCall(cA, 7, "list_tabs", {}),
      clientCall(cB, 7, "list_tabs", {}),
    ]);
    if (JSON.stringify(rA) !== JSON.stringify(FAKE_TABS) || JSON.stringify(rB) !== JSON.stringify(FAKE_TABS)) {
      throw new Error("concurrent same-id round-trip mismatch");
    }
    console.log("phase 2 PASS: two clients with id=7 both routed correctly");

    for (const ws of [client, cA, cB, ext]) { try { ws.close(); } catch (_) {} }
    console.log("ws_routing PASS (issue #2 regression covered)");
  } finally {
    killChild();
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error("ws_routing FAIL:", e.message); process.exit(1); },
);
