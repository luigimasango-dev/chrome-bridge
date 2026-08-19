# Chrome Bridge — browser control for OpenCode & Claude Code

Lets agents drive Luigi's **live, logged-in Chrome** — which is what makes
blocked sites readable: X/Twitter, LinkedIn, Reddit, and anything else that
refuses WebFetch/scraping works because it runs in a real logged-in browser.

Built 2026-08-04. Claude Code already had browser control (Claude in Chrome);
this closes the same gap for OpenCode, which previously had no browser tool at
all (`custom-scraper` is plain HTTP and can't see behind a login).

## Architecture

```
OpenCode / Claude Code
        │  (MCP stdio)
        ▼
server/server.js ── owns a WebSocket on ws://127.0.0.1:8765
        │  (JSON {id, action, params} → {id, ok, result})
        ▼
extension/background.js (service worker) → content.js injected per tab → DOM
```

The extension cannot listen on a port (MV3), so the **MCP server owns the
socket** and the extension dials out to it. Keep one Chrome window open and
the extension loaded, and agents can read/navigate it.

## Security model

- **Read-only by default.** `chrome_list_tabs`, `chrome_read_page`,
  `chrome_navigate`, `chrome_scroll`, `chrome_exec_js`,
  `chrome_get_text_by_selector` all work out of the box.
- **Write actions are gated.** `chrome_click_selector` and `chrome_type_into`
  return `BLOCKED:` unless `CHROME_BRIDGE_ALLOW_WRITE=true`. This matches the
  machine rule: write-capable tools stay out of unattended OpenCode runs.
  opencode.jsonc explicitly sets it to `false`. Only enable it for an
  interactive Claude session, deliberately.
- **Loopback only.** Nothing here touches the network except the extension's
  connection to `ws://127.0.0.1:8765`.

## Install (one-time, Luigi's hands)

1. **Chrome:** open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select `C:\Dev\chrome-bridge\extension`
4. Pin the extension if you like; the badge shows `ON` when the bridge is up.
5. Keep at least one normal Chrome window open while agents need the browser.

The MCP server is already registered in `~/.config/opencode/opencode.jsonc`
(`chrome-bridge`). Restart OpenCode to load it.

## Tools

| Tool | What it does | Write? |
|---|---|---|
| `chrome_get_status` | connected? write enabled? | — |
| `chrome_list_tabs` | all open tabs (id, title, url) | — |
| `chrome_read_page` | visible text of active tab (≤200KB) | — |
| `chrome_navigate` | open a URL in active tab | read |
| `chrome_scroll` | up/down/top/bottom | read |
| `chrome_get_text_by_selector` | text of all nodes matching a CSS selector | read |
| `chrome_exec_js` | run JS in active tab | read |
| `chrome_click_selector` | click first match | **gated** |
| `chrome_type_into` | type into input (input+change events) | **gated** |

## Manual smoke test (without OpenCode)

```powershell
# Terminal 1 — start the server
cd C:\Dev\chrome-bridge; node server/server.js

# Terminal 2 — check the loopback endpoint
Invoke-RestMethod http://127.0.0.1:8765/
# → {"ok":true,"name":"chrome-bridge","connected":false,"allowWrite":false}
```

`connected: true` appears once the extension is loaded in a Chrome window.

## Files

- `extension/` — MV3 extension (manifest, background SW, content script, popup)
- `server/bridge.js` — WS host + request routing + write gate
- `server/server.js` — MCP stdio entrypoint (SDK 1.30, Zod schemas)
