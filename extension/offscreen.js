// Offscreen document: fetches synthesized clips from the local server, caches
// them, and plays them with pitch-preserving speed-up.

const clips = new Map(); // key -> Promise<{ url, duration }>
let current = null;      // { audio, finish }

function b64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

function load({ key, text, voice, server }) {
  if (!clips.has(key)) {
    const p = fetch(server + "/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((j) => ({ url: b64ToBlobUrl(j.audio_b64), duration: j.duration }));
    p.catch(() => clips.delete(key)); // allow retry
    clips.set(key, p);
  }
  return clips.get(key);
}

function stop(reason = "stopped") {
  if (current) current.finish(reason);
}

async function play(msg) {
  stop();
  const clip = await load(msg);
  const audio = new Audio(clip.url);
  audio.preservesPitch = true;
  audio.volume = Math.max(0, Math.min(1, msg.volume ?? 1));
  await new Promise((res, rej) => {
    audio.addEventListener("loadedmetadata", res, { once: true });
    audio.addEventListener("error", () => rej(new Error("audio decode failed")), { once: true });
  });
  audio.currentTime = Math.min(msg.offset || 0, Math.max(0, audio.duration - 0.05));
  audio.playbackRate = msg.rate || 1;

  return new Promise((resolve) => {
    const me = {
      audio,
      finish(reason) {
        audio.pause();
        audio.onended = null;
        if (current === me) current = null;
        resolve({ reason });
      },
    };
    current = me;
    audio.onended = () => me.finish("ended");
    audio.play().catch((e) => me.finish("error: " + e.message));
  });
}

function evict(keep) {
  const keepSet = new Set(keep);
  for (const [key, p] of clips) {
    if (keepSet.has(key)) continue;
    clips.delete(key);
    p.then((c) => URL.revokeObjectURL(c.url), () => {});
  }
}

const handlers = {
  "audio:load": (m) => load(m).then((c) => ({ duration: c.duration })),
  "audio:play": play,
  "audio:stop": () => (stop(), {}),
  "audio:pause": () => (current?.audio.pause(), {}),
  "audio:resume": () => (current?.audio.play().catch(() => {}), {}),
  "audio:rate": (m) => {
    if (current) current.audio.playbackRate = m.rate;
    return {};
  },
  "audio:volume": (m) => {
    if (current) current.audio.volume = m.volume;
    return {};
  },
  "audio:evict": (m) => (evict(m.keep || []), {}),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen" || !handlers[msg.type]) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg))
    .then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
