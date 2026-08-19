const statusEl = document.getElementById("status");
const tabEl = document.getElementById("tab");

function refresh() {
  const query = { active: true, lastFocusedWindow: true };
  chrome.tabs.query(query, (tabs) => {
    const t = tabs && tabs[0];
    if (t) {
      tabEl.textContent = (t.title || t.url || "—").slice(0, 40);
    } else {
      tabEl.textContent = "—";
    }
  });
  // Ask the service worker whether it's connected.
  chrome.runtime.sendMessage({ ping: true }, (resp) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "offline";
      statusEl.className = "badge err";
      return;
    }
    if (resp && resp.connected) {
      statusEl.textContent = "connected";
      statusEl.className = "badge ok";
    } else {
      statusEl.textContent = "no server";
      statusEl.className = "badge err";
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "bridge-status") {
    statusEl.textContent = msg.connected ? "connected" : "no server";
    statusEl.className = "badge " + (msg.connected ? "ok" : "err");
  }
});

refresh();
setInterval(refresh, 2000);
