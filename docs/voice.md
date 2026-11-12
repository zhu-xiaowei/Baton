# Voice mode

Voice mode is an opt-in, per-Session layer over the normal text workflow. Messages, history and
what Claude Code or Codex receive stay text; voice only helps the user enter text and listen to
replies. Every Session starts in text mode and looks exactly as before.

## Enabling it

Voice mode is off unless the stack turns it on, so a deployment gains no Transcribe, Polly or
Bedrock permissions by default:

```bash
BATON_VOICE=true ./server/install.sh --region <region> --stack <stack>
```

The choice is kept on later deploys (`BATON_VOICE=false` turns it off). `BATON_VOICE_LANGUAGES`
(stack parameter `VoiceAutoLanguages`, default `zh-CN,en-US`) sets the languages Auto dictation
chooses between; `VoiceBriefModelId` sets the brief model. The app asks `GET /api/voice/config`
and shows no voice controls when the stack has voice off or predates it. The region needs Amazon
Transcribe streaming, Polly neural voices and the brief model in Bedrock.

## Using it

- The headphones button in a Session's toolbar switches that Session between text and voice
  mode. The choice is remembered per Session on the device (`localStorage`
  `baton-voice:<sessionId>`); new Sessions start in text mode.
- **Talk** (Android app, browsers): hold the mic to talk and release to stop, or tap once to
  start and tap again to stop. Text appears in the composer while speaking; it is sent only when
  the user taps send, unless Settings → Voice → *Send after dictation* is on. Recording stops after
  three minutes. The iOS app keeps its native dictation (SFSpeechRecognizer) in every Session.
- **Listen**: when a turn finishes, the latest reply is read aloud (Settings → *Read replies
  aloud*). The voice bar above the composer replays the latest reply, stops playback and holds the
  Session's **Brief** chip. A reply that finishes while the app is in the background plays when
  it returns to the foreground.
- **Brief**: with the chip on, a reply longer than the threshold (Settings: 200/300/500
  characters, default 300) is condensed into a short spoken briefing first. Settings sets the
  default for new Sessions; the chip overrides it per Session.

## How it works

```text
mic ─AudioWorklet─▶ 16 kHz PCM ─event-stream─▶ Amazon Transcribe (presigned WebSocket)
                                                   │ partial/final results
composer ◀─────────────────────────────────────────┘

turn completed ─▶ POST /api/voice/speak ─▶ [Bedrock brief] ─▶ Polly ─▶ S3 voice/<account>/…mp3
                                                                        │ presigned GET
<audio> ◀───────────────────────────────────────────────────────────────┘
```

- With automatic language identification Transcribe settles the language once per stream, so
  the client ends a stream after every finished utterance and continues on a fresh one (URL
  prefetched, audio queued while it connects); speakers can switch language between sentences.
  Each stream is billed for at least 15 seconds.
- `POST /api/voice/stt-url {language, sampleRate}` returns a Transcribe streaming WebSocket URL
  (`language: "auto"`, the default, identifies Chinese or English per dictation via
  `VOICE_AUTO_LANGUAGES`; Settings can pin 中文, English or the phone's language. With Auto, each
  utterance after a pause starts a fresh Transcribe stream so its language is detected again; a
  pinned language keeps one stream)
  signed with the API Lambda's role, valid for five minutes. Audio goes from the device straight to
  Transcribe; it never passes through the server and is not stored.
- `POST /api/voice/speak {text, brief, threshold}` strips code blocks, tables, URLs and long paths,
  optionally condenses the reply with `VoiceBriefModelId` (default
  `global.anthropic.claude-haiku-5-5`, thinking disabled), synthesizes MP3 with Polly neural voices
  (Zhiyu for Chinese, Joanna otherwise; up to 6000 characters, split into parallel requests) and
  returns a ten-minute presigned URL. Results are cached by account, mode and text hash.
- `install.sh` adds the lifecycle rule `baton-voice-expire`: `voice/` objects expire after one
  day. Other lifecycle rules on the bucket are kept.
- The Bridge is unchanged.

Code: `server/src/voice.py`, `web/js/voice-mode.js` (state, voice bar, playback, Settings),
`web/js/components/voice.js` (dictation), `web/js/components/voice-stream.js` (event-stream
codec, PCM capture). Android declares `RECORD_AUDIO` and disables
`mediaPlaybackRequiresUserGesture`; wry grants the WebView's audio capture request.

## Notes

- Transcribe and Polly may store and use content to improve AWS services unless the account is
  covered by an AWS Organizations AI services opt-out policy.
- Domain words can be misheard (for example product names). `voice.py` adds a Transcribe custom
  vocabulary to every dictation URL when the API Lambda has `VOICE_VOCABULARY_NAME`; it is not a
  stack parameter yet.
- A side-by-side Android test build: `-PbatonAppIdSuffix=.voice -PbatonAppLabel="Baton Voice"`.
