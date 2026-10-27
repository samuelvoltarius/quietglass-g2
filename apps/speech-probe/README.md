# Speech Probe (private test app)

`glass.quiet.speechprobe` · 0.1.0 · not for the store.

Answers one question on the real iPhone + G2: **can Quietglass voice apps work without our own
Whisper server?**

- **Test A – platform speech recognition.** Is `SpeechRecognition` / `webkitSpeechRecognition`
  usable inside the Even app WebView (phone microphone)? Reports availability, permission state,
  event sequence, result text, exact error names (`not-allowed`, `service-not-allowed`, `network`, …),
  `navigator.userAgent` and the `speechSynthesis` voices (count + languages).
- **Test B – on-device Whisper.** 5 s from the **glasses** microphone
  (`audioControl(true, AudioInputSource.Glasses)`, `audioEvent.audioPcm` read as 16 kHz s16le mono),
  transcribed in the WebView with transformers.js (`Xenova/whisper-tiny` or `whisper-base`,
  WebGPU if available, else WASM). Reports model size, bytes transferred, fetch/session/total load time,
  transcription time, real-time factor, text, measured samples/s and `speakerRole` shares.

## How to run each test

1. Install the private build (see below) and open Speech Probe from the Even app.
2. **Test A:** on the phone page choose the language, press **Start test A**, speak one sentence.
   Then press **Prompt seen: yes/no**. If the Even app is killed by iOS at that moment, that is the
   answer (the step log then shows `testAStart` without `testA`).
3. **Test B:** on the glasses swipe to **Test B** and tap (or press **Start test B** on the phone).
   Speak for 5 s; the glasses show `transcribing…`, then the text and timing. Tap again for warm numbers
   (model stays in memory). 2× = back; 2× on the start screen = system exit dialog.
4. **Copy results** puts both tables as plain text on the clipboard (or selects them in a text box).

Phone settings: language de/en (both tests), model, backend (auto/WebGPU/WASM) and where the ONNX
runtime comes from (app package or cdn.jsdelivr.net; fixed by the first test B of an app run).

## Step log

With `VITE_TRAFFIC_URL` set at build time every result goes to the private step log (`app: "speech-probe"`):
`testAStart`, `testA`, `testAPrompt`, `testBStart`, `testB` – one event per test with all numbers,
never audio (the first microphone frame is logged by its shape only). Its origin must also be in the
whitelist of the private manifest (`app.private.json`, gitignored).

## Network whitelist (app.json)

| Origin | Why |
|---|---|
| `https://huggingface.co` | model files (`/<model>/resolve/main/…`; small JSON files redirect on the same host) |
| `https://us.aws.cdn.hf.co` | ONNX weights: 302 target of the Xet CDN (seen from Austria, 23.10.2026) |
| `https://cas-bridge.xethub.hf.co`, `https://cdn-lfs.hf.co` | older Hugging Face CDN hosts, in case of a different redirect |
| `https://cdn.jsdelivr.net` | ONNX runtime `.mjs`/`.wasm` when "from cdn.jsdelivr.net" is chosen |

The `testB` event's `hosts` field lists the origins really used.

## Build

```bash
npm install
npx vitest run && npx tsc --noEmit && npm run build
npx evenhub pack app.json dist -o speech-probe.ehpk --sdk-ver 0.0.16
```

The build ships the ONNX runtime wasm (~27 MB, ~6.8 MB gzip) in `dist/assets`, so the default
setting needs no CDN.
