# AI Scanner + AI Autopilot + Win-Rate Tracker — in this bot

Added to the v50 Pepperstone-strategies bot. Nothing else in `index.html` was changed
except three `<script>` tags (and the small chart bridge) at the very bottom.

## Files
- `ai-zone-strategist.js` — AI Autopilot (🤖 AI pill). Carried over from the other bot; 3 text-only label edits so its scan list shows grade/score.
- `win-tracker.js` — win-rate tracker. Carried over unchanged.
- `scanner-pro.js` — NEW. The professional scanner, its link to Megan and the AI Autopilot, and the 📡 panel (Signals + Win rate).
- `megan-brain.js` — two optional, additive hooks (`voiceCommand`, `getAnalysisBrief`). Other bots that don't define them are unaffected.

## How the scanner decides (real candles only, closed candles only, no repainting)
A signal appears only when ALL of this lines up:
- 15m trend (EMA 20/50 + slope + higher-highs/lows structure), not fighting the 60m trend, and the market is not choppy (efficiency ratio filter)
- one of three patterns: trend pullback to the 5m 21/50 EMA with an RSI reset and reclaim candle · rejection of a 15m support/resistance zone tested 3+ times · tight-range breakout on a strong close
- a stop beyond real structure (0.7–3 ATR) and a target at the next real level, minimum 1.5R (1.8R for zone trades)
- healthy volatility, not the daily rollover, not a weekend (forex/metals), no high-impact news window, spread small versus the stop, price hasn't run away from the trigger
Score ≥ 70 = grade B, ≥ 82 = grade A. The score is a checklist-quality score, NOT a win probability.

## How it's connected to Megan
- Her chart read now includes the scanner's numbers as a second opinion (she can disagree).
- Her autopilot ("let Megan trade"): scanner must find a valid setup AND Megan must agree (switch in the 📡 panel), then it goes through `executeTrade()` with the scanner's own stop/target. If her AI relay is unreachable, no trade.
- Voice: "any good setups / scan the market", "what's the signal on this pair", "take it" / "skip", "what's my win rate". She also announces a new setup once (toggle in the panel).
- "Yes, fire it" after her chart read uses the scanner's levels when it agrees; if it disagrees it still fires (your call) and she tells you so.

## With the AI Autopilot (🤖 AI) master switch ON
- The bot's built-in auto only enters when the scanner agrees (switch: "Only enter when the scanner agrees").
- The pair scanner in the AI panel runs this engine; Accept switches pair and sets a matching strategy.
- Scanner trades are single-leg (no stacking), keep the scanner's exact stop/target, and aren't cut by the 5-minute max-hold or the EMA-Ride flip exit.
Manual BUY/SELL are never gated.

## Honest limits
- Nothing here can promise profit. Run it on Paper/Demo and judge it by the Win rate tab (needs 100+ trades). "Replay this pair" runs the same engine over the candles already loaded, using only data available at each moment — a sanity check with no spread/commission modelled.
- The news calendar in this bot is rule-based (approximate times), not a live feed.
- Scanning other pairs is cTrader-only (Binance: current pair only). Weekends: forex/metals are skipped.
- Live-arm, daily loss limit, spread check and the sanity check on risk still apply to every order.
