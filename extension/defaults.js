// Shared settings defaults (used by background and popup).
export const DEFAULTS = {
  server: "http://127.0.0.1:8765",
  voice: "af_heart",
  mode: "auto",        // auto | captions | whisper
  maxSpeed: 1.35,      // most we'll speed a clip up to fit its slot
  lookahead: 45,       // seconds of speech to prepare ahead of the playhead
  volume: 1,
  showText: true,
  waitForAudio: true,  // pause the video briefly if speech isn't ready yet
};
