# Demo video

The motion graphics for the main README. The whole video is one web page, `index.html`: a paused GSAP timeline drives
a Codex window and a Claude Code window side by side, with captions and a wire diagram on a card underneath. Each
frame is a pure function of time, so a headless browser can render it frame by frame.

The camera is fixed. A soft spotlight dims the window that isn't in play, and the messages fly between the windows.

| Path | What it is |
|---|---|
| `index.html` | The animation. `window.seek(t)` draws time `t`; `window.DURATION` is the length. |
| `assets/icon.svg` | The plugin icon, copied from `plugins/claude-bridge/assets/icon.svg`. |
| `assets/codex.png`, `assets/claude.png` | The Codex and Claude app icons for the window title bars, taken from the macOS ChatGPT and Claude apps and cropped to 256 px. |
| `vendor/` | GSAP 3.15 and CustomEase ([standard license](https://gsap.com/standard-license)). |
| `js/motionblur.js` | Motion blur the page draws itself, for the messages and the pulse on the wires. |
| `tools/render_stream.py` | Headless renderer: parallel workers piping frames into ffmpeg. |
| `tools/mix.py` | Mixes the music and sound effects from `sfx/cues.json` and muxes them onto the video. |

## Preview

Serve the folder and open the page:

```bash
python3 -m http.server 8790 --bind 127.0.0.1 --directory docs/demo-video
# http://127.0.0.1:8790/?play     plays it in real time, looping
# http://127.0.0.1:8790/?t=10.6   shows one moment
```

## Render

Needs Python 3.11 with `playwright`, `numpy` and `pillow` (plus `playwright install chromium`), and `ffmpeg`. With the
folder served as above:

```bash
cd docs/demo-video
python3.11 tools/render_stream.py stills --port 8790 --dir stills 3.5 6.05 10.6     # PNGs of single moments
python3.11 tools/render_stream.py video --port 8790 --workers 4 \
  --out out/codex-claude-bridge-demo-silent.mp4 --sheet out/sheet.jpg              # 1920×1080, 30 fps, silent
python3.11 tools/mix.py --mux out/codex-claude-bridge-demo-silent.mp4:out/codex-claude-bridge-demo.mp4
```

The finished video is about 4 MB, well under GitHub's 10 MB limit for videos in a README.

## Sound

`sfx/cues.json` lists every sound: when it plays, which take, its gain and why. `mix.py` lays the effects over the
music, normalizes to -16 LUFS (true peak -1.5 dB) and writes `sfx/mix.wav`.

The music and effects in `sfx/raw/` are ElevenLabs generations from a paid plan, so commercial use is covered with no
attribution. The music take resolves at 17.16 s, so one bar is played twice to land its final chord just after the
end-card title.

## Timeline

| Time | Beat |
|---|---|
| 0 – 4.6 | **Ask Codex.** The prompt is typed and sent; `list_claude_sessions` finds the `api` session. |
| 4.6 – 9.5 | **It messages Claude.** `send_to_claude` sends the question; it flies across and Claude reads `src/tokens.ts`. |
| 9.5 – 13.5 | **Claude answers.** Claude's `SendMessage` reply flies back and lands in Codex as a new turn. |
| 13.5 – 18.1 | **Codex keeps going.** Codex fixes `src/auth.ts` and the tests pass. |
| 18.1 – 23.6 | End card: the icon, the install commands and the repo. |
