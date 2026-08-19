import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:8765");
let nextId = 1;
const pending = new Map();

ws.on("open", () => {
  console.log("WS connected. Calling list_tabs...");
  call("list_tabs", {}).then((r) => {
    console.log("list_tabs RESULT:", JSON.stringify(r, null, 2));
    process.exit(0);
  }).catch((e) => {
    console.error("list_tabs ERROR:", e.message);
    process.exit(1);
  });
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

ws.on("message", (data) => {
  const msg = JSON.parse(String(data));
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || "action failed"));
  }
});

function call(action, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, timeoutMs);
    pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, action, params }));
  });
}
