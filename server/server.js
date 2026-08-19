// Chrome Bridge — MCP server entrypoint (stdio).
// Run by OpenCode/Claude Code. Spawns the loopback WS listener and exposes
// browser tools. READ-ONLY by default; see bridge.js for the write gate.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const bridge = require("./bridge.js");

const server = new McpServer({
  name: "chrome-bridge",
  version: "1.0.0",
  instructions: (
    "Drive Luigi's live, logged-in Chrome browser. Read actions work out of the box " +
    "(list_tabs, read_page, navigate, scroll, exec_js, get_text_by_selector). " +
    "click_selector / type_into are DISABLED unless CHROME_BRIDGE_ALLOW_WRITE=true " +
    "— they exist for the interactive Claude session, not for unattended runs. " +
    "Always prefer read_page over exec_js. The extension dials ws://127.0.0.1:8765; " +
    "if a tool errors with 'extension not connected', a Chrome window must be open " +
    "with the Chrome Bridge extension loaded."
  ),
});

server.tool(
  "chrome_get_status",
  "Check whether the Chrome Bridge extension is connected and whether write actions are enabled.",
  {},
  async () => {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          connected: bridge.getConnected(),
          allowWrite: bridge.ALLOW_WRITE,
          server: "ws://127.0.0.1:8765",
        }, null, 2),
      }],
    };
  }
);

server.tool(
  "chrome_list_tabs",
  "List open Chrome tabs (id, title, url, active). Use to find the tab to read.",
  {},
  async () => {
    try {
      const result = await bridge.call("list_tabs");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_read_page",
  "Read the visible text of the active Chrome tab. Returns url, title and up to 200KB of text. This is the primary 'read a blocked site' tool (X/Twitter, LinkedIn, etc. work if already logged in).",
  {},
  async () => {
    try {
      const result = await bridge.call("read_page");
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_navigate",
  "Open a URL in the active Chrome tab (creates a new tab if the active one is a chrome:// page).",
  { url: z.string().describe("Full URL to navigate to") },
  async ({ url }) => {
    try {
      const result = await bridge.call("navigate", { url });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_scroll",
  "Scroll the active tab. direction: up|down|top|bottom; amount: pixels for up/down (default 600).",
  {
    direction: z.enum(["up", "down", "top", "bottom"]).default("down").describe("Scroll direction"),
    amount: z.number().default(600).describe("Pixels to scroll for up/down"),
  },
  async ({ direction, amount }) => {
    try {
      const result = await bridge.call("scroll", { direction, amount });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_exec_js",
  "Run a small piece of JavaScript in the active tab and return its result (stringified). Prefer read_page; use this only for structured extraction a page selector can't capture.",
  { code: z.string().describe("JavaScript source; the last expression's value is returned") },
  async ({ code }) => {
    try {
      const result = await bridge.call("exec_js", { code });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_get_text_by_selector",
  "Return the text of all elements matching a CSS selector in the active tab (e.g. 'article', '.post-content'). Useful for grabbing a specific section without the whole page.",
  { selector: z.string().describe("CSS selector") },
  async ({ selector }) => {
    try {
      const result = await bridge.call("get_text_by_selector", { selector });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_click_selector",
  "Click the first element matching a CSS selector in the active tab. WRITE ACTION — disabled unless CHROME_BRIDGE_ALLOW_WRITE=true.",
  { selector: z.string().describe("CSS selector of the element to click") },
  async ({ selector }) => {
    const blocked = bridge.checkWrite("chrome_click_selector");
    if (blocked) return { content: [{ type: "text", text: "BLOCKED: " + blocked }], isError: true };
    try {
      const result = await bridge.call("click_selector", { selector });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

server.tool(
  "chrome_type_into",
  "Type a value into the input matching a CSS selector in the active tab (dispatches input+change events). WRITE ACTION — disabled unless CHROME_BRIDGE_ALLOW_WRITE=true.",
  {
    selector: z.string().describe("CSS selector of the input/textarea"),
    value: z.string().describe("Text to type"),
  },
  async ({ selector, value }) => {
    const blocked = bridge.checkWrite("chrome_type_into");
    if (blocked) return { content: [{ type: "text", text: "BLOCKED: " + blocked }], isError: true };
    try {
      const result = await bridge.call("type_into", { selector, value });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: "ERROR: " + e.message }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("[chrome-bridge] fatal:", e);
  process.exit(1);
});
