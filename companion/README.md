# Knowledge Hub Companion

Always-on-top desktop shell for live meeting sessions (mic and/or system audio).

## Run

1. Start the main app: `npm run dev` (repo root).
2. Here:

```bash
npm install
KH_URL=http://127.0.0.1:8080/minutes npm start
```

3. Open **Start live session** → gear icon:
   - **Audio source:** Microphone · System/tab · Mic + system
   - **STT:** Browser (free) · Deepgram · Whisper (OpenAI / Groq / compatible)
   - **Pause STT while likely muted** (default on) to save API cost

4. Keep this window above Meet / Teams / Zoom.

## System audio

Pick **System / tab audio**, then in the browser share dialog choose the meeting
tab or window and enable **Share audio**. Without that checkbox there is no
loopback signal to transcribe.

## STT keys

Keys are stored only in the page `localStorage` on this device (same pattern as
Ask providers). They are sent to Deepgram or your Whisper base URL when a chunk
is transcribed — never to a Knowledge Hub backend.
