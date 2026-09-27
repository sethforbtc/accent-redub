import { DEFAULTS } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const fmt = { maxSpeed: (v) => `${(+v).toFixed(2)}×`, volume: (v) => `${Math.round(v * 100)}%`, lookahead: (v) => `${v}s` };
let settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
let running = false;
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set(patch);
}

// ----- controls -----
for (const id of ["mode", "server"]) {
  $(id).value = settings[id];
  $(id).addEventListener("change", () => save({ [id]: $(id).value.trim() }));
}
for (const id of ["maxSpeed", "volume", "lookahead"]) {
  $(id).value = settings[id];
  $(id + "-v").textContent = fmt[id](settings[id]);
  $(id).addEventListener("input", () => ($(id + "-v").textContent = fmt[id]($(id).value)));
  $(id).addEventListener("change", () => save({ [id]: +$(id).value }));
}
for (const id of ["showText", "waitForAudio"]) {
  $(id).checked = settings[id];
  $(id).addEventListener("change", () => save({ [id]: $(id).checked }));
}
$("voice").addEventListener("change", () => save({ voice: $("voice").value }));

// ----- server + voices -----
async function loadVoices() {
  try {
    const r = await fetch(settings.server + "/voices");
    const { backend, voices } = await r.json();
    $("dot").className = "dot on";
    $("server-state").textContent = `Local server online (${backend})`;
    const sel = $("voice");
    sel.replaceChildren();
    const groups = {};
    for (const v of voices) {
      groups[v.accent] ??= sel.appendChild(Object.assign(document.createElement("optgroup"), { label: `${v.accent} English` }));
      groups[v.accent].append(new Option(v.label, v.id));
    }
    sel.value = settings.voice;
  } catch {
    $("dot").className = "dot off";
    $("server-state").textContent = "Local server offline — run server/app.py";
    $("voice").replaceChildren(new Option(settings.voice, settings.voice));
  }
}

// ----- start / stop -----
function setRunning(on, status = "") {
  running = on;
  $("toggle").textContent = on ? "Stop re-dub" : "Re-dub this video";
  $("toggle").className = on ? "stop" : "";
  $("status").textContent = status;
}

async function ping() {
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "redub:ping" });
    if (r) setRunning(r.running, r.status);
  } catch {
    setRunning(false); // content script not injected yet
  }
}

$("toggle").addEventListener("click", async () => {
  try {
    if (running) {
      await chrome.tabs.sendMessage(tab.id, { type: "redub:stop" });
      return setRunning(false);
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    const r = await chrome.tabs.sendMessage(tab.id, { type: "redub:start" });
    if (!r) setRunning(false, "No video found on this page.");
    else if (!r.ok) setRunning(false, r.error);
    else setRunning(true, "Started — watch the badge on the video.");
  } catch (e) {
    setRunning(false, "Can't run here: " + e.message);
  }
});

loadVoices();
ping();
