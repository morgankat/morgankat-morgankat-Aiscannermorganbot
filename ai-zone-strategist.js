/* ================================================================
   AI ZONE STRATEGIST — add-on module for Trade Port EA / Megan
   ----------------------------------------------------------------
   This file changes NOTHING in index.html. It attaches itself by
   re-pointing a handful of already-global functions (executeTrade,
   checkTrail, checkExits) to wrapped versions that call the
   originals, plus it draws its own canvas layer on top of the
   existing chart. If any expected function/variable is missing
   (e.g. you're loading this against a modified build) every hook
   below fails soft and logs once instead of throwing.

   What this does, and does NOT do:
   - It DOES detect supply/demand zones from real candle history,
     draw them (and pending SL/TP boxes + news-time lines) on your
     existing chart, derive SL/TP from those zones, gate entries
     behind a short confirmation window, ratchet a real profit-lock
     on REAL broker positions (not just paper — see the checkTrail
     patch note below for exactly what changed and why), size lots
     from your account balance/risk%, and scan your configured
     symbols for the cleanest current setup with an Accept/No
     prompt.
   - It does NOT invent a new execution path. Every trade still goes
     through the bot's own executeTrade()/paperOpen()/realOpen() —
     this only changes the SL distance, the TP target, and whether/
     when that call is allowed to fire. It never bypasses Arm Live,
     the in-flight order lock, or sanityCheckTrade().
   - Pair scanning here is cTrader-only for now (Binance uses a
     different data path in this build) — Binance symbols are
     skipped in the scan list.
   ================================================================ */
