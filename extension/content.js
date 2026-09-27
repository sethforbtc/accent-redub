// Content script: injected on demand by the popup (into every frame, so it also
// works with players embedded in iframes). Mutes the video and plays the
// re-voiced narration in sync with it.
(() => {
  if (window.__accentRedub) return;
  window.__accentRedub = true;

  const MAX_LAG = 2.5; // seconds behind the video before we cut a clip short
  const TICK_MS = 80;

  // ---------- messaging ----------
  async function bg(type, extra = {}) {
    const res = await chrome.runtime.sendMessage({ type, ...extra });
    if (!res?.ok) throw new Error(res?.error || "extension error");
    if (res.data?.error) throw new Error(res.data.error);
    return res.data;
  }
  const api = (method, path, body) => bg("bg:api", { method, path, body });
  const audio = (payload) => bg("bg:audio", { payload });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- page helpers ----------
  function findVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && (v.readyState > 0 || v.src || v.currentSrc)) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function pageUrl() {
    const u = new URL(location.href);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const id = u.searchParams.get("v") || u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/)?.[1];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname === "youtu.be") return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    return u.href;
  }

  // Captions exposed by the HTML5 player itself (<track> elements).
  async function readPageCues(video) {
    const tracks = [...video.textTracks].filter(
      (t) => ["captions", "subtitles"].includes(t.kind) && (!t.language || t.language.startsWith("en"))
    );
    for (const t of tracks) {
      const prev = t.mode;
      if (prev === "disabled") t.mode = "hidden";
      for (let i = 0; i < 30 && !(t.cues && t.cues.length); i++) await sleep(100);
      const cues = t.cues ? [...t.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: c.text })) : [];
      t.mode = prev;
      if (cues.length > 5) return cues;
    }
    return null;
  }

  // ---------- overlay ----------
  class Overlay {
    constructor(video) {
      this.video = video;
      this.root = document.createElement("div");
      Object.assign(this.root.style, {
        position: "fixed", zIndex: 2147483647, pointerEvents: "none",
        font: "13px/1.35 system-ui, sans-serif", color: "#fff",
      });
      this.pill = document.createElement("div");
      Object.assign(this.pill.style, {
        position: "absolute", top: "8px", left: "8px", padding: "4px 10px",
        background: "rgba(20,20,30,.78)", borderRadius: "999px", whiteSpace: "nowrap",
      });
      this.caption = document.createElement("div");
      Object.assign(this.caption.style, {
        position: "absolute", left: "10%", right: "10%", bottom: "14%", textAlign: "center",
        fontSize: "17px", display: "none",
      });
      this.captionText = document.createElement("span");
      Object.assign(this.captionText.style, {
        background: "rgba(0,0,0,.72)", padding: "3px 8px", borderRadius: "4px",
        boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone",
      });
      this.caption.append(this.captionText);
      this.root.append(this.pill, this.caption);
      this.mount();
      this.onFs = () => this.mount();
      document.addEventListener("fullscreenchange", this.onFs);
    }
    mount() { (document.fullscreenElement || document.body).append(this.root); this.place(); }
    place() {
      const r = this.video.getBoundingClientRect();
      Object.assign(this.root.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    }
    status(text) { this.pill.textContent = "🗣 " + text; }
    text(t) {
      this.caption.style.display = t ? "block" : "none";
      this.captionText.textContent = t || "";
    }
    remove() { document.removeEventListener("fullscreenchange", this.onFs); this.root.remove(); }
  }

  // ---------- the re-dub session ----------
  class Session {
    constructor(video, settings) {
      this.video = video;
      this.s = settings;
      this.id = Math.random().toString(36).slice(2, 8);
      this.url = pageUrl();
      this.segments = [];
      this.clips = new Map();  // idx -> "loading" | { duration } | "error"
      this.inflight = 0;
      this.current = null;     // { idx, token, fit }
      this.lastPlayed = -1;
      this.token = 0;
      this.pausedByUs = false;
      this.stopped = false;
      this.overlay = new Overlay(video);
      this.label = "";
    }

    key(idx) { return `${this.id}|${this.s.voice}|${idx}`; }

    async start() {
      try {
        return await this.startInner();
      } catch (e) {
        this.overlay.status("Error: " + e.message);
        return false;
      }
    }

    async startInner() {
      const o = this.overlay;
      try {
        o.status("Connecting to local server…");
        await api("GET", "/health");
      } catch {
        o.status("Local server not running — start server/app.py");
        return false;
      }

      o.status("Reading captions…");
      const onYouTube = this.url.startsWith("https://www.youtube.com/watch");
      const cues = this.s.mode === "whisper" || onYouTube ? null : await readPageCues(this.video);

      let job = await api("POST", "/jobs", { url: this.url, cues, mode: this.s.mode });
      while (job.status === "running" && !this.stopped) {
        o.status(`${job.message} (${Math.round(job.progress * 100)}%)`);
        await sleep(700);
        job = await api("GET", `/jobs/${job.id}`);
      }
      if (this.stopped) return false;
      if (job.status !== "done") {
        o.status("Failed: " + job.message);
        return false;
      }
      this.segments = job.segments;
      this.label = `${this.s.voice} · ${job.source}`;
      o.status(this.label);

      this.wasMuted = this.video.muted;
      this.video.muted = true;
      this.listen();
      this.timer = setInterval(() => this.tick().catch((e) => console.warn("[redub]", e)), TICK_MS);
      return true;
    }

    listen() {
      const v = this.video;
      this.handlers = {
        seeking: () => this.cut(true),
        pause: () => { if (!this.pausedByUs) audio({ type: "audio:pause" }).catch(() => {}); },
        play: () => { if (this.current) audio({ type: "audio:resume" }).catch(() => {}); },
        ratechange: () => {
          if (this.current) audio({ type: "audio:rate", rate: this.current.fit * v.playbackRate }).catch(() => {});
        },
        volumechange: () => { if (!v.muted && !this.stopped) v.muted = true; }, // player un-muted itself
      };
      for (const [ev, fn] of Object.entries(this.handlers)) v.addEventListener(ev, fn);
    }

    // Index of the last segment that starts at or before t.
    indexAt(t) {
      let lo = 0, hi = this.segments.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.segments[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    slotEnd(idx) {
      const next = this.segments[idx + 1];
      return next ? next.start : this.segments[idx].end + 1.5;
    }

    prefetch(t) {
      const from = Math.max(0, this.indexAt(t));
      for (let i = from; i < this.segments.length && this.inflight < 2; i++) {
        if (this.segments[i].start > t + this.s.lookahead) break;
        if (this.clips.has(i)) continue;
        this.clips.set(i, "loading");
        this.inflight++;
        const key = this.key(i);
        const current = () => key === this.key(i); // ignore results for a voice we switched away from
        audio({ type: "audio:load", key, text: this.segments[i].text, voice: this.s.voice })
          .then((r) => current() && this.clips.set(i, { duration: r.duration }))
          .catch((e) => { console.warn("[redub] tts failed", e); if (current()) this.clips.set(i, "error"); })
          .finally(() => this.inflight--);
      }
    }

    // Free clips far from the playhead so long videos don't eat memory.
    evictFar(t) {
      const now = Date.now();
      if (now - (this.lastEvict || 0) < 30000) return;
      this.lastEvict = now;
      const keep = [];
      for (const [i, c] of this.clips) {
        const st = this.segments[i].start;
        if (st > t - 30 && st < t + this.s.lookahead + 30) keep.push(this.key(i));
        else if (c !== "loading") this.clips.delete(i);
      }
      audio({ type: "audio:evict", keep }).catch(() => {});
    }

    async tick() {
      if (this.stopped) return;
      const v = this.video;
      const t = v.currentTime;
      this.overlay.place();
      if (pageUrl() !== this.url) return restart(); // YouTube navigated to a new video
      this.prefetch(t);
      this.evictFar(t);
      if (v.paused && !this.pausedByUs) return;

      const idx = this.indexAt(t);
      if (idx < 0) return;
      const seg = this.segments[idx];

      if (this.current) {
        if (this.current.idx === idx) return;
        // Previous sentence still talking past its slot: let it finish unless we're far behind.
        if (t - seg.start > MAX_LAG) this.cut(false);
        return;
      }
      if (this.lastPlayed === idx) return;
      if (t > this.slotEnd(idx) + 0.5) return; // already past this one

      const clip = this.clips.get(idx);
      if (clip === "error") { this.lastPlayed = idx; return; }
      if (!clip || clip === "loading") {
        if (this.s.waitForAudio && !v.paused) {
          this.pausedByUs = true;
          v.pause();
          this.overlay.status("Buffering voice…");
        }
        return;
      }
      if (this.pausedByUs) {
        this.pausedByUs = false;
        this.overlay.status(this.label);
        v.play().catch(() => {});
        return; // next tick plays it
      }
      this.play(idx, t, clip.duration);
    }

    async play(idx, t, duration) {
      const seg = this.segments[idx];
      const elapsed = Math.max(0, t - seg.start);
      const sequential = this.lastPlayed === idx - 1 && elapsed < MAX_LAG;
      let offset, fit;
      if (sequential) {
        // Picking up right after the previous sentence: say it all, squeezed into what's left.
        offset = 0;
        fit = duration / Math.max(0.4, this.slotEnd(idx) - t);
      } else {
        // Joined mid-sentence (e.g. after a seek): jump into the clip proportionally.
        fit = duration / Math.max(0.4, this.slotEnd(idx) - seg.start);
        offset = elapsed * Math.min(Math.max(fit, 1), this.s.maxSpeed);
      }
      fit = Math.min(Math.max(fit, 1), this.s.maxSpeed);
      if (offset >= duration - 0.1) { this.lastPlayed = idx; return; }

      const token = ++this.token;
      this.current = { idx, token, fit };
      this.lastPlayed = idx;
      if (this.s.showText) this.overlay.text(seg.text);
      try {
        await audio({
          type: "audio:play", key: this.key(idx), text: seg.text, voice: this.s.voice,
          offset, rate: fit * this.video.playbackRate, volume: this.s.volume,
        });
      } catch (e) {
        console.warn("[redub] play failed", e);
      }
      if (this.current?.token === token) {
        this.current = null;
        this.overlay.text("");
      }
    }

    cut(isSeek) {
      this.current = null;
      this.overlay.text("");
      audio({ type: "audio:stop" }).catch(() => {});
      if (isSeek) this.lastPlayed = -1;
    }

    applySettings(next) {
      const voiceChanged = next.voice !== this.s.voice;
      this.s = next;
      if (voiceChanged) {
        this.clips.clear();
        this.label = `${next.voice} · ${this.label.split(" · ")[1] || ""}`;
        this.overlay.status(this.label);
        this.cut(true);
      }
      if (!next.showText) this.overlay.text("");
      audio({ type: "audio:volume", volume: next.volume }).catch(() => {});
    }

    stop() {
      this.stopped = true;
      clearInterval(this.timer);
      for (const [ev, fn] of Object.entries(this.handlers || {})) this.video.removeEventListener(ev, fn);
      if (this.wasMuted !== undefined) this.video.muted = this.wasMuted;
      if (this.pausedByUs) this.video.play().catch(() => {});
      audio({ type: "audio:stop" }).catch(() => {});
      audio({ type: "audio:evict", keep: [] }).catch(() => {});
      this.overlay.remove();
    }
  }

  // ---------- control ----------
  let session = null;

  async function start() {
    const video = findVideo();
    if (!video) return { ok: false, error: "No video found in this frame" };
    if (session) session.stop();
    const settings = await bg("bg:settings");
    session = new Session(video, settings);
    const s = session;
    s.start().then((ok) => {
      if (!ok && session === s) setTimeout(() => { if (session === s) stopSession(); }, 6000);
    });
    return { ok: true };
  }

  function stopSession() {
    if (session) session.stop();
    session = null;
  }

  function restart() {
    stopSession();
    setTimeout(start, 1500); // give the new video a moment to load
  }

  chrome.storage.onChanged.addListener(async () => {
    if (session) session.applySettings(await bg("bg:settings"));
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Frames without a video stay silent so the frame that has one answers.
    if (!findVideo() && !session) return false;
    if (msg.type === "redub:ping") {
      sendResponse({ running: !!session, status: session?.overlay.pill.textContent || "" });
    } else if (msg.type === "redub:start") {
      start().then(sendResponse);
      return true;
    } else if (msg.type === "redub:stop") {
      stopSession();
      sendResponse({ ok: true });
    }
    return false;
  });
})();
