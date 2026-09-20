# Megan in Trade Port EA

Same portable `megan-brain.js` as your other bot, dropped in unmodified,
wired to this app's own real controls via `window.MeganBotAdapter` (near
the bottom of `index.html`). Nothing about the existing bot's logic changed
— every hook is additive.

## What she does here

- **Tap icon, not the dashboard.** Top-right circle on every screen
  (including the splash screen) — tap it for a small panel with Mic and
  Voice switches. The dot on the icon goes green while she's listening.
- **Starts on "Start Now."** That tap is the one real user-gesture browsers
  require before they'll allow mic access or play audio, so that's exactly
  where her mic turns on and she starts talking — not before.
- **Greets you by name.** First time on a device: she introduces herself
  (name, that Morgan built her, what her job is here), then asks your name
  and remembers it (`localStorage`, this device only). Every time after:
  "Welcome back `<name>`, on the money machine — time to grow your
  account." Say "call me X" or "what's my name" any time to change or
  check it.
- **Auto-connects if you're already set up.** If cTrader or Binance
  credentials are already saved on this device, tapping Start Now skips
  straight to connecting and lands you on the dashboard — using the exact
  same `connectCT()`/`connectBN()` the manual Connect button calls, so it's
  the same safety checks, not a shortcut around them. First time on a new
  device, with nothing saved yet, it goes to the normal Broker screen so
  you can enter credentials yourself.
- **Listens everywhere, no typing.** Once the mic's on it stays on across
  every screen — arm/disarm, paper on/off, pause/resume, buy/sell/close,
  "what's my status," "explain the chart," all by voice, matching what's
  already in your other bot.
- **"Pick the best strategy for right now."** New command (lives in the
  shared brain file, so your other bot gets it too): she looks at the real
  current pair, signal, and session — the same data shown in the
  session badge and signal panel — and picks one of the real strategy
  presets, then switches to it. If nothing in her answer matches a real
  preset name, she says so and leaves your setting alone instead of
  guessing.

## Her autonomous trading here is more conservative than the other bot's

She only ever decides **BUY, SELL, or HOLD** — never her own entry, stop,
or target price. When approved, her trade goes through this app's own
`executeTrade()`, the exact function every manual and built-in-auto trade
already uses. That means she automatically gets:
- the strategy preset's real SL/trail/max-hold, not a number she invented
- your configured lot size
- the live-arm block (`if(state.env==='live' && !state.armed)` — already
  in this app, untouched)
- the daily loss limit check

Off by default. Turn it on by saying "let Megan trade" / "take over" — she
confirms once before it activates, same pattern as the arm toggle.

## The mic-sharing / screen-recording question

Not something this code can control — a web page can't grant another app
simultaneous mic access, that's an OS-level permission. What actually gets
you "my voice + her voice" in a recording: your phone's own screen
recorder audio settings. Android's built-in recorder and iOS's Control
Center recorder both typically offer a "microphone + app/device audio"
option — turn that on and it captures your mic and whatever's coming out
the speaker (her TTS voice) together, no code change needed on this end.