(function(){
'use strict';

// Top-level `let`/`const` in index.html (state, cfg, SYM_DEFS, $, ...) are visible to
// other classic scripts as bare identifiers but are NOT properties of `window`, so a
// plain `typeof window[n]` check wrongly reports them missing. Indirect eval runs in
// the global scope and sees both kinds.
function has(n){ try{ return (0,eval)('typeof '+n)!=='undefined'; }catch(e){ return false; } }
function need(names){
  for(const n of names){ if(!has(n)){ console.warn('[AIZone] missing expected global: '+n+' — some features disabled.'); return false; } }
  return true;
}
const HAVE_CORE = need(['state','cfg','SYM_DEFS','STRATEGY_PRESETS','STRATEGY_LABELS','executeTrade','checkTrail','checkExits','log','$','dollarPerUnitFor','lotSizeFor','isFullLoaded','tfBars','digitsFor','roundToDigits','norm','fmtPnL']);

const LS_KEY='tpea_aizone_cfg';
const AI = window.AIZone = {
  cfg: Object.assign({
    masterOn:false,      // top-level switch — everything below is inert while this is off
    zonesOn:true,        // draw zones/news lines on the chart
    zoneSLTP:true,       // derive SL/TP from zones instead of fixed $/ATR
    confirmEntries:true, // require a short confirmation window before firing
    confirmSeconds:6,    // how long a signal must hold before it's trusted (grid/scalping2 skip this — see executeTrade hook)
    autoLot:true,        // size lots from balance × risk% instead of the fixed Lot Size field
    riskPct:1,           // % of balance risked per trade when autoLot is on
    scannerOn:true,       // periodically rank symbols and offer to switch
    ghostMode:false,      // flip on EVERY grid/scalping close, no filter (video-style)
    structureTf:15        // FIX ("bot over-sleeps, doesn't fire like the fast reference
                           // bot"): BOS/zone detection used to read off cfg.tf, the SAME
                           // timeframe you trade on. On 1m that made structure noisy; on
                           // 5m it meant only one entry shot every 5 minutes, and either
                           // way the entry-distance gate's ATR buffer was measured on
                           // that same fast timeframe, so it was tiny and could block
                           // almost every entry near a zone. Structure now always reads
                           // off a fixed 15m view, independent of whatever fast
                           // timeframe you actually trade on — you can run 1m for speed
                           // without the structure gate slowing it down.
  }, loadCfg()),
  zones:{},        // per-symbol: up to 2 entries — the last bullish + bearish BOS level
  bos:{},          // per-symbol: {bull:{price,at}, bear:{price,at}} raw structure levels
  pending:{},      // per-symbol confirmation tracker
  scan:{running:false, results:[], lastRun:0, awaiting:null}
};

// ---------------------------------------------------------------
// MARKET HOURS — forex/metals are closed on weekends, crypto is not.
// Window used: Fri 22:00 UTC -> Sun 22:00 UTC (same idea as the app's own
// isWeekendClosed(), plus the Friday-night gap). Brokers differ by up to
// an hour or so either side, so treat this as "roughly", not exact.
// ---------------------------------------------------------------
AI.fxClosedNow=function(d){
  d=d||new Date(); const day=d.getUTCDay(), h=d.getUTCHours();
  return day===6 || (day===5&&h>=22) || (day===0&&h<22);
};
AI.isClosed=function(def){ return !!def && !def.weekend && AI.fxClosedNow(); };

function loadCfg(){ try{return JSON.parse(localStorage.getItem(LS_KEY))||{};}catch(e){return {};} }
function saveCfg(){ try{localStorage.setItem(LS_KEY,JSON.stringify(AI.cfg));}catch(e){} }

// ---------------------------------------------------------------
// STRUCTURE (BOS) DETECTION — replaces the old multi-zone pivot
// clustering, which drew up to 6 supply/demand bands per symbol (mostly
// noise) and never actually influenced WHEN a trade fired, only its
// SL/TP size. This is a real, if simplified, Break-of-Structure read:
//  1. Find swing pivots (a candle whose high/low is the extreme of the
//     7 candles centered on it) — same pivot test as before.
//  2. Walk forward candle by candle. Whenever a candle CLOSES beyond the
//     most recent swing high, that's a bullish BOS: the old high is
//     "broken" and, by classic structure logic, tends to flip from
//     resistance into new support (a demand level) on the retest.
//     Mirror logic for a close beyond the most recent swing low → bearish
//     BOS, old low flips into new resistance (a supply level).
//  3. Only the LATEST bullish BOS and LATEST bearish BOS are kept — never
//     more than these two levels, which is what actually gets drawn.
// This is a simplified, mechanical reading of structure (candle closes
// vs prior swing points) — not a claim of true institutional order-flow
// analysis — but it's real price-derived structure, not decoration.
// ---------------------------------------------------------------
function findSwingPivots(bars){
  const pivots=[];
  for(let i=3;i<bars.length-3;i++){
    const w=bars.slice(i-3,i+4);
    if(bars[i].h===Math.max(...w.map(b=>b.h))) pivots.push({price:bars[i].h,type:'high',i,t:bars[i].t});
    if(bars[i].l===Math.min(...w.map(b=>b.l))) pivots.push({price:bars[i].l,type:'low',i,t:bars[i].t});
  }
  return pivots;
}
function computeBOS(bars){
  if(!bars||bars.length<20) return {bull:null,bear:null};
  const pivots=findSwingPivots(bars);
  if(!pivots.length) return {bull:null,bear:null};
  let lastHigh=null,lastLow=null,bull=null,bear=null,pi=0;
  const startI=pivots[0].i;
  for(let i=startI;i<bars.length;i++){
    while(pi<pivots.length && pivots[pi].i===i){
      if(pivots[pi].type==='high') lastHigh=pivots[pi];
      else lastLow=pivots[pi];
      pi++;
    }
    const c=bars[i].c;
    if(lastHigh && c>lastHigh.price){ bull={price:lastHigh.price,at:bars[i].t}; lastHigh=null; }
    if(lastLow && c<lastLow.price){ bear={price:lastLow.price,at:bars[i].t}; lastLow=null; }
  }
  return {bull,bear};
}
// Turns the two raw BOS levels into the same {top,bottom,type} shape the
// rest of the file (SL/TP sizing, entry gating, drawing) already expects
// from a "zone" — a thin band around the level instead of a wide cluster.
function detectZones(a){
  if(!a||!a.dataReady) return [];
  const bars=tfBars(a, AI.cfg.structureTf||15);
  if(!bars||bars.length<20) return [];
  const atrVal=(typeof atr==='function'&&atr(bars,14))||( (a.lastPrice||1)*0.001 );
  const bos=computeBOS(bars);
  AI.bos[a.key]=bos;
  const zones=[];
  if(bos.bull) zones.push({type:'demand',top:bos.bull.price+atrVal*0.15,bottom:bos.bull.price-atrVal*0.15,touches:2,bosAt:bos.bull.at});
  if(bos.bear) zones.push({type:'supply',top:bos.bear.price+atrVal*0.15,bottom:bos.bear.price-atrVal*0.15,touches:2,bosAt:bos.bear.at});
  AI.zones[a.key]=zones;
  return zones;
}

// ---------------------------------------------------------------
// TREND CONTINUATION — is price still on the far side of the structure
// break that got us here, or has it already come back through it? Used
// to decide whether a clean take-profit should immediately re-fire the
// same direction (continuation) or hand back to the normal signal flow
// (uncertain). Returns true/false, or null when there's no BOS read yet.
// ---------------------------------------------------------------
AI.trendContinuing=function(a,side){
  const bos=AI.bos[a.key]; const px=a.lastPrice;
  if(!bos||!px) return null;
  if(side==='BUY'){ if(!bos.bull) return null; return px>=bos.bull.price; }
  if(!bos.bear) return null; return px<=bos.bear.price;
};

// ---------------------------------------------------------------
// REACT TO A GRID/SCALPING CLOSE — the actual "trade this like the demo
// video" logic. Only ever queues a reversal/continuation via the SAME
// forceNextSide mechanism the bot already uses for Flip/Scalping (fires
// on the very next tick, correctly waits for a real close to confirm on
// live trades, tagged isFakeLeg so it survives one candle before any
// exit check can touch it) — never a new/parallel execution path.
//  - reason 'protect': profit-lock closed the trade because price pulled
//    BACK from its peak — that pullback is itself the signal, so reverse
//    immediately.
//  - reason 'tp': a clean target hit, no giveback. Only re-fire the same
//    direction immediately if price is still beyond the BOS level that
//    got us here (trend continuing); otherwise this deliberately does
//    NOTHING and lets the normal signal-gated flow decide the next round
//    — no forced guess when structure doesn't confirm continuation.
//  - A stop-out / max-drawdown close never reaches this function at all
//    (not called from those branches) — reversing right after a loss
//    with no real signal is revenge-trading, not strategy.
// ---------------------------------------------------------------
AI.reactToClose=function(a,closedSide,reason){
  if(!AI.cfg.masterOn||!closedSide) return;
  // GHOST MODE — same name and same behavior as the reference bot you sent:
  // reverse on every single close, no filter, no structure check, whether
  // it closed via profit-lock OR a clean TP. Opt-in, OFF by default — it
  // will also flip straight into losing streaks during a real trend, since
  // it has zero read on whether the move is actually done. Compare it
  // side-by-side against the filtered mode below on demo before trusting
  // either one for real money.
  if(AI.cfg.ghostMode){
    const next=closedSide==='BUY'?'SELL':'BUY';
    a.forceNextSide=next; a.forceNextSideIsFakeLeg=true;
    log('Ghost mode — always alternate, '+next+' now (closed '+closedSide+' on '+a.label+').');
    return;
  }
  if(reason==='protect'){
    const next=closedSide==='BUY'?'SELL':'BUY';
    a.forceNextSide=next; a.forceNextSideIsFakeLeg=true;
    log('AI: profit-lock closed '+closedSide+' on '+a.label+' — that pullback is the signal, reversing to '+next+' immediately.');
  }else if(reason==='tp'){
    const cont=AI.trendContinuing(a,closedSide);
    if(cont===true){
      a.forceNextSide=closedSide; a.forceNextSideIsFakeLeg=true;
      log('AI: target hit on '+a.label+' — structure still intact, continuing '+closedSide+' immediately.');
    }
  }
};

function nearestZone(a,side,px){
  const zones=AI.zones[a.key]||[];
  if(!zones.length) return null;
  // Entry side: BUY wants a demand zone below (its floor for SL) and a
  // supply zone above (its ceiling for TP). SELL is the mirror.
  const below=zones.filter(z=>z.top<px).sort((x,y)=>y.top-x.top)[0]||null;
  const above=zones.filter(z=>z.bottom>px).sort((x,y)=>x.bottom-y.bottom)[0]||null;
  if(side==='BUY') return {slZone:below, tpZone:above};
  return {slZone:above, tpZone:below};
}

// ---------------------------------------------------------------
// ZONE ENTRY GATE — makes the drawn zones actually matter to WHEN a trade
// fires, not just how big its SL/TP is. If there's no zone data yet, this
// doesn't block anything (fails open) — it only blocks once we can see
// price has already run too far from the zone to be a clean entry.
// ---------------------------------------------------------------
AI.zoneAllowsEntry=function(a,side){
  if(!AI.cfg.masterOn||!AI.cfg.zoneSLTP) return true;
  const px=a.lastPrice; if(!px) return true;
  const z=nearestZone(a,side,px); if(!z||!z.slZone) return true;
  const atrVal=(typeof atr==='function'&&atr(tfBars(a,AI.cfg.structureTf||15),14))||px*0.001;
  const edge=side==='BUY'?z.slZone.bottom:z.slZone.top;
  return Math.abs(px-edge)<=atrVal*1.5;
};

// Returns raw price-unit SL distance for a fresh entry, or null (caller
// falls back to the bot's own fixed-$/ATR logic) when no usable zone.
AI.slDistanceFor=function(a,side){
  if(!AI.cfg.masterOn||!AI.cfg.zoneSLTP) return null;
  const px=a.lastPrice; if(!px) return null;
  const z=nearestZone(a,side,px); if(!z||!z.slZone) return null;
  const atrVal=(typeof atr==='function'&&atr(tfBars(a,AI.cfg.structureTf||15),14))||px*0.001;
  const edge=side==='BUY'?z.slZone.bottom:z.slZone.top;
  const dist=Math.abs(px-edge)+atrVal*0.15; // small buffer beyond the zone edge
  return (dist>0 && Number.isFinite(dist)) ? dist : null;
};

// Returns a dollar TP target (same unit cfg.basketProfit already uses) for
// a fresh entry, or null.
AI.tpDollarsFor=function(a,side,vol){
  if(!AI.cfg.masterOn||!AI.cfg.zoneSLTP) return null;
  const px=a.lastPrice; if(!px) return null;
  const z=nearestZone(a,side,px); if(!z||!z.tpZone) return null;
  const edge=side==='BUY'?z.tpZone.bottom:z.tpZone.top;
  const dist=Math.abs(edge-px);
  const v=vol||lotSizeFor(a);
  const dollars=dist*dollarPerUnitFor(v,a);
  return (dollars>0.05 && Number.isFinite(dollars)) ? dollars : null;
};

// ---------------------------------------------------------------
// ENTRY CONFIRMATION — a signal has to hold for cfg.confirmSeconds
// before it's allowed to fire, so the bot isn't chasing the very
// first flicker of a signal. Cheap, strategy-agnostic, easy to
// reason about.
// ---------------------------------------------------------------
AI.confirmEntry=function(a,side){
  if(!AI.cfg.masterOn||!AI.cfg.confirmEntries) return true;
  const p=AI.pending[a.key];
  const now=Date.now();
  if(!p||p.side!==side){ AI.pending[a.key]={side,since:now}; return false; }
  return (now-p.since)>=AI.cfg.confirmSeconds*1000;
};

// ---------------------------------------------------------------
// AUTO LOT SIZE — lots such that hitting the SL loses riskPct% of
// balance, clamped to the broker's own min/step via volumeFor's own
// rounding (we just hand back a lots number; volumeFor still owns
// the final broker-unit rounding).
// ---------------------------------------------------------------
AI.autoLotSize=function(a,slDist){
  if(!AI.cfg.masterOn||!AI.cfg.autoLot) return null;
  if(!slDist||slDist<=0) return null;
  const bal=(typeof state!=='undefined')?(state.paper?state.paperBalance:state.balance):0;
  if(!bal||bal<=0) return null;
  const riskDollars=bal*(AI.cfg.riskPct/100);
  const perLotDollarPerUnit=dollarPerUnitFor(lotSizeFor(a),a);
  if(!perLotDollarPerUnit) return null;
  let lots=riskDollars/(slDist*perLotDollarPerUnit);
  if(!Number.isFinite(lots)||lots<=0) return null;
  lots=Math.max(0.01, Math.min(lots, 20)); // hard ceiling — never let a calc error size up unbounded
  return Math.round(lots*100)/100;
};

// ---------------------------------------------------------------
// HOOK: executeTrade — gates entries behind confirmation, and
// temporarily overrides cfg.slDollars-equivalent (via slDistanceFor
// patch below) / cfg.basketProfit / cfg.lotSize for the duration of
// this one call only, then restores the user's own configured
// values so the Config screen never silently drifts from what's
// displayed there.
// ---------------------------------------------------------------
if(HAVE_CORE){
  const _origExecuteTrade=executeTrade;
  window.executeTrade=executeTrade=function(a,side){
    const isFreshEntry=a.positions.length===0;
    // FIX ("bot just watches the market even with a clear signal, way too
    // slow/passive for grid/scalping"): Grid and Scalping-2 recompute their
    // signal from the still-forming candle on every tick, so it flickers
    // between BUY/WAIT/SELL as price wiggles — the 12s "hold steady" timer
    // below almost never survives unbroken, so it just kept resetting and
    // entries never fired. Both strategies already gate fresh entries to
    // once per new candle plus their own cooldown, so this generic timer is
    // redundant for them and was the main thing making them feel asleep.
    const fastStrategy=(cfg.strategy==='grid'||cfg.strategy==='scalping2');
    if(isFreshEntry && AI.cfg.masterOn && AI.cfg.confirmEntries && !fastStrategy && !a.pendingIsFakeLeg){
      if(!AI.confirmEntry(a,side)) return false;
    }
    // FIX ("zone lines are just a picture, grid enters when the market has
    // already reversed away"): zones only ever sized SL/TP, they never had
    // any say in WHETHER/WHEN a fresh entry fires. Now, when AI-calculated
    // SL/TP is on, a fresh entry is skipped if price has already run more
    // than ~1.5x ATR past the zone that would define its stop — i.e. don't
    // buy well after the bounce off demand already happened, or sell well
    // after price left supply. This applies to every strategy, not just a
    // cosmetic overlay.
    if(isFreshEntry && AI.cfg.masterOn && AI.cfg.zoneSLTP && !a.pendingIsFakeLeg && !AI.zoneAllowsEntry(a,side)) return false;
    let restoreBasket=null, restoreLot=null;
    if(isFreshEntry && AI.cfg.masterOn){
      const slDist=AI.slDistanceFor(a,side);
      if(AI.cfg.autoLot){
        const effSl=slDist || (cfg.slDollars/dollarPerUnitFor(lotSizeFor(a),a));
        const lots=AI.autoLotSize(a,effSl);
        if(lots){ const prev=cfg.lotSize; cfg.lotSize=lots; restoreLot=()=>{cfg.lotSize=prev;}; }
      }
      if(AI.cfg.zoneSLTP){
        const tp=AI.tpDollarsFor(a,side, volumeFor(a,cfg.lotSize));
        if(tp && cfg.strategy!=='grid'){ const prev=cfg.basketProfit; cfg.basketProfit=tp; a._aiBasketOverride=tp; restoreBasket=()=>{cfg.basketProfit=prev;}; }
      }
    }
    const result=_origExecuteTrade(a,side);
    if(restoreLot) restoreLot();
    if(restoreBasket) restoreBasket();
    if(result) AI.pending[a.key]=null;
    return result;
  };

  // slDistanceFor is the single choke point paperOpen/realOpen both use for
  // SL distance in raw price units — patch it directly instead of juggling
  // cfg.slDollars, so it works whether or not ATR mode is on.
  if(typeof slDistanceFor==='function'){
    const _origSlDistanceFor=slDistanceFor;
    window.slDistanceFor=slDistanceFor=function(a,vol){
      if(AI.cfg.masterOn && AI.cfg.zoneSLTP){
        const side=a.pendingIsFakeLeg?a.forceNextSide:(a.signal!=='WAIT'?a.signal:null);
        if(side){ const z=AI.slDistanceFor(a,side); if(z) return z; }
      }
      return _origSlDistanceFor(a,vol);
    };
  }

  // checkExits reads cfg.basketProfit LIVE every tick for as long as a
  // basket stays open — the entry-time override above only covers the
  // broker order placed at open, so this keeps the same AI target applied
  // for the life of the position without ever touching the number shown
  // on your Config screen.
  const _origCheckExits=checkExits;
  window.checkExits=checkExits=function(a){
    const userBasket=cfg.basketProfit;
    if(AI.cfg.masterOn && AI.cfg.zoneSLTP && a._aiBasketOverride) cfg.basketProfit=a._aiBasketOverride;
    _origCheckExits(a);
    cfg.basketProfit=userBasket;
    if(!a.positions.length) a._aiBasketOverride=null;
  };

  // ---------------------------------------------------------------
  // HOOK: checkTrail — THE ACTUAL FIX.
  // Original had `if(!p.paper)return;` at the top of the per-position
  // loop, which skipped every real broker position entirely — so the
  // profit-lock ratchet (cfg.profitProtect) never ran on real money,
  // only on paper. That's true for every strategy, not just Grid
  // (Grid already had its own separate lock).
  //
  // Fix, by position type:
  //  - Paper: unchanged, exact original logic.
  //  - Real cTrader: same ratchet math, but instead of watching price
  //    locally and calling closeAllPositions() when it's crossed (a
  //    client round-trip that can miss by a tick — the same race this
  //    codebase already fixed for take-profit, see realOpen's own
  //    comments), it sends the improved stop to the BROKER via
  //    AMEND_POSITION_SLTP_REQ. The broker's own matching engine then
  //    enforces it with no round-trip gap, the same way the order-time
  //    stop already does. Throttled to avoid spamming amends.
  //  - Real Binance: this build never gives Binance orders a broker-
  //    side stop at all (realOpen's Binance branch is a bare market
  //    order) — so for those, local price-cross + closeAllPositions is
  //    the only enforcement that exists, same as paper.
  // ---------------------------------------------------------------
  window.checkTrail=checkTrail=function(a){
    if(!a.positions.length) return;
    const digits=digitsFor(a);
    a.positions.forEach(p=>{
      const dollarPerUnit=dollarPerUnitFor(p.volume,a);
      if(dollarPerUnit<=0) return;
      if(cfg.profitProtect){
        const armAt=cfg.trailBuffer!=null?cfg.trailBuffer:0.5;
        if(p.floatingPnL>=armAt){
          // FIX ("profit protection should work in all strategies"): the old
          // 0.9x-$1.50 formula computes to $0 lock for any profit under about
          // $1.67 — on a small account, or any normal scalp-sized win, that
          // meant "protection" wasn't actually protecting anything below that
          // line. Locking a flat 70% of whatever's showing the moment it
          // arms works the same at $0.50 profit as at $50.
          const lockedProfit=Math.max(0,0.7*p.floatingPnL);
          const lockedOffset=lockedProfit/dollarPerUnit;
          let candidateStop=p.side==='BUY'?p.entryPrice+lockedOffset:p.entryPrice-lockedOffset;
          candidateStop=roundToDigits(candidateStop,digits);
          const improves=p.stopLoss==null?true:(p.side==='BUY'?candidateStop>p.stopLoss:candidateStop<p.stopLoss);
          if(improves){ p.stopLoss=candidateStop; p.trailingActive=true; }
        }
      }
      if(p.stopLoss==null) return;
      const isRealCtrader=!p.paper && p.positionId!=null && typeof PT!=='undefined' && typeof send==='function';
      if(isRealCtrader){
        const lastSent=p._aiLastAmendedStop;
        const changed=lastSent==null || Math.abs(lastSent-p.stopLoss)>=Math.pow(10,-digits)*2;
        const throttled=p._aiLastAmendAt && (Date.now()-p._aiLastAmendAt)<4000;
        if(changed && !throttled){
          try{
            send(PT.AMEND_POSITION_SLTP_REQ,{ctidTraderAccountId:state.accountId,positionId:p.positionId,stopLoss:roundToDigits(p.stopLoss,digits)});
            p._aiLastAmendedStop=p.stopLoss; p._aiLastAmendAt=Date.now();
          }catch(e){}
        }
        return; // broker enforces it now — no local close for real cTrader
      }
      // Paper, and real Binance (no broker-side stop available): same
      // local price-cross check the original code always ran.
      if(p.side==='BUY'&&a.lastPrice<=p.stopLoss){log((p.trailingActive?'Profit lock':'Stop loss')+' closing '+a.label+' ('+fmtPnL(p.floatingPnL)+').');closeAllPositions(a);}
      if(p.side==='SELL'&&a.lastPrice>=p.stopLoss){log((p.trailingActive?'Profit lock':'Stop loss')+' closing '+a.label+' ('+fmtPnL(p.floatingPnL)+').');closeAllPositions(a);}
    });
  };
}

// ---------------------------------------------------------------
// PAIR / STRATEGY SCANNER — cTrader-only. Ranks configured symbols
// by "how clean is the setup right now" and proposes the best one
// with a suggested strategy. Never switches anything without you
// tapping Accept.
// ---------------------------------------------------------------
function clarityScore(bars){
  if(!bars||bars.length<40) return null;
  const closes=bars.map(b=>b.c);
  const e9=ema(closes,9), e21=ema(closes,21);
  const atrVal=atr(bars,14);
  if(e9==null||e21==null||!atrVal) return null;
  const trendStrength=Math.abs(e9-e21)/atrVal;               // separated EMAs = clear direction
  const last20=bars.slice(-20);
  const range=Math.max(...last20.map(b=>b.h))-Math.min(...last20.map(b=>b.l));
  const choppiness=range>0?(atrVal*20)/range:0;               // near 1 = smooth trend, low = chop
  const avgBody=last20.reduce((s,b)=>s+Math.abs(b.c-b.o),0)/last20.length;
  const bodyRatio=atrVal>0?avgBody/atrVal:0;                  // decisive candles vs indecisive wicks
  const dir=e9>e21?'BUY':'SELL';
  const score=trendStrength*40 + choppiness*35 + bodyRatio*25;
  let strategy='ctConfluence';
  if(trendStrength>1.2) strategy='emaRide';
  else if(choppiness<0.5) strategy='rsiExtreme';
  else if(bodyRatio>0.6) strategy='structure';
  return {dir, score:Math.round(Math.min(100,score)), strategy};
}

AI.scanPairs=function(onDone){
  if(typeof state==='undefined'||state.broker!=='ctrader'||!state.accountReady){
    if(onDone) onDone([]);
    return;
  }
  if(AI.scan.running) return;
  AI.scan.running=true;
  // Weekend awareness: skip anything that's closed right now. On a Saturday
  // that leaves only the 24/7 (crypto) symbols; on a weekday it's everything.
  const candidates=Object.keys(SYM_DEFS).filter(k=>!AI.isClosed(SYM_DEFS[k]));
  const results=[];
  let remaining=candidates.length;
  function finish(){
    remaining--; 
    if(remaining<=0){
      AI.scan.running=false;
      AI.scan.results=results.sort((x,y)=>y.score-x.score);
      AI.scan.lastRun=Date.now();
      if(onDone) onDone(AI.scan.results);
    }
  }
  candidates.forEach(sym=>{
    const def=SYM_DEFS[sym];
    let hit=null;
    for(const m of def.ctMatch){ const s=state.symbolsByNorm[norm(m)]; if(s){hit=s;break;} }
    if(!hit){ finish(); return; }
    if(!state.assets[sym]) state.assets[sym]={key:sym,label:def.label,name:def.name,symbolId:hit.symbolId,full:hit,lastPrice:0,bars1:[],bars5:[],bars15:[],bars30:[],bars60:[],currentBar:null,dataReady:false,positions:[],signal:'WAIT',score:0,streak:0,lastDir:'WAIT',tradingEnabled:true};
    const a=state.assets[sym];
    if(a.symbolId==null) a.symbolId=hit.symbolId; // fetchHistory's response is matched back to an asset by symbolId
    if(a.bars1 && a.bars1.length>=200){
      score(a); finish(); return;
    }
    // Reuse the bot's OWN fetchHistory()/applyHistory() pair rather than
    // sending GET_TRENDBARS_REQ ourselves: applyHistory only writes bars1
    // when it finds a matching entry in state.pendingTrendbarRequests
    // (registered by fetchHistory itself), so calling fetchHistory directly
    // is what makes the response actually land in a.bars1 — a raw send()
    // here would get silently dropped by applyHistory's own pending-request
    // guard.
    if(typeof fetchHistory==='function') fetchHistory(hit.symbolId);
    const startLen=a.bars1?a.bars1.length:0;
    const deadline=Date.now()+7000;
    const poll=setInterval(()=>{
      const aa=state.assets[sym];
      const got=aa && aa.bars1 && aa.bars1.length>startLen && aa.bars1.length>=50;
      if(got || Date.now()>deadline){
        clearInterval(poll);
        if(got) score(aa);
        finish();
      }
    },500);
  });
  function score(a){
    const bars=(a.bars15&&a.bars15.length>40)?a.bars15:tfBars(a,15);
    const c=clarityScore(bars);
    if(c) results.push({key:a.key,label:a.label,dir:c.dir,score:c.score,strategy:c.strategy,strategyLabel:STRATEGY_LABELS[c.strategy],crypto:!!(SYM_DEFS[a.key]&&SYM_DEFS[a.key].weekend)});
  }
  if(!candidates.length) finish();
};

AI.acceptScanResult=function(res){
  if(!res) return;
  if(typeof selectSymbol==='function') selectSymbol(res.key);
  const sel=$('cfgStrategy');
  if(sel){ sel.value=res.strategy; if(typeof applyStrategyPreset==='function') applyStrategyPreset(); }
  if(typeof saveConfig==='function') saveConfig();
  log('AI: switched to '+res.label+' — suggested strategy '+res.strategyLabel+' ('+res.dir+' bias, clarity '+res.score+'%).');
  renderPanel();
};

// ---------------------------------------------------------------
// CHART OVERLAY — zones, active TP/SL boxes, news-time lines.
// ---------------------------------------------------------------
let overlay=null, overlayCtx=null;
function ensureOverlay(){
  const host=document.getElementById('tvChart');
  if(!host) return null;
  if(overlay && overlay.parentNode===host) return overlay;
  if(!host.style.position) host.style.position='relative';
  overlay=document.createElement('canvas');
  overlay.style.cssText='position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
  host.appendChild(overlay);
  overlayCtx=overlay.getContext('2d');
  return overlay;
}
function sizeOverlay(){
  const host=document.getElementById('tvChart');
  if(!host||!overlay) return;
  const w=host.clientWidth, h=host.clientHeight||220;
  if(overlay.width!==w||overlay.height!==h){ overlay.width=w; overlay.height=h; }
}
function drawZones(){
  if(!AI.cfg.zonesOn || !window.candleSeries || !window.tvChart) { if(overlayCtx&&overlay) overlayCtx.clearRect(0,0,overlay.width,overlay.height); return; }
  ensureOverlay(); sizeOverlay();
  if(!overlayCtx) return;
  const ctx=overlayCtx; ctx.clearRect(0,0,overlay.width,overlay.height);
  const a=state.assets[state.currentSymbol]; if(!a) return;
  const zones=AI.zones[a.key]||[];
  const w=overlay.width;
  zones.forEach(z=>{
    const yTop=candleSeries.priceToCoordinate(z.top);
    const yBot=candleSeries.priceToCoordinate(z.bottom);
    if(yTop==null||yBot==null) return;
    ctx.fillStyle=z.type==='demand'?'rgba(0,255,170,0.10)':'rgba(255,90,120,0.10)';
    ctx.strokeStyle=z.type==='demand'?'rgba(0,255,170,0.45)':'rgba(255,90,120,0.45)';
    ctx.lineWidth=1;
    ctx.fillRect(0,Math.min(yTop,yBot),w,Math.abs(yBot-yTop)||1);
    ctx.strokeRect(0,Math.min(yTop,yBot),w,Math.abs(yBot-yTop)||1);
  });
  // Active AI TP/SL projection for the open position, if any — mirrors the
  // green(target)/pink(risk) boxes projecting forward from the entry.
  if(a.positions && a.positions.length){
    const pos=a.positions[0];
    const nowX=tvChart.timeScale().timeToCoordinate(Math.floor(Date.now()/1000));
    if(nowX!=null && pos.stopLoss!=null){
      const yEntry=candleSeries.priceToCoordinate(pos.entryPrice);
      const ySl=candleSeries.priceToCoordinate(pos.stopLoss);
      if(yEntry!=null&&ySl!=null){
        ctx.fillStyle='rgba(255,60,90,0.16)';
        ctx.fillRect(nowX,Math.min(yEntry,ySl),w-nowX,Math.abs(yEntry-ySl)||1);
      }
      const tpDollars=a._aiBasketOverride||cfg.basketProfit;
      if(tpDollars){
        const dist=tpDollars/dollarPerUnitFor(pos.volume,a);
        const tpPrice=pos.side==='BUY'?pos.entryPrice+dist:pos.entryPrice-dist;
        const yTp=candleSeries.priceToCoordinate(tpPrice);
        if(yEntry!=null&&yTp!=null){
          ctx.fillStyle='rgba(0,255,120,0.16)';
          ctx.fillRect(nowX,Math.min(yEntry,yTp),w-nowX,Math.abs(yEntry-yTp)||1);
        }
      }
    }
  }
  // News-time vertical markers (reuses state.newsEvents already generated
  // by the bot's own news engine — no extra fetching).
  if(Array.isArray(state.newsEvents)){
    const visible=tvChart.timeScale().getVisibleRange();
    state.newsEvents.forEach(ev=>{
      const tSec=Math.floor(ev.time/1000);
      if(visible && (tSec<visible.from||tSec>visible.to)) return;
      const x=tvChart.timeScale().timeToCoordinate(tSec);
      if(x==null) return;
      ctx.strokeStyle='rgba(0,220,220,0.5)'; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,overlay.height); ctx.stroke(); ctx.setLineDash([]);
      ctx.save(); ctx.translate(x+3,overlay.height-6); ctx.rotate(-Math.PI/2);
      ctx.fillStyle='rgba(0,220,220,0.8)'; ctx.font='9px sans-serif';
      ctx.fillText(ev.title.includes('FOMC')?'FOMC':ev.currency, 0, 0);
      ctx.restore();
    });
  }
}

// ---------------------------------------------------------------
// UI — a small floating pill + slide-up panel. Doesn't touch any
// existing screen/DOM node other than appending itself to <body>.
// ---------------------------------------------------------------
function injectStyles(){
  const css=`
  #aiZonePill{position:fixed;right:14px;bottom:78px;z-index:9999;background:linear-gradient(135deg,#00e0c0,#00a0ff);color:#04141a;font-family:Orbitron,sans-serif;font-weight:800;font-size:11px;border:none;border-radius:20px;padding:10px 16px;box-shadow:0 4px 14px rgba(0,0,0,0.4);cursor:pointer;}
  #aiZonePill.on{box-shadow:0 0 0 2px #00ffcc,0 4px 14px rgba(0,0,0,0.4);}
  #aiZonePanel{position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#0e0e16;border-top:1px solid #2a2a3a;border-radius:16px 16px 0 0;padding:14px;max-height:70vh;overflow:auto;font-family:sans-serif;color:#e8e8f0;display:none;}
  #aiZonePanel.show{display:block;}
  #aiZonePanel h3{margin:0 0 10px;font-family:Orbitron,sans-serif;font-size:13px;color:#00e0c0;display:flex;justify-content:space-between;align-items:center;}
  #aiZonePanel .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e1e2a;font-size:12.5px;}
  #aiZonePanel .sw{width:38px;height:20px;border-radius:12px;background:#2a2a3a;position:relative;cursor:pointer;flex-shrink:0;}
  #aiZonePanel .sw.on{background:#00c896;}
  #aiZonePanel .sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;}
  #aiZonePanel .sw.on i{left:20px;}
  #aiZonePanel input[type=number]{width:60px;background:#1a1a25;border:1px solid #2a2a3a;color:#fff;border-radius:6px;padding:4px 6px;}
  #aiZonePanel .scanBtn{width:100%;margin-top:10px;background:#00c896;color:#04141a;font-weight:700;border:none;border-radius:8px;padding:10px;cursor:pointer;}
  #aiZonePanel .result{background:#161620;border:1px solid #2a2a3a;border-radius:10px;padding:10px;margin-top:8px;}
  #aiZonePanel .result .top{display:flex;justify-content:space-between;font-weight:700;font-size:12.5px;}
  #aiZonePanel .result .meta{font-size:11px;color:#9a9ab0;margin:4px 0 8px;}
  #aiZonePanel .result .btns{display:flex;gap:8px;}
  #aiZonePanel .result button{flex:1;border:none;border-radius:7px;padding:7px;font-weight:700;cursor:pointer;}
  #aiZonePanel .result .yes{background:#00c896;color:#04141a;}
  #aiZonePanel .result .no{background:#2a2a3a;color:#c8c8d8;}
  #aiZonePanel .close{background:none;border:none;color:#9a9ab0;font-size:16px;cursor:pointer;}
  `;
  const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s);
}
function sw(label,key,extra){
  return `<div class="row"><span>${label}</span><div class="sw ${AI.cfg[key]?'on':''}" data-k="${key}"><i></i></div></div>${extra||''}`;
}
function renderPanel(){
  const panel=document.getElementById('aiZonePanel'); if(!panel) return;
  panel.innerHTML=`
    <h3>AI Autopilot <button class="close" id="aiZoneClose">✕</button></h3>
    ${sw('Master switch','masterOn')}
    ${sw('Draw zones on chart','zonesOn')}
    ${sw('AI-calculated SL/TP','zoneSLTP')}
    ${sw('Confirm before entering','confirmEntries')}
    ${sw('Auto lot size (risk %)','autoLot', `<div class="row" style="border-bottom:none;padding-top:0;"><span>Risk % per trade</span><input type="number" id="aiRiskPct" step="0.1" min="0.1" max="10" value="${AI.cfg.riskPct}"></div>`)}
    ${sw('Pair/strategy scanner','scannerOn')}
    ${sw('Ghost Mode — always alternate after every close, no filter, no wait','ghostMode')}
    <button class="scanBtn" id="aiScanNow">${AI.scan.running?'Scanning…':'Scan pairs now'}</button>
    <div id="aiResults"></div>
  `;
  const results=document.getElementById('aiResults');
  if(AI.scan.results.length){
    results.innerHTML=AI.scan.results.slice(0,5).map((r,i)=>`
      <div class="result" data-i="${i}">
        <div class="top"><span>${r.label}</span><span>${r.dir} · ${r.grade?('grade '+r.grade+' · '+r.score+'/100'):(r.score+'% clean')}</span></div>
        <div class="meta">${r.note?(r.note+' · '):''}Suggested strategy: ${r.strategyLabel}</div>
        <div class="btns"><button class="yes" data-i="${i}">Accept</button><button class="no" data-i="${i}">No</button></div>
      </div>`).join('');
  } else {
    results.innerHTML='<div class="meta" style="margin-top:8px;">'+(AI.scan.lastRun?'No valid setup right now — waiting is a position.':'No scan yet.')+'</div>';
  }
  panel.querySelectorAll('.sw').forEach(el=>{
    el.onclick=()=>{ const k=el.getAttribute('data-k'); AI.cfg[k]=!AI.cfg[k]; saveCfg(); renderPanel(); updatePillState(); };
  });
  const riskInput=document.getElementById('aiRiskPct');
  if(riskInput) riskInput.onchange=()=>{ AI.cfg.riskPct=parseFloat(riskInput.value)||1; saveCfg(); };
  const closeBtn=document.getElementById('aiZoneClose');
  if(closeBtn) closeBtn.onclick=()=>panel.classList.remove('show');
  const scanBtn=document.getElementById('aiScanNow');
  if(scanBtn) scanBtn.onclick=()=>{ AI.scanPairs(()=>renderPanel()); renderPanel(); };
  results.querySelectorAll('.yes').forEach(btn=>btn.onclick=()=>AI.acceptScanResult(AI.scan.results[+btn.getAttribute('data-i')]));
  results.querySelectorAll('.no').forEach(btn=>btn.onclick=()=>{ AI.scan.results.splice(+btn.getAttribute('data-i'),1); renderPanel(); });
}
function updatePillState(){
  const pill=document.getElementById('aiZonePill');
  if(pill) pill.classList.toggle('on',AI.cfg.masterOn);
}
function injectUI(){
  injectStyles();
  const pill=document.createElement('button'); pill.id='aiZonePill'; pill.textContent='🤖 AI v7';
  pill.onclick=()=>{ const p=document.getElementById('aiZonePanel'); p.classList.toggle('show'); renderPanel(); };
  document.body.appendChild(pill);
  const panel=document.createElement('div'); panel.id='aiZonePanel';
  document.body.appendChild(panel);
  updatePillState();
}

