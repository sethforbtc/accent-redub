// Service worker: talks to the local server and relays audio commands to the
// offscreen document (which plays audio outside the page, so page CSP and
// autoplay rules don't get in the way).

import { DEFAULTS } from "./defaults.js";

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play re-voiced narration in sync with the video",
    });
  } catch (e) {
    if (!String(e).includes("single offscreen")) throw e; // raced with another call
  }
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
}

async function api({ method = "GET", path, body }) {
  const { server } = await settings();
  const res = await fetch(server + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const run = async () => {
    if (msg.type === "bg:api") return api(msg);
    if (msg.type === "bg:settings") return settings();
    if (msg.type === "bg:audio") {
      await ensureOffscreen();
      const { server } = await settings();
      return chrome.runtime.sendMessage({ ...msg.payload, target: "offscreen", server });
    }
  };
  if (!String(msg.type).startsWith("bg:")) return false;
  run().then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: String(err?.message || err) })
  );
  return true; // async response
});
