// Smoke test: launch the server over stdio, call tools/list, assert tool names.
//
// Listing tools never touches Chrome (the extension dials out to the bridge
// only when a tool actually runs), so this is headless-safe in CI. The live
// end-to-end check is test_ws_bridge.mjs, which needs the extension loaded
// in a real Chrome: `node test_ws_bridge.mjs` (local only).
//
// Run: node test/smoke.mjs  (exit 0 = pass)
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "chrome_get_status",
  "chrome_list_tabs",
  "chrome_read_page",
  "chrome_navigate",
  "chrome_scroll",
  "chrome_exec_js",
  "chrome_get_text_by_selector",
  "chrome_click_selector",
  "chrome_type_into",
];

async function main() {
  const serverPath = path.join(import.meta.dirname, "..", "server", "server.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client({ name: "smoke-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    console.log("tools/list ->", names.join(", "));
    const missing = EXPECTED.filter((n) => !names.includes(n));
    if (missing.length) throw new Error("missing tools: " + missing.join(", "));
    console.log("smoke PASS");
  } finally {
    await client.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("smoke FAIL:", e.message);
    process.exit(1);
  }
);