// ---------------------------------------------------------------
// TICK LOOP
// ---------------------------------------------------------------
let _subscribedToChart=false;
function tick(){
  try{
    if(!HAVE_CORE) return;
    // tvChart itself is only created once initChart() runs (after connecting),
    // which can easily be after this module's boot() already ran — so keep
    // trying to attach the pan/zoom redraw hook here instead of just once at
    // boot, until it actually succeeds.
    if(!_subscribedToChart && window.tvChart && window.tvChart.timeScale){
      try{ window.tvChart.timeScale().subscribeVisibleTimeRangeChange(drawZones); _subscribedToChart=true; }catch(e){}
    }
    const a=state.assets[state.currentSymbol];
    if(a && a.dataReady) detectZones(a);
    drawZones();
    if(AI.cfg.masterOn && AI.cfg.scannerOn && Date.now()-AI.scan.lastRun>90000){
      // FIX ("AI autopilot isn't giving anything"): scan results only ever
      // showed up inside the panel UI, so with the panel closed it looked
      // like nothing was happening even though a scan ran every 90s. Now it
      // posts a one-line summary to the activity log every run, whether or
      // not you have the panel open.
      AI.scanPairs(function(results){
        renderPanel();
        const top=results&&results[0];
        if(top&&top.dir&&top.label){
          log('AI scan: cleanest setup is '+top.label+' — '+top.dir+' bias, clarity '+top.score+'%, suggested '+(top.strategyLabel||top.strategy||'unknown')+'. Open the AI panel to accept it.');
        }else{
          log('AI scan: no clean setup across your pairs right now.');
        }
      });
    }
  }catch(e){ /* never let a scan/draw hiccup take down the trading loop */ }
}

function boot(){
  if(!document.getElementById('tvChart')){ setTimeout(boot,500); return; }
  injectUI();
  ensureOverlay(); sizeOverlay();
  window.addEventListener('resize',()=>{ sizeOverlay(); drawZones(); });
  setInterval(tick,4000);
  log('AI Zone Strategist v7 loaded — tap the AI pill (now labeled "AI v7" — check it says v7) to configure. Master switch is OFF by default; nothing it does affects your trades until you turn it on.');
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
else boot();

})();
