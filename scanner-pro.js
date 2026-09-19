/* ================================================================
   SCANNER PRO — professional pair scanner + Megan link + AI Autopilot hooks + win-rate panel
   for Trade Port EA / Megan.
   ----------------------------------------------------------------
   Loads AFTER ai-zone-strategist.js and win-tracker.js. It changes nothing in
   index.html: it wraps a few already-global functions (executeTrade, manualTrade,
   checkExits, maybeAddStackLeg, meganAutoTick) and adds its own 📡 pill + panel.
   Every entry still goes through the bot's own executeTrade() — same SL/TP/lot
   sizing, spread check, Arm-Live block and daily-loss limit. Nothing here
   bypasses them.
   ================================================================ */
(function(){
'use strict';
/*ENGINE-START*/
const Engine=(function(){
'use strict';

/* ---------------------------------------------------------------
   PURE SIGNAL ENGINE — no DOM, no broker calls, no globals from the
   bot. Input: closed 1-minute candles + the live price. Output: either
   a fully specified setup (side, entry, stop, target, reward:risk,
   score, reasons) or an explicit "no trade" with the reasons why.
   Works on CLOSED candles only, so a signal never repaints.

   It trades three well-known, rule-based patterns, always with the
   higher-timeframe trend, and refuses anything that fails a hard gate:
     1. TREND PULLBACK  — 15m/60m trend up (or down), price pulls back to
        the 5m 21/50 EMA "value" area, RSI resets and turns, and a
        reclaim candle closes back with the trend.
     2. ZONE REJECTION  — price wicks into a 15m support/resistance zone
        that has been respected 3+ times and closes back out of it.
     3. RANGE BREAKOUT  — tight 5m consolidation in quiet volatility,
        broken by a strong closing candle with the trend.
   Every setup must have a stop beyond real structure and a target at
   the next real level with at least the required reward:risk.

   The score is a rules-checklist quality score, NOT a win probability.
   --------------------------------------------------------------- */

const DEF={minScore:70, minRR:1.5, gradeA:82};

function median(a){ if(!a.length) return 0; const s=a.slice().sort((x,y)=>x-y), m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function emaArr(v,p){
  const out=new Array(v.length).fill(null); if(v.length<p) return out;
  let e=0; for(let i=0;i<p;i++) e+=v[i]; e/=p; out[p-1]=e; const k=2/(p+1);
  for(let i=p;i<v.length;i++){ e=v[i]*k+e*(1-k); out[i]=e; }
  return out;
}
function rsiArr(v,p){
  const out=new Array(v.length).fill(null); if(v.length<=p) return out;
  let g=0,l=0; for(let i=1;i<=p;i++){ const d=v[i]-v[i-1]; if(d>0) g+=d; else l-=d; }
  let ag=g/p, al=l/p; out[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<v.length;i++){ const d=v[i]-v[i-1]; ag=(ag*(p-1)+Math.max(d,0))/p; al=(al*(p-1)+Math.max(-d,0))/p; out[i]=al===0?100:100-100/(1+ag/al); }
  return out;
}
function atrArr(b,p){
  const out=new Array(b.length).fill(null); if(b.length<=p) return out;
  const tr=[0]; for(let i=1;i<b.length;i++) tr.push(Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c)));
  let a=0; for(let i=1;i<=p;i++) a+=tr[i]; a/=p; out[p]=a;
  for(let i=p+1;i<b.length;i++){ a=(a*(p-1)+tr[i])/p; out[i]=a; }
  return out;
}
// Confirmed pivots only (k bars on each side) — the last k bars can never be a pivot, so nothing repaints.
function swings(b,k){
  const hi=[],lo=[];
  for(let i=k;i<b.length-k;i++){
    let isH=true,isL=true;
    for(let j=1;j<=k;j++){
      if(b[i].h<=b[i-j].h||b[i].h<b[i+j].h) isH=false;
      if(b[i].l>=b[i-j].l||b[i].l>b[i+j].l) isL=false;
    }
    if(isH) hi.push({i,p:b[i].h,t:b[i].t});
    if(isL) lo.push({i,p:b[i].l,t:b[i].t});
  }
  return {hi,lo};
}
function structureOf(sw){
  const H=sw.hi.slice(-2), L=sw.lo.slice(-2); if(H.length<2||L.length<2) return 0;
  if(H[1].p>H[0].p&&L[1].p>L[0].p) return 1;
  if(H[1].p<H[0].p&&L[1].p<L[0].p) return -1;
  return 0;
}
function biasFrom(c,ef,es,av,n){
  if(n<4||av[n]==null||ef[n]==null||es[n]==null||es[n-3]==null) return {dir:0,sep:0,ok:false};
  const sep=(ef[n]-es[n])/av[n], slope=(es[n]-es[n-3])/av[n];
  let dir=0; if(sep>0.15&&c[n]>es[n]&&slope>=0) dir=1; else if(sep<-0.15&&c[n]<es[n]&&slope<=0) dir=-1;
  return {dir,sep,slope,ok:true};
}
// Kaufman efficiency ratio: net move / total path over N bars. ~0 = choppy noise, ~1 = clean trend.
function erOf(c,N){
  const n=c.length-1; if(n<N) return null;
  let path=0; for(let i=n-N+1;i<=n;i++) path+=Math.abs(c[i]-c[i-1]);
  return path>0?Math.abs(c[n]-c[n-N])/path:0;
}
function buildZones(b15,a15){
  if(!a15) return [];
  const s=swings(b15,3), tol=a15*0.4, zs=[];
  function add(list,type){ list.forEach(p=>{
    const z=zs.find(z=>z.type===type&&Math.abs(z.mid-p.p)<=tol);
    if(z){ z.pts.push(p.p); z.mid=z.pts.reduce((x,y)=>x+y,0)/z.pts.length; z.touches++; z.lastI=Math.max(z.lastI,p.i); }
    else zs.push({type,pts:[p.p],mid:p.p,touches:1,lastI:p.i});
  }); }
  add(s.hi,'supply'); add(s.lo,'demand');
  return zs.filter(z=>z.touches>=2).map(z=>({type:z.type,top:Math.max(...z.pts)+a15*0.05,bottom:Math.min(...z.pts)-a15*0.05,mid:z.mid,touches:z.touches,age:b15.length-1-z.lastI}));
}
function aggregate(bars1,mins,closeTime){
  const ms=mins*60000, out=[]; let cur=null;
  for(let i=0;i<bars1.length;i++){
    const x=bars1[i], k=Math.floor(x.t/ms)*ms;
    if(!cur||cur.t!==k){ if(cur) out.push(cur); cur={t:k,o:x.o,h:x.h,l:x.l,c:x.c}; }
    else{ if(x.h>cur.h) cur.h=x.h; if(x.l<cur.l) cur.l=x.l; cur.c=x.c; }
  }
  if(cur) out.push(cur);
  if(out.length&&closeTime<out[out.length-1].t+ms) out.pop();   // last bucket still forming -> not a closed candle
  return out;
}
function closedBars(bars1,now){ let n=bars1.length; while(n>0&&bars1[n-1].t+60000>now) n--; return n===bars1.length?bars1:bars1.slice(0,n); }
function mirror(b){ return b.map(x=>({t:x.t,o:-x.o,h:-x.l,l:-x.h,c:-x.c})); }
function fxClosed(now){ const d=new Date(now), day=d.getUTCDay(), h=d.getUTCHours(); return day===6||(day===5&&h>=22)||(day===0&&h<22); }
function inRollover(now){ const d=new Date(now), m=d.getUTCHours()*60+d.getUTCMinutes(); return m>=21*60+55&&m<23*60+5; }
function sessionHour(now){ return new Date(now).getUTCHours(); }

function prepView(b5,b15,b60,price){
  const V={b5,b15,b60,price};
  V.c5=b5.map(x=>x.c); V.e21=emaArr(V.c5,21); V.e50=emaArr(V.c5,50); V.rsi5=rsiArr(V.c5,14); V.atr5=atrArr(b5,14);
  const c15=b15.map(x=>x.c), e20=emaArr(c15,20), e50=emaArr(c15,50); V.atr15=atrArr(b15,14);
  const n15=b15.length-1; V.a15=V.atr15[n15]; V.rsi15=rsiArr(c15,14); V.e20_15=e20;
  V.bias15=biasFrom(c15,e20,e50,V.atr15,n15); V.er15=erOf(c15,24);
  V.sw15=swings(b15,3); V.sw15s=swings(b15,2); V.sw5=swings(b5,3);
  V.struct15=structureOf(V.sw15s);
  if(b60.length>=34){ const c60=b60.map(x=>x.c); V.bias60=biasFrom(c60,emaArr(c60,10),emaArr(c60,30),atrArr(b60,14),b60.length-1); }
  else V.bias60={dir:0,sep:0,ok:false};
  V.zones=buildZones(b15,V.a15);
  return V;
}
function regimeOf(atrA,n){
  const w=atrA.slice(Math.max(0,n-99),n+1).filter(x=>x!=null);
  if(w.length<30||!atrA[n]) return {ratio:1,ok:false};
  const med=median(w); return {ratio:atrA[n]/med,med,ok:true};
}
// Significant resistance above price (long orientation): 15m swing highs + supply zone floors.
function resistanceAbove(V,price){
  const out=[];
  V.sw15.hi.forEach(h=>{ if(h.p>price) out.push(h.p); });
  V.zones.forEach(z=>{ if(z.type==='supply'&&z.bottom>price) out.push(z.bottom); });
  return out.sort((a,b)=>a-b)[0];
}
// Shared: target from the next real level (min 0.1 ATR short of it), capped at 3R, or 2.5R in open space.
function targetFor(V,entry,risk,atr,minRR){
  const R1=resistanceAbove(V,entry);
  let tp, note;
  if(R1!=null){
    tp=Math.min(R1-0.1*atr, entry+3*risk); note='target at next resistance';
    const room=(tp-entry)/risk;
    if(room<minRR) return {fail:'next resistance leaves only '+Math.max(0,room).toFixed(1)+'R — not enough room'};
  } else { tp=entry+2.5*risk; note='no resistance overhead — 2.5R target'; }
  return {tp,rr:(tp-entry)/risk,note};
}
function commonPts(V,W,rr,reg,now,crypto){
  let p=0; const r=[],w=[];
  if(V.bias60.dir===1){p+=10;r.push('60m trend '+W.up);}
  else if(V.bias60.dir===-1){p-=6;w.push('60m trend is against this trade');}
  else{p+=4;w.push('60m trend neutral / not available');}
  if(V.struct15===1){p+=10;r.push('15m '+W.struct);}
  else if(V.struct15===0){p+=3;}
  else{p-=8;w.push('15m structure is against this trade');}
  if(V.bias15.sep>=0.8){p+=5;r.push('strong 15m trend');}
  if(V.er15!=null&&V.er15>=0.4&&V.bias15.dir===1){p+=5;r.push('clean, efficient trend');}
  if(reg.ok&&reg.ratio>=0.7&&reg.ratio<=1.8){p+=8;r.push('healthy volatility');}
  else if(reg.ok&&reg.ratio>=0.55){p+=3;w.push('volatility on the quiet side');}
  if(rr>=3){p+=12;r.push('reward:risk '+rr.toFixed(1));}
  else if(rr>=2){p+=8;r.push('reward:risk '+rr.toFixed(1));}
  else if(rr>=1.5){p+=4;r.push('reward:risk '+rr.toFixed(1));}
  const h=sessionHour(now); if(!crypto&&h>=7&&h<17){p+=4;r.push('London/New York hours');}
  return {p,r,w};
}

// ---- Setup 1: trend pullback (long orientation) ----
function pullback(V,X){
  const b=V.b5,n=b.length-1,atr=V.atr5[n],e21=V.e21,e50=V.e50,rsi=V.rsi5,W=X.W;
  if(!atr||e21[n]==null||e50[n]==null||rsi[n]==null||rsi[n-1]==null) return {fail:'not enough data'};
  if(V.bias15.dir!==1) return {fail:'15m trend is not '+W.up};
  if(V.bias60.dir===-1) return {fail:'60m trend is against this direction'};
  if(V.er15!=null&&V.er15<0.30) return {fail:'market is choppy (15m efficiency '+V.er15.toFixed(2)+') — trend setups skipped'};
  let touched=false,swingLow=Infinity;
  for(let i=n-5;i<=n;i++){ if(b[i].l<swingLow) swingLow=b[i].l; if(b[i].l<=e21[i]+0.15*atr) touched=true; }
  if(!touched) return {fail:'waiting for a pullback to the 5m 21 EMA'};
  for(let i=n-7;i<=n;i++) if(b[i].c<e50[i]-0.3*atr) return {fail:'pullback broke the 50 EMA — trend not intact'};
  if(b[n].c<=e50[n]) return {fail:'price is below the 50 EMA'};
  let minR=100; for(let i=n-7;i<=n-1;i++) if(rsi[i]!=null&&rsi[i]<minR) minR=rsi[i];
  if(!(minR<=52&&rsi[n]>rsi[n-1]&&rsi[n]>=42&&rsi[n]<=68)) return {fail:'waiting for RSI to reset and turn '+W.up};
  const t=b[n],rng=t.h-t.l,body=t.c-t.o;
  if(!(rng>0&&t.c>t.o&&t.c>e21[n]&&rng>=0.6*atr&&body/rng>=0.45&&(t.c-t.l)/rng>=0.6)) return {fail:'waiting for a strong reclaim candle'};
  const price=V.price;
  if(price-t.c>0.5*atr) return {fail:'price already ran away from the trigger (no chasing)'};
  if(price<(t.h+t.l)/2) return {fail:'price fell back under the trigger candle'};
  if(V.rsi15[V.rsi15.length-1]>78||price>V.e20_15[V.e20_15.length-1]+2.5*V.a15) return {fail:'15m is overbought/extended'};
  let sl=Math.min(swingLow,e50[n]-0.3*atr)-0.2*atr;
  const dz=V.zones.find(z=>z.type==='demand'&&swingLow>=z.bottom-0.1*atr&&swingLow<=z.top+0.5*atr);
  if(dz) sl=Math.min(sl,dz.bottom-0.1*atr);
  const risk=price-sl;
  if(risk<0.7*atr) return {fail:'stop would be too tight (noise)'};
  if(risk>3*atr) return {fail:'stop would be too wide'};
  const tg=targetFor(V,price,risk,atr,X.minRR); if(tg.fail) return {fail:tg.fail};
  const cp=commonPts(V,W,tg.rr,X.reg,X.now,X.crypto); let p=15+cp.p; const r=['15m trend '+W.up].concat(cp.r), w=cp.w.slice();
  if(Math.abs(t.c-e21[n])<=atr){p+=8;r.push('pulled back to the 21 EMA');}
  if(dz){p+=10;r.push('pullback held a '+W.zone+' zone ('+dz.touches+' touches)');}
  p+=10; r.push('RSI reset to '+minR.toFixed(0)+' and turned '+W.up);
  p+=8; r.push('strong reclaim candle');
  if(t.c>b[n-1].h){p+=4;r.push('engulfs the prior candle');}
  return {type:'pullback',label:'Trend pullback',score:p,entry:price,sl,tp:tg.tp,rr:tg.rr,risk,atr,trigT:t.t,reasons:r,warns:w,tpNote:tg.note};
}
// ---- Setup 2: zone rejection ----
function zoneReject(V,X){
  const b=V.b5,n=b.length-1,atr=V.atr5[n],rsi=V.rsi5,W=X.W;
  if(!atr||rsi[n]==null) return {fail:'not enough data'};
  const t=b[n],rng=t.h-t.l,lowWick=Math.min(t.o,t.c)-t.l;
  if(V.bias15.dir===-1&&(V.bias15.sep<-0.8||(V.er15!=null&&V.er15>=0.3))) return {fail:'strong 15m trend against a bounce'};
  let best=null;
  V.zones.forEach(z=>{
    if(z.type!=='demand'||z.touches<3) return;
    if(!(t.l<=z.top&&t.l>=z.bottom-0.6*atr&&t.c>z.top)) return;
    if(!best||z.touches>best.touches) best=z;
  });
  if(!best) return {fail:'no tested zone being rejected'};
  if(!(rng>=0.6*atr&&t.c>t.o&&lowWick>=0.5*rng)) return {fail:'no clear rejection wick'};
  let minR=100; for(let i=n-3;i<=n;i++) if(rsi[i]!=null&&rsi[i]<minR) minR=rsi[i];
  if(minR>40) return {fail:'RSI was not stretched at the zone'};
  const price=V.price;
  if(price-t.c>0.5*atr) return {fail:'price already ran away from the trigger (no chasing)'};
  const sl=Math.min(best.bottom,t.l)-0.25*atr, risk=price-sl;
  if(risk<0.7*atr) return {fail:'stop would be too tight (noise)'};
  if(risk>3*atr) return {fail:'stop would be too wide'};
  const tg=targetFor(V,price,risk,atr,Math.max(X.minRR,1.8)); if(tg.fail) return {fail:tg.fail};
  const cp=commonPts(V,W,tg.rr,X.reg,X.now,X.crypto); let p=cp.p; const r=cp.r.slice(), w=cp.w.slice();
  p+=best.touches>=4?15:10; r.push(W.zone+' zone respected '+best.touches+' times');
  p+=10; r.push('rejection wick '+(100*lowWick/rng).toFixed(0)+'% of the candle');
  p+=minR<=32?10:6; r.push('RSI stretched to '+minR.toFixed(0));
  if(V.bias15.dir===1){p+=10;r.push('15m trend '+W.up);} else if(V.bias15.dir===0){p+=5;w.push('15m is ranging — a mean-reversion trade');}
  if(best.age<=60){p+=5;r.push('recently tested zone');}
  return {type:'zone',label:'Zone rejection',score:p,entry:price,sl,tp:tg.tp,rr:tg.rr,risk,atr,trigT:t.t,reasons:r,warns:w,tpNote:tg.note};
}
// ---- Setup 3: range breakout ----
function breakout(V,X){
  const b=V.b5,n=b.length-1,W=X.W,L=18;
  const atr=V.atr5[n-1]; if(!atr||n<L+2) return {fail:'not enough data'};
  if(V.bias15.dir!==1) return {fail:'15m trend is not '+W.up};
  if(V.bias60.dir===-1) return {fail:'60m trend is against this direction'};
  if(V.er15!=null&&V.er15<0.28) return {fail:'market is choppy (15m efficiency '+V.er15.toFixed(2)+') — breakouts skipped'};
  let bh=-Infinity,bl=Infinity; for(let i=n-L;i<n;i++){ if(b[i].h>bh) bh=b[i].h; if(b[i].l<bl) bl=b[i].l; }
  const range=bh-bl; if(range>3.2*atr) return {fail:'no tight consolidation'};
  const reg=X.reg; let atrAvg=0,cnt=0; for(let i=n-L;i<n;i++) if(V.atr5[i]!=null){atrAvg+=V.atr5[i];cnt++;}
  atrAvg=cnt?atrAvg/cnt:atr; if(reg.ok&&atrAvg>1.05*reg.med) return {fail:'volatility already expanded before the break'};
  const t=b[n],rng=t.h-t.l,body=t.c-t.o;
  if(!(rng>0&&t.c>bh+0.1*atr&&t.c>t.o&&body/rng>=0.6&&rng>=1.2*atr&&(t.c-t.l)/rng>=0.75)) return {fail:'waiting for a strong breakout close'};
  const price=V.price;
  if(price>bh+1.3*atr||price<t.c-0.5*atr) return {fail:'price already ran away from the breakout (no chasing)'};
  const sl=Math.min(t.l,bh-0.6*atr)-0.15*atr, risk=price-sl;
  if(risk<0.7*atr) return {fail:'stop would be too tight (noise)'};
  if(risk>2.5*atr) return {fail:'stop would be too wide'};
  const tg=targetFor(V,price,risk,atr,X.minRR); if(tg.fail) return {fail:tg.fail};
  const cp=commonPts(V,W,tg.rr,X.reg,X.now,X.crypto); let p=15+cp.p; const r=['15m trend '+W.up].concat(cp.r), w=cp.w.slice();
  p+=range<=2.2*atr?10:5; r.push('tight '+(range/atr).toFixed(1)+' ATR range before the break');
  p+=12; r.push('strong breakout close');
  return {type:'breakout',label:'Range breakout',score:p,entry:price,sl,tp:tg.tp,rr:tg.rr,risk,atr,trigT:t.t,reasons:r,warns:w,tpNote:tg.note};
}
function evalLong(V,X){
  const out={cand:null,fails:[],watch:0,waiting:''};
  if(!V.a15||V.atr5[V.b5.length-1]==null){ out.fails.push('not enough data'); return out; }
  X.reg=regimeOf(V.atr5,V.b5.length-1);
  if(V.bias15.dir===1){
    out.watch=15+(V.bias60.dir===1?10:V.bias60.dir===0?4:-10)+(V.struct15===1?10:0)+Math.min(15,Math.max(0,V.bias15.sep)*10);
  }
  const cands=[];
  [pullback,zoneReject,breakout].forEach(fn=>{
    const r=fn(V,X);
    if(r.fail){ out.fails.push(r.fail); if(fn===pullback&&V.bias15.dir===1&&!out.waiting) out.waiting=r.fail; }
    else cands.push(r);
  });
  if(!out.waiting){ const f=out.fails.find(x=>/waiting/.test(x)); if(f) out.waiting=f; }
  cands.sort((a,b)=>b.score-a.score); out.cand=cands[0]||null;
  return out;
}
const WORDS={
  long:{up:'up',struct:'higher highs & higher lows',zone:'demand'},
  short:{up:'down',struct:'lower highs & lower lows',zone:'supply'}
};

/* analyze(inp) — inp: {bars1, now, price, crypto, spread, news, minScore, minRR, skipFresh}
   bars1 = 1-minute candles (may include the forming one; it is dropped). */
function analyze(inp){
  const now=inp.now||Date.now(), minScore=inp.minScore!=null?inp.minScore:DEF.minScore, minRR=inp.minRR||DEF.minRR;
  const res={ok:false,side:null,type:null,label:'',score:0,grade:'',entry:null,sl:null,tp:null,rr:null,risk:null,atr:null,id:null,t:now,
    reasons:[],warns:[],blockers:[],waiting:'',watch:{side:null,score:0},bestSide:null,bestScore:0,bias:{d15:0,d60:0,struct:0},valid:false};
  const bars=inp.bars1||[];
  if(bars.length<300){ res.blockers.push('Not enough candle history yet ('+bars.length+'/300 one-minute bars)'); return res; }
  const cb=closedBars(bars,now); if(cb.length<300){ res.blockers.push('Not enough closed candles yet'); return res; }
  const closeT=cb[cb.length-1].t+60000;
  if(!inp.skipFresh&&now-closeT>6*60000){ res.blockers.push('Candle data is stale ('+Math.round((now-closeT)/60000)+' min old)'); return res; }
  const b5=aggregate(cb,5,closeT), b15=aggregate(cb,15,closeT), b60=aggregate(cb,60,closeT);
  if(b5.length<120||b15.length<60){ res.blockers.push('Need ~10 hours of history for the 15m trend (have '+b5.length+' × 5m, '+b15.length+' × 15m)'); return res; }
  const price=inp.price||cb[cb.length-1].c;
  if(!inp.crypto&&fxClosed(now)) res.blockers.push('Market closed (weekend)');
  else if(!inp.crypto&&inRollover(now)) res.blockers.push('Daily rollover window — spreads widen, no new entries');
  if(inp.news&&inp.news.length){
    const ev=inp.news.find(e=>e.impact==='high'&&now>=e.time-10*60000&&now<=e.time+20*60000);
    if(ev) res.blockers.push('High-impact news window: '+ev.title+' (bot calendar is approximate)');
  }
  const VL=prepView(b5,b15,b60,price), VS=prepView(mirror(b5),mirror(b15),mirror(b60),-price);
  const XL={W:WORDS.long,now,crypto:!!inp.crypto,minRR}, XS={W:WORDS.short,now,crypto:!!inp.crypto,minRR};
  const L=evalLong(VL,XL), S=evalLong(VS,XS);
  res.bias={d15:VL.bias15.dir,d60:VL.bias60.dir,struct:VL.struct15};
  const reg=XL.reg||{ratio:1,ok:false}; res.regime=reg;
  const cands=[];
  if(L.cand) cands.push(Object.assign({side:'BUY'},L.cand));
  if(S.cand){ const c=S.cand; cands.push(Object.assign({side:'SELL'},c,{entry:-c.entry,sl:-c.sl,tp:-c.tp})); }
  cands.sort((a,b)=>b.score-a.score);
  res.watch=L.watch>=S.watch?{side:'BUY',score:Math.round(Math.max(0,L.watch))}:{side:'SELL',score:Math.round(Math.max(0,S.watch))};
  res.waiting=(L.watch>=S.watch?L.waiting:S.waiting)||(res.watch.score<15?'no clear 15m trend — nothing to trade with':'');
  const c=cands[0];
  if(reg.ok&&reg.ratio<0.55) res.blockers.push('Volatility too low (dead market)');
  if(reg.ok&&reg.ratio>2.6) res.blockers.push('Volatility spike — waiting for calm');
  if(!c){ if(!res.waiting) res.waiting=(L.fails[0]||'no setup pattern present'); return res; }
  const score=Math.max(0,Math.min(100,Math.round(c.score)));
  res.side=c.side; res.bestSide=c.side; res.bestScore=score; res.type=c.type; res.label=c.label;
  res.score=score; res.entry=c.entry; res.sl=c.sl; res.tp=c.tp; res.rr=c.rr; res.risk=c.risk; res.atr=c.atr;
  res.reasons=c.reasons; res.warns=c.warns; res.tpNote=c.tpNote; res.trigT=c.trigT;
  res.id=(inp.key||'x')+'|'+c.type+'|'+c.side+'|'+c.trigT;
  if(inp.spread!=null&&Number.isFinite(inp.spread)&&inp.spread>0.15*c.risk) res.blockers.push('Spread too wide versus the stop ('+(100*inp.spread/c.risk).toFixed(0)+'% of risk)');
  if(score<minScore) res.blockers.push('Score '+score+' is below your minimum of '+minScore);
  res.grade=score>=DEF.gradeA?'A':(score>=minScore?'B':'');
  res.ok=res.valid=res.blockers.length===0;
  return res;
}

/* replay(bars1, opts) — walk-forward over the candles that are loaded: at each 5m close run the SAME
   analyze() using only data available at that moment, then simulate the trade forward on 1m candles.
   Conservative: if stop and target are both touched inside one 1m candle the stop counts first.
   No spread / commission / slippage is modelled, so real results will be somewhat worse. */
function replay(bars1,opts){
  opts=opts||{};
  const all=closedBars(bars1,opts.now||Date.now()), n1=all.length;
  const out={signals:0,wins:0,losses:0,timeouts:0,totalR:0,grossWin:0,grossLoss:0,maxLossStreak:0,hours:0,trades:[]};
  if(n1<600) return out;
  out.hours=(all[n1-1].t-all[0].t)/3600000;
  const closeAll=all[n1-1].t+60000;
  const A5=aggregate(all,5,closeAll);
  let busyUntil=0, streak=0;
  // 1m index lookup by time
  function idxAfter(T){ let lo=0,hi=n1; while(lo<hi){ const m=(lo+hi)>>1; if(all[m].t<T) lo=m+1; else hi=m; } return lo; }
  for(let i=120;i<A5.length-1;i++){
    const T=A5[i].t+5*60000; if(T<busyUntil) continue;
    const k=idxAfter(T); if(k>=n1-1) break;
    const s=analyze({bars1:all.slice(0,k),now:T,price:A5[i].c,crypto:opts.crypto,minScore:opts.minScore,minRR:opts.minRR,skipFresh:true,key:'replay'});
    if(!s.ok) continue;
    out.signals++;
    const dir=s.side==='BUY'?1:-1; let res=null, endT=T;
    const maxBars=opts.maxBars||360;
    for(let j=k;j<Math.min(n1,k+maxBars);j++){
      const bar=all[j], hitSL=dir===1?bar.l<=s.sl:bar.h>=s.sl, hitTP=dir===1?bar.h>=s.tp:bar.l<=s.tp;
      if(hitSL){ res=-1; endT=bar.t+60000; break; }
      if(hitTP){ res=s.rr; endT=bar.t+60000; break; }
      if(j===Math.min(n1,k+maxBars)-1){ res=dir*(bar.c-s.entry)/s.risk; endT=bar.t+60000; out.timeouts++; }
    }
    if(res==null) continue;
    busyUntil=endT; out.totalR+=res;
    if(res>0){ out.wins++; out.grossWin+=res; streak=0; } else { out.losses++; out.grossLoss+=-res; streak++; if(streak>out.maxLossStreak) out.maxLossStreak=streak; }
    out.trades.push({t:T,side:s.side,type:s.type,score:s.score,r:res});
  }
  const n=out.wins+out.losses;
  out.trades_n=n; out.winRate=n?out.wins/n:null; out.avgR=n?out.totalR/n:null; out.pf=out.grossLoss>0?out.grossWin/out.grossLoss:(out.grossWin>0?Infinity:null);
  return out;
}

return {analyze,replay,aggregate,closedBars,fxClosed,DEF,_internal:{emaArr,rsiArr,atrArr,swings,buildZones,mirror,prepView}};
})();
/*ENGINE-END*/

/* ================================================================
   HOST INTEGRATION — everything below attaches to the running bot.
   ================================================================ */
window.ScannerProEngine=Engine;
function has(n){ try{ return (0,eval)('typeof '+n)!=='undefined'; }catch(e){ return false; } }
const NEED=['state','cfg','SYM_DEFS','STRATEGY_LABELS','executeTrade','manualTrade','checkExits','log','$','dollarPerUnitFor','lotSizeFor','digitsFor','fetchHistory','norm','selectSymbol'];
const MISSING=NEED.filter(n=>!has(n));
if(MISSING.length){ console.warn('[ScannerPro] missing host globals: '+MISSING.join(', ')+' — scanner disabled.'); return; }

const LS='tpea_scannerpro_cfg';
function loadCfg(){ try{ return JSON.parse(localStorage.getItem(LS))||{}; }catch(e){ return {}; } }
function saveCfg(){ try{ localStorage.setItem(LS,JSON.stringify(SP.cfg)); }catch(e){} }
const SP=window.ScannerPro={
  cfg:Object.assign({minScore:70,minRR:1.5,gateOn:true,meganVeto:true,speakAlerts:true},loadCfg()),
  st:{running:false,results:[],lastRun:0,done:0,total:0,skipped:[]},
  live:{}, cache:{}, fired:{}, alerted:{}, offer:null, pending:null, tab:'sig', winTab:null, replay:null, lastSpoken:0
};
const AI=()=>window.AIZone||null;
const isCrypto=k=>!!(SYM_DEFS[k]&&SYM_DEFS[k].weekend);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmt(a,x){ if(x==null||!Number.isFinite(x)) return '—'; const d=Math.min(5,(a&&digitsFor(a))||2); return x.toFixed(d); }
function say(t){ try{ if(window.Megan&&Megan.voice) Megan.voice.speak(t); else log(t); }catch(e){ log(t); } }
function fxClosedNow(){ return Engine.fxClosed(Date.now()); }
function anyOpenPositions(exceptKey){ return Object.values(state.assets).some(x=>x.key!==exceptKey&&x.positions&&x.positions.length); }

// ---------------------------------------------------------------
// EVALUATION — real closed candles + the live price.
// ---------------------------------------------------------------
SP.evaluate=function(a,opts){
  opts=opts||{};
  if(!a){ return {ok:false,blockers:['No pair selected'],reasons:[],warns:[],watch:{side:null,score:0},score:0,t:Date.now(),key:null,label:'',pair:''}; }
  const isLive=a.key===state.currentSymbol&&a.tradingEnabled!==false&&!!a.dataReady;
  const bars=a.bars1||[];
  const px=isLive&&a.lastPrice?a.lastPrice:(bars.length?bars[bars.length-1].c:undefined);
  let spread=null; if(isLive&&a.bid&&a.ask&&a.ask>=a.bid) spread=a.ask-a.bid;
  const r=Engine.analyze({bars1:bars,now:opts.now||Date.now(),price:px,crypto:isCrypto(a.key),spread,news:Array.isArray(state.newsEvents)?state.newsEvents:null,key:a.key,minScore:SP.cfg.minScore,minRR:SP.cfg.minRR});
  r.key=a.key; r.pair=a.label||a.key; r.live=isLive; r.digits=digitsFor(a);
  return r;
};
SP.cached=function(a,force){
  const c=SP.cache[a.key];
  if(!force&&c&&Date.now()-c.t<2000) return c.s;
  const s=SP.evaluate(a); SP.cache[a.key]={t:Date.now(),s}; SP.live[a.key]=s; return s;
};
SP.fresh=function(a,side){ const s=SP.live[a.key]; return (s&&s.ok&&s.side===side&&Date.now()-s.t<90000)?s:null; };
const STRAT={pullback:'emaPullback',zone:'rsiExtreme',breakout:'structure'};

// ---------------------------------------------------------------
// SCAN — refreshes candles for every open market, one small batch at a time, then ranks them.
// ---------------------------------------------------------------
function mkAsset(key,def,hit){
  return {key,label:def.label,name:def.name,symbolId:hit.symbolId,full:hit,lastPrice:0,bid:null,ask:null,bars1:[],bars5:[],bars15:[],bars30:[],bars60:[],currentBar:null,dataReady:false,positions:[],signal:'WAIT',score:0,streak:0,lastDir:'WAIT',lastTradeAt:0,lastCloseAt:0,floatingPnL:0,emaFast:null,emaSlow:null,emaTrend:null,rsi:null,atr:null,momentum:0,orderPending:false,orderPendingAt:0,forceNextSide:null,tradingEnabled:false,lastEntryBarT:null};
}
function findHit(def){ for(const m of def.ctMatch){ const s=state.symbolsByNorm[norm(m)]; if(s) return s; } return null; }
function rank(list){
  return list.slice().sort((x,y)=>{ if(!!x.ok!==!!y.ok) return x.ok?-1:1; if(x.ok) return y.score-x.score; return (y.watch?y.watch.score:0)-(x.watch?x.watch.score:0); });
}
function toAIRes(r){
  const st=STRAT[r.type]||'emaPullback';
  return {key:r.key,label:r.pair,dir:r.side,score:r.score,grade:r.grade,strategy:st,strategyLabel:STRATEGY_LABELS[st],crypto:isCrypto(r.key),note:r.label_type||''};
}
function syncAI(){ const z=AI(); if(!z||!z.scan) return; z.scan.results=SP.st.results.filter(r=>r.ok).map(r=>{ const o=toAIRes(r); o.note=r.label+' · R:R '+r.rr.toFixed(1); return o; }); z.scan.lastRun=SP.st.lastRun; z.scan.running=SP.st.running; }
SP.scanPairs=function(cb,opts){
  opts=opts||{}; const S=SP.st;
  if(S.running) return;
  if(!opts.force&&Date.now()-S.lastRun<20000){ if(cb) cb(S.results); return; }
  S.running=true; S.done=0; S.skipped=[]; syncAI(); render();
  const results=[]; const cur=state.assets[state.currentSymbol];
  if(cur&&cur.dataReady) results.push(SP.cached(cur,true));
  const finish=()=>{ S.running=false; S.lastRun=Date.now(); S.results=rank(results); syncAI(); if(cb) cb(S.results); render(); };
  if(state.broker!=='ctrader'||!state.accountReady){ S.total=results.length; finish(); return; }
  const queue=Object.keys(SYM_DEFS).filter(k=>k!==state.currentSymbol&&(SYM_DEFS[k].weekend||!fxClosedNow())&&findHit(SYM_DEFS[k]));
  S.total=queue.length+results.length;
  let workers=Math.min(2,queue.length);
  if(!workers){ finish(); return; }
  function work(){
    const key=queue.shift();
    if(!key){ if(--workers===0) finish(); return; }
    const def=SYM_DEFS[key], hit=findHit(def);
    let a=state.assets[key], created=false, prevReady=false;
    if(!a){ a=state.assets[key]=mkAsset(key,def,hit); created=true; } else { prevReady=a.dataReady; }
    if(a.positions&&a.positions.length){ S.done++; return setTimeout(work,50); }
    a.symbolId=hit.symbolId; if(!a.full) a.full=hit; a.dataReady=false;
    fetchHistory(hit.symbolId);
    const deadline=Date.now()+8000;
    const poll=setInterval(()=>{
      const aa=state.assets[key]; const got=aa&&aa.dataReady&&aa.bars1&&aa.bars1.length>=300;
      if(got||Date.now()>deadline){
        clearInterval(poll);
        if(got){ const r=SP.evaluate(aa); results.push(r); }
        else{
          S.skipped.push(def.label);
          if(aa) aa.dataReady=prevReady;
          Object.keys(state.pendingTrendbarRequests||{}).forEach(k=>{ if(state.pendingTrendbarRequests[k].symId===hit.symbolId) delete state.pendingTrendbarRequests[k]; });
        }
        if(created&&state.currentSymbol!==key&&aa&&!aa.subscribedSymbolId&&!(aa.positions&&aa.positions.length)) delete state.assets[key];
        S.done++; render();
        setTimeout(work,350);
      }
    },400);
  }
  for(let i=0;i<workers;i++) setTimeout(work,i*400);
};

// ---------------------------------------------------------------
// EXECUTION — always through the bot's own executeTrade() (same SL/TP/lot/live-arm/daily-loss rules).
// ---------------------------------------------------------------
// One place that fires a scanner-approved entry. The scanner's own stop and target apply to THIS entry whether or not
// the AI Autopilot master switch is on (the trade you were shown is the trade that is placed).
function placeWith(a,s,bypass,run){
  a._spSide=s.side; a._spTrade=true; a._spTradeAt=Date.now(); a._spTP=s.tp; SP.live[a.key]=s;
  if(bypass) a._spBypass=true;
  const prevBasket=cfg.basketProfit; let ok=false;
  try{
    if(cfg.strategy!=='grid'&&a.lastPrice){
      const vol=volumeFor(a,typeof effectiveLotSize==='function'?effectiveLotSize():cfg.lotSize);
      const d=Math.abs(s.tp-a.lastPrice)*dollarPerUnitFor(vol,a);
      if(d>0.05&&Number.isFinite(d)) cfg.basketProfit=d;
    }
    ok=run();
  } finally{ cfg.basketProfit=prevBasket; a._spSide=null; a._spBypass=false; }
  if(ok) SP.fired[s.id]=Date.now(); else{ a._spTrade=false; a._spTP=null; }
  return !!ok;
}
SP.execute=function(a,s,src){
  const ok=placeWith(a,s,true,()=>executeTrade(a,s.side));
  if(ok){
    log('Scanner ['+src+']: '+s.side+' '+a.label+' — '+s.label+', grade '+s.grade+' ('+s.score+'/100), entry ~'+fmt(a,s.entry)+', stop '+fmt(a,s.sl)+', target '+fmt(a,s.tp)+', R:R '+s.rr.toFixed(1)+'.');
  }
  return ok;
};
function prepFresh(key){ const a=state.assets[key]; if(a&&key!==state.currentSymbol){ a.subscribedSymbolId=null; a.dataReady=false; } }
SP.openPair=function(key){
  if(key===state.currentSymbol) return {ok:true,msg:'Already on '+(SYM_DEFS[key]?SYM_DEFS[key].label:key)+'.'};
  if(anyOpenPositions(key)) return {ok:false,msg:'You have an open trade — close it before switching pairs (switching closes it).'};
  prepFresh(key); selectSymbol(key); return {ok:true,msg:'Switching to '+(SYM_DEFS[key]?SYM_DEFS[key].label:key)+'…'};
};
// Take a setup: re-checks on live data first. If it's on another pair, switches and re-checks there.
SP.take=function(s,src){
  if(!s||!s.ok) return {ok:false,msg:'That setup is no longer valid.'};
  if(s.key!==state.currentSymbol){
    const o=SP.openPair(s.key); if(!o.ok) return o;
    SP.pending={key:s.key,side:s.side,type:s.type,exp:Date.now()+60000,src:src||'manual'};
    return {ok:true,switching:true,msg:o.msg+' I will re-check it on live data and only enter if it still qualifies.'};
  }
  const a=state.assets[s.key]; if(!a||!a.dataReady) return {ok:false,msg:'Data for this pair is still loading.'};
  const now=SP.cached(a,true);
  if(!(now.ok&&now.side===s.side)) return {ok:false,msg:'Re-checked on live data: '+(now.ok?'the direction flipped.':('no longer valid — '+(now.blockers[0]||now.waiting||'conditions changed')+'.'))};
  if(SP.fired[now.id]) return {ok:false,msg:'This exact setup was already traded.'};
  const ok=SP.execute(a,now,src||'manual');
  return {ok,msg:ok?('Order sent: '+now.side+' '+a.label+'. Stop '+fmt(a,now.sl)+', target '+fmt(a,now.tp)+'.'):'The bot refused the order — see the log for the reason.',setup:now};
};

// ---------------------------------------------------------------
// AI AUTOPILOT HOOKS (only when ai-zone-strategist.js is present)
//  - scanner levels become the SL / TP the autopilot uses for that entry
//  - the autopilot's 12s "hold" is skipped for entries the scanner/Megan/you already confirmed
//  - the Pair scanner in the AI panel now runs THIS engine
// ---------------------------------------------------------------
(function hookAI(){
  const z=AI(); if(!z) return;
  const _sl=z.slDistanceFor, _tp=z.tpDollarsFor, _conf=z.confirmEntry, _accept=z.acceptScanResult;
  z.slDistanceFor=function(a,side){
    if(z.cfg.masterOn&&z.cfg.zoneSLTP){
      const s=SP.fresh(a,a._spSide||side);
      if(s&&a.lastPrice){ const d=Math.abs(a.lastPrice-s.sl); if(d>0&&Number.isFinite(d)) return d; }
    }
    return _sl.call(z,a,side);
  };
  z.tpDollarsFor=function(a,side,vol){
    if(z.cfg.masterOn&&z.cfg.zoneSLTP){
      const s=SP.fresh(a,a._spSide||side);
      if(s&&a.lastPrice){ const dist=Math.abs(s.tp-a.lastPrice), v=vol||lotSizeFor(a), d=dist*dollarPerUnitFor(v,a); if(d>0.05&&Number.isFinite(d)) return d; }
    }
    return _tp.call(z,a,side,vol);
  };
  z.confirmEntry=function(a,side){ return a._spBypass?true:_conf.call(z,a,side); };
  z.scanPairs=function(cb){ SP.scanPairs(cb,{}); };
  z.acceptScanResult=function(res){
    if(!res) return;
    if(res.key!==state.currentSymbol){ const o=SP.openPair(res.key); if(!o.ok){ log('Scanner: '+o.msg); return; } }
    const sel=$('cfgStrategy'); if(sel&&res.strategy){ sel.value=res.strategy; if(typeof applyStrategyPreset==='function') applyStrategyPreset(); if(typeof saveConfig==='function') saveConfig(); }
    log('Scanner: switched to '+res.label+' — '+(res.note||'')+' (strategy set to '+res.strategyLabel+').');
  };
})();

// Gate + exact scanner levels + longer hold + no stacking for scanner trades (wrappers around the bot's own functions).
(function hookHost(){
  const _exec=executeTrade, _manual=manualTrade, _exits=checkExits;
  const glog={};
  window.executeTrade=executeTrade=function(a,side){
    const z=AI();
    const fresh=a&&a.positions&&a.positions.length===0;
    // FIX ("it can take one trade then sit for a long time... grid/
    // scalping is supposed to be aggressive"): this gate requires the
    // Scanner's own trend-cleanliness filter to agree before ANY fresh
    // entry fires, on every strategy — including Grid. But Grid is built
    // to profit FROM choppy back-and-forth price action, and the
    // Scanner's filter exists specifically to REJECT choppy conditions
    // ("market is choppy... skipped"). Those two are fundamentally
    // opposed, and gating Grid behind a filter designed to block the
    // exact conditions Grid trades is what was causing the long quiet
    // stretches. Grid now bypasses this gate entirely; the trend-
    // following strategies this gate actually suits still use it.
    if(fresh&&z&&z.cfg.masterOn&&SP.cfg.gateOn&&cfg.strategy!=='grid'&&!a._spBypass&&!a.pendingIsFakeLeg&&!a.forceNextSide){
      const s=SP.cached(a);
      if(!(s.ok&&s.side===side)){
        const k=a.key+side, n=Date.now();
        if(!glog[k]||n-glog[k]>60000){ glog[k]=n; log('Scanner gate: held back '+side+' on '+a.label+' — '+(s.ok?('scanner wants '+s.side):(s.blockers[0]||s.waiting||'no valid setup'))+'.'); }
        return false;
      }
      if(SP.fired[s.id]) return false;
      return placeWith(a,s,false,()=>_exec(a,side));
    }
    return _exec(a,side);
  };
  // The scanner's stop is used for this entry whatever the bot's own signal says (a.signal can be WAIT or the other side).
  if(has('slDistanceFor')){
    const _sd=slDistanceFor;
    window.slDistanceFor=slDistanceFor=function(a,vol){
      if(a&&a._spSide){ const s=SP.fresh(a,a._spSide); if(s&&a.lastPrice){ const d=Math.abs(a.lastPrice-s.sl); if(d>0&&Number.isFinite(d)) return d; } }
      return _sd(a,vol);
    };
  }
  // Manual BUY/SELL (and Megan's confirmed fire) are your decision: never gated, never delayed by the autopilot's hold.
  window.manualTrade=manualTrade=function(side){
    const a=state.assets[state.currentSymbol]; if(a) a._spBypass=true;
    try{ return _manual(side); } finally{ if(a) a._spBypass=false; }
  };
  window.checkExits=checkExits=function(a){
    if(a&&a._spTrade){
      if(!a.positions.length){ if(Date.now()-(a._spTradeAt||0)>15000){ a._spTrade=false; a._spTP=null; } return _exits(a); }
      if(a._spTP&&a.lastPrice&&a.positions.every(p=>p.paper)){
        const p0=a.positions[0];
        if(p0.side==='BUY'?a.lastPrice>=a._spTP:a.lastPrice<=a._spTP){ log('Scanner target reached on '+a.label+'.'); closeAllPositions(a); return; }
      }
      const prevHold=cfg.maxHoldMin, prevBasket=cfg.basketProfit;
      cfg.maxHoldMin=Math.max(prevHold||0,240);
      if(a._spTP&&cfg.strategy!=='grid'){ const p=a.positions[0], d=Math.abs(a._spTP-p.entryPrice)*dollarPerUnitFor(p.volume,a); if(d>0.05&&Number.isFinite(d)) cfg.basketProfit=d; }
      try{ return _exits(a); } finally{ cfg.maxHoldMin=prevHold; cfg.basketProfit=prevBasket; }
    }
    return _exits(a);
  };
  // A scanner trade lives or dies by its own stop / target (the EMA-Ride "trend flip" exit would otherwise cut it early).
  if(has('checkEmaTrendFlipExit')){
    const _flip=checkEmaTrendFlipExit;
    window.checkEmaTrendFlipExit=checkEmaTrendFlipExit=function(a){ if(a&&a._spTrade) return; return _flip(a); };
  }
  if(has('maybeAddStackLeg')){
    const _stack=maybeAddStackLeg;
    window.maybeAddStackLeg=maybeAddStackLeg=function(a){ if(a&&a._spTrade) return; return _stack(a); };
  }
})();

// ---------------------------------------------------------------
// TEXT — what Megan reads out / is given as reference.
// ---------------------------------------------------------------
SP.brief=function(a){
  if(!a) return 'No pair is open.';
  const s=SP.cached(a), nm=a.label;
  let out;
  if(s.ok){
    out=nm+': VALID '+s.side+' setup — '+s.label+', grade '+s.grade+', score '+s.score+'/100. Entry about '+fmt(a,s.entry)+', stop '+fmt(a,s.sl)+', target '+fmt(a,s.tp)+', reward:risk '+s.rr.toFixed(1)+'. Why: '+s.reasons.join('; ')+'.'+(s.warns.length?' Cautions: '+s.warns.join('; ')+'.':'');
  } else {
    out=nm+': NO valid setup right now'+(s.bestSide?(' (closest was a '+s.bestSide+' '+s.label+' scoring '+s.bestScore+')'):'')+'.'+(s.waiting?' Waiting for: '+s.waiting+'.':'')+(s.blockers.length?' Blocked by: '+s.blockers.join('; ')+'.':'');
  }
  const top=(SP.st.results||[]).filter(r=>r.ok&&r.key!==a.key).slice(0,2);
  if(top.length) out+=' Other pairs from the last scan: '+top.map(r=>r.pair+' '+r.side+' '+r.score).join(', ')+'.';
  return out;
};
function spoken(a,s){
  return ((a&&a.label)||s.pair)+' '+s.side.toLowerCase()+'. Grade '+s.grade+', score '+s.score+'. '+s.label+'. Entry around '+fmt(a,s.entry)+', stop '+fmt(a,s.sl)+', target '+fmt(a,s.tp)+'. Reward to risk '+s.rr.toFixed(1)+'.';
}

// ---------------------------------------------------------------
// MEGAN — real connection: her context, her chart read, her voice commands, her fire path and her autopilot.
// ---------------------------------------------------------------
SP.voiceScan=function(){
  say('Scanning the open markets.');
  SP.scanPairs(()=>{
    const res=SP.st.results||[], good=res.filter(r=>r.ok);
    if(good.length){
      const top=good[0], a=state.assets[top.key]||{label:top.label,key:top.key,full:null};
      SP.offer={setup:top,exp:Date.now()+90000};
      say('Best setup: '+spoken(a,top)+(good.length>1?' I also have '+(good.length-1)+' more on the list.':'')+' Say take it to enter, or skip.');
    } else {
      const c=res[0]; const nm=SP.st.total||res.length;
      say('I scanned '+nm+' pairs and nothing meets my entry rules right now.'+(c&&c.watch&&c.watch.score?(' Closest is '+c.pair+' but I am waiting for: '+(c.waiting||'a cleaner trigger')+'.'):'')+' No trade is a valid position.');
    }
  },{force:true});
  return true;
};
SP.voiceSignal=function(){
  const a=state.assets[state.currentSymbol]; if(!a){ say('No pair is open.'); return true; }
  const s=SP.cached(a,true);
  if(s.ok){ SP.offer={setup:s,exp:Date.now()+90000}; say(spoken(a,s)+' Say take it to enter.'); }
  else say(a.label+': no valid setup right now.'+(s.waiting?' Waiting for '+s.waiting+'.':'')+(s.blockers.length?' '+s.blockers[0]+'.':''));
  return true;
};
SP.voiceTake=function(){
  const o=SP.offer; SP.offer=null;
  if(!o||Date.now()>o.exp){ say('I do not have a setup waiting for your go-ahead. Ask me to scan first.'); return true; }
  const r=SP.take(o.setup,'voice'); say(r.msg); return true;
};
SP.voiceWinRate=function(){
  const WT=window.WinTracker; if(!WT){ say('The win rate tracker is not loaded.'); return true; }
  const b=curBucket(), s=WT.stats(b), dec=s.wins+s.losses;
  if(!s.trades){ say('No closed '+b+' trades recorded yet.'); return true; }
  say('On '+b+': '+s.wins+' wins and '+s.losses+' losses, '+(s.winRate!=null?Math.round(s.winRate*100):0)+' percent win rate, net '+(s.net>=0?'plus ':'minus ')+Math.abs(s.net).toFixed(2)+' dollars, profit factor '+(s.profitFactor==null?'not available':(s.profitFactor===Infinity?'no losses yet':s.profitFactor.toFixed(2)))+'.'+(dec<30?' That is too few trades to trust yet.':''));
  return true;
};
(function hookMegan(){
  const MA=window.MeganBotAdapter; if(!MA) return;
  const _ctx=MA.getChartContext, _desc=MA.describe, _fire=MA.fireTrade;
  MA.describe=function(){ return (_desc?_desc.call(MA):'')+' It also has a professional pair scanner (trend, structure, zones, volatility, session and news filters) and an AI Autopilot; you can ask it to scan, read the current signal, or take a scanner setup.'; };
  MA.getChartContext=function(){
    let base=null; try{ base=_ctx?_ctx.call(MA):null; }catch(e){}
    if(!base) return base;
    try{ return base+'\nSCANNER (real, computed from live closed candles): '+SP.brief(state.assets[state.currentSymbol]); }catch(e){ return base; }
  };
  MA.getAnalysisBrief=function(){
    try{ return 'Reference from this bot\'s own professional scanner (real numbers from live candles — a second opinion only; agree or disagree from your own read, and never invent levels): '+SP.brief(state.assets[state.currentSymbol])+' '; }catch(e){ return ''; }
  };
  MA.voiceCommand=function(t){
    if(SP.offer&&Date.now()<SP.offer.exp){
      if(/\b(yes|yeah|yep|yup|sure|go ahead|do it|confirm|fire it|take it|take the (trade|setup)|enter( it| the trade)?|place it|execute)\b/.test(t)&&!/\b(no|nope|don't|do not)\b/.test(t)) return SP.voiceTake();
      if(/\b(no|nope|cancel|skip|pass|never ?mind|don't|do not|not now)\b/.test(t)){ SP.offer=null; say('Okay, skipping it.'); return true; }
    }
    if(/strateg/.test(t)) return false;
    if(/\bscan\b|any (good |valid )?(setups?|trades?|signals?)\b|find (me )?a (trade|setup)|best (setup|pair|trade)|what should i (trade|buy|sell)|which pair/.test(t)) return SP.voiceScan();
    if(/\b(signal|setup)\b/.test(t)&&/\b(this|current|now|here|on|for|what|is there)\b/.test(t)) return SP.voiceSignal();
    if(/win.?rate|how am i doing|my (results|record|stats)|how many (wins|trades)/.test(t)) return SP.voiceWinRate();
    return false;
  };
  // Confirmed fire ("yes, fire it" after her chart read): scanner levels when it agrees; otherwise still your call, with a plain warning.
  MA.fireTrade=function(side){
    if(side!=='BUY'&&side!=='SELL') return false;
    const a=state.assets[state.currentSymbol]; if(!a) return _fire.call(MA,side);
    const s=SP.cached(a,true);
    if(s.ok&&s.side===side){ const r=SP.take(s,'megan-confirmed'); if(!r.ok) setTimeout(()=>say('It did not go through. '+r.msg),3000); return true; }
    const res=_fire.call(MA,side);
    setTimeout(()=>say('Heads up: my scanner does not see a valid '+side.toLowerCase()+' setup here'+((s.blockers[0]||s.waiting)?(' — '+(s.blockers[0]||s.waiting)):'')+'. It only went through your normal risk rules.'),3500);
    return res;
  };
})();

// Megan's autopilot: the SCANNER finds the trade, MEGAN can veto it, and it still goes through the bot's own risk rules.
(function hookMeganAuto(){
  if(!has('meganAutoTick')) return;
  const lastAt={}, busy={};
  async function scannerMeganTick(a){
    if(!state.meganAuto||state.stopped||!window.Megan||!a||!a.dataReady||a.tradingEnabled===false) return;
    if(a.positions.length||busy[a.key]) return;
    if(cfg.dailyLossLimit>0&&state.todayPnl<=-Math.abs(cfg.dailyLossLimit)) return;
    const now=Date.now(); if(now-(lastAt[a.key]||0)<25000) return; lastAt[a.key]=now;
    const s=SP.cached(a,true);
    if(!s.ok||SP.fired[s.id]) return;
    busy[a.key]=true;
    try{
      if(SP.cfg.meganVeto){
        let reply; const MA=window.MeganBotAdapter;
        try{
          reply=await Megan.answer('You are the second pair of eyes on a trade. This bot\'s scanner (real numbers from live candles) found: '+SP.brief(a)+' Do you agree to take exactly this trade now? Reply with one word on the first line — '+s.side+' if you agree with the scanner\'s direction, or HOLD to veto — then one short reason on the next line. You are not setting prices: stop, target and size come from the scanner and the bot\'s own risk rules.',{research:false});
        }catch(e){ log('Megan auto: could not reach the AI relay — no trade (this scanner setup needs her agreement).'); return; }
        const lines=String(reply||'').split('\n').map(l=>l.trim()).filter(Boolean);
        const action=(lines[0]||'').toUpperCase().replace(/[^A-Z]/g,''), reason=lines.slice(1).join(' ');
        if(action!==s.side){ SP.fired[s.id]=Date.now(); log('Megan vetoed '+s.side+' '+a.label+(reason?': '+reason:'.')); say('I am passing on that '+a.label+' setup. '+(reason||'')); return; }
        say(s.side+' on '+a.label+' — the scanner and I agree. '+(reason||''));
      }
      const s2=SP.cached(a,true);
      if(!(s2.ok&&s2.side===s.side)){ log('Megan auto: setup changed while checking — not entering.'); return; }
      SP.execute(a,s2,SP.cfg.meganVeto?'megan+scanner':'scanner-auto');
    } finally{ busy[a.key]=false; }
  }
  window.meganAutoTick=meganAutoTick=scannerMeganTick;
})();

// ---------------------------------------------------------------
// LIVE TICK — keeps the current pair evaluated, alerts once per new setup, resolves a pending pair-switch entry.
// ---------------------------------------------------------------
function tick(){
  try{
    updatePill();
    const a=state.assets[state.currentSymbol];
    if(a&&a.dataReady&&a.tradingEnabled!==false){
      const s=SP.cached(a,true);
      if(s.ok&&!a.positions.length&&!SP.alerted[s.id]){
        SP.alerted[s.id]=Date.now();
        if(SP.cfg.speakAlerts&&window.Megan&&Date.now()-SP.lastSpoken>180000){
          SP.lastSpoken=Date.now(); SP.offer={setup:s,exp:Date.now()+90000};
          say('New setup. '+spoken(a,s)+' Say take it to enter.');
        }
      }
      const p=SP.pending;
      if(p){
        if(Date.now()>p.exp||p.key!==a.key){ SP.pending=null; }
        else if(s.ok&&s.side===p.side&&s.type===p.type){
          SP.pending=null; const ok=!SP.fired[s.id]&&SP.execute(a,s,p.src+'+recheck');
          say(ok?('Confirmed on live data. '+s.side+' '+a.label+' placed. Stop '+fmt(a,s.sl)+', target '+fmt(a,s.tp)+'.'):'Could not place it — see the log.');
        } else if(!s.ok&&Date.now()>p.exp-45000){
          SP.pending=null; say('Re-checked '+a.label+' on live data and it no longer qualifies. Not entering.');
        }
      }
    }
    if(panelOpen()) render();
  }catch(e){ if(window.console) console.warn('[ScannerPro] tick',e); }
}

// ---------------------------------------------------------------
// REPLAY — the same engine over the candles already loaded, using only data available at each moment.
// ---------------------------------------------------------------
SP.runReplay=function(){
  const a=state.assets[state.currentSymbol]; if(!a||!a.bars1||a.bars1.length<600){ SP.replay={err:'Not enough candles loaded yet (need ~10 hours).'}; render(); return; }
  SP.replay={busy:true}; render();
  setTimeout(()=>{
    try{ const r=Engine.replay(a.bars1,{crypto:isCrypto(a.key),minScore:SP.cfg.minScore,minRR:SP.cfg.minRR}); r.label=a.label; SP.replay=r; }
    catch(e){ SP.replay={err:'Replay failed: '+e.message}; }
    render();
  },30);
};

// ---------------------------------------------------------------
// UI
// ---------------------------------------------------------------
function css(){
  const c=`
  #spPill{position:fixed;right:14px;bottom:126px;z-index:9999;background:#1a1a25;color:#c8c8d8;font-family:Orbitron,sans-serif;font-weight:800;font-size:11px;border:1px solid #2a2a3a;border-radius:20px;padding:10px 14px;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;display:none;}
  #spPill.show{display:block;}
  #spPill.BUY{background:linear-gradient(135deg,#00e08a,#00a86b);color:#04140c;border-color:#00ff99;box-shadow:0 0 0 2px rgba(0,255,150,.5),0 4px 14px rgba(0,0,0,.4);}
  #spPill.SELL{background:linear-gradient(135deg,#ff5a78,#d4143c);color:#fff;border-color:#ff8aa0;box-shadow:0 0 0 2px rgba(255,90,120,.5),0 4px 14px rgba(0,0,0,.4);}
  #spPanel{position:fixed;left:0;right:0;bottom:0;z-index:10001;background:#0e0e16;border-top:1px solid #2a2a3a;border-radius:16px 16px 0 0;padding:14px 14px 22px;max-height:82vh;overflow:auto;font-family:'Rajdhani',sans-serif;color:#e8e8f0;display:none;font-size:13.5px;max-width:480px;margin:0 auto;}
  #spPanel.show{display:block;}
  #spPanel h3{margin:0 0 8px;font-family:Orbitron,sans-serif;font-size:13px;color:#00f0ff;display:flex;justify-content:space-between;align-items:center;}
  #spPanel .x{background:none;border:none;color:#9a9ab0;font-size:18px;cursor:pointer;}
  #spPanel .tabs{display:flex;gap:6px;margin-bottom:10px;}
  #spPanel .tabs button{flex:1;background:#1a1a25;border:1px solid #2a2a3a;color:#9a9ab0;border-radius:8px;padding:8px;font-weight:700;cursor:pointer;font-family:inherit;}
  #spPanel .tabs button.act{background:#00f0ff;color:#04141a;border-color:#00f0ff;}
  #spPanel .card{background:#161620;border:1px solid #2a2a3a;border-radius:12px;padding:11px;margin-bottom:10px;}
  #spPanel .card.ok{border-color:#00c896;}
  #spPanel .top{display:flex;justify-content:space-between;align-items:center;font-weight:700;}
  #spPanel .tag{font-family:Orbitron,sans-serif;font-size:11px;padding:3px 9px;border-radius:10px;background:#2a2a3a;color:#c8c8d8;}
  #spPanel .tag.BUY{background:#00c896;color:#04141a;} #spPanel .tag.SELL{background:#ff4d6d;color:#fff;}
  #spPanel .line{color:#b8b8cc;margin:6px 0;font-size:12.5px;}
  #spPanel .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0;}
  #spPanel .grid div{background:#0e0e16;border-radius:8px;padding:6px;text-align:center;}
  #spPanel .grid span{display:block;font-size:10px;color:#8a8aa0;} #spPanel .grid b{font-size:12.5px;}
  #spPanel ul{margin:6px 0 0 16px;padding:0;color:#b8b8cc;font-size:12px;} #spPanel li{margin:2px 0;}
  #spPanel li.w{color:#ffd166;} #spPanel li.b{color:#ff8a8a;}
  #spPanel .btns{display:flex;gap:8px;margin-top:8px;}
  #spPanel .btns button,#spPanel .wide{flex:1;border:none;border-radius:9px;padding:10px;font-weight:800;cursor:pointer;background:#2a2a3a;color:#e8e8f0;font-family:inherit;font-size:13px;}
  #spPanel .btns button.go,#spPanel .wide.go{background:#00c896;color:#04141a;}
  #spPanel .btns button:disabled,#spPanel .wide:disabled{opacity:.5;}
  #spPanel .row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1e1e2a;}
  #spPanel .sw{width:38px;height:20px;border-radius:12px;background:#2a2a3a;position:relative;cursor:pointer;flex-shrink:0;}
  #spPanel .sw.on{background:#00c896;} #spPanel .sw i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;} #spPanel .sw.on i{left:20px;}
  #spPanel select{background:#1a1a25;color:#fff;border:1px solid #2a2a3a;border-radius:6px;padding:4px 6px;}
  #spPanel .note{font-size:11px;color:#8a8aa0;margin:8px 0;line-height:1.4;} #spPanel .note.warn{color:#ffd166;}
  #spPanel .wr{font-family:Orbitron,sans-serif;font-size:26px;font-weight:900;} #spPanel .wr small{display:block;font-family:'Rajdhani';font-size:12px;color:#9a9ab0;font-weight:600;}
  #spPanel .stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;}
  #spPanel .stat{background:#0e0e16;border-radius:8px;padding:7px;} #spPanel .stat span{display:block;font-size:10.5px;color:#8a8aa0;}
  #spPanel .mini{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px solid #1e1e2a;}
  `;
  const s=document.createElement('style'); s.textContent=c; document.head.appendChild(s);
}
function panelOpen(){ const p=document.getElementById('spPanel'); return !!(p&&p.classList.contains('show')); }
function updatePill(){
  const pill=document.getElementById('spPill'); if(!pill) return;
  const dash=document.getElementById('scrDash'); const show=!!(dash&&dash.classList.contains('active'));
  pill.classList.toggle('show',show);
  const a=state.assets[state.currentSymbol]; const c=a&&SP.cache[a.key]; const s=c&&Date.now()-c.t<20000?c.s:null;
  pill.classList.remove('BUY','SELL');
  if(s&&s.ok){ pill.classList.add(s.side); pill.textContent='📡 '+s.side+' '+s.grade+' '+s.score; }
  else pill.textContent='📡 SIGNALS';
}
function sw(key,label){ return '<div class="row"><span>'+label+'</span><div class="sw '+(SP.cfg[key]?'on':'')+'" data-k="'+key+'"><i></i></div></div>'; }
function setupCard(a,s,title){
  if(s.ok){
    return '<div class="card ok"><div class="top"><span>'+esc(title)+'</span><span class="tag '+s.side+'">'+s.side+' · '+s.grade+' · '+s.score+'</span></div>'+
      '<div class="line">'+esc(s.label)+' — market entry near '+fmt(a,s.entry)+(s.tpNote?' · '+esc(s.tpNote):'')+'</div>'+
      '<div class="grid"><div><span>ENTRY</span><b>'+fmt(a,s.entry)+'</b></div><div><span>STOP</span><b>'+fmt(a,s.sl)+'</b></div><div><span>TARGET</span><b>'+fmt(a,s.tp)+'</b></div><div><span>R:R</span><b>'+s.rr.toFixed(1)+'</b></div></div>'+
      '<ul>'+s.reasons.map(x=>'<li>'+esc(x)+'</li>').join('')+s.warns.map(x=>'<li class="w">'+esc(x)+'</li>').join('')+'</ul>'+
      '<div class="btns"><button class="go" data-act="take">Take this trade</button><button data-act="ask">Ask Megan</button></div></div>';
  }
  return '<div class="card"><div class="top"><span>'+esc(title)+'</span><span class="tag">WAIT</span></div>'+
    '<div class="line">No valid setup right now.'+(s.bestSide?' Closest: '+s.bestSide+' '+esc(s.label)+' '+s.bestScore+'/100.':(s.watch&&s.watch.score?' Trend quality '+s.watch.side+' '+s.watch.score+'/100.':''))+(s.waiting?' Waiting for: <b>'+esc(s.waiting)+'</b>.':'')+'</div>'+
    (s.blockers&&s.blockers.length?'<ul>'+s.blockers.map(x=>'<li class="b">'+esc(x)+'</li>').join('')+'</ul>':'')+
    '<div class="btns"><button data-act="ask">Ask Megan</button></div></div>';
}
function sigTab(){
  const a=state.assets[state.currentSymbol]; let h='';
  if(a) h+=setupCard(a,SP.cached(a),'LIVE · '+(a.label||a.key)); else h+='<div class="card">Connect and pick a pair first.</div>';
  const S=SP.st;
  h+='<div class="btns" style="margin:0 0 10px"><button class="go" data-act="scan" '+(S.running?'disabled':'')+'>'+(S.running?('Scanning '+S.done+'/'+S.total+'…'):'Scan all pairs')+'</button><button data-act="replay">Replay this pair</button></div>';
  if(SP.replay){
    const r=SP.replay;
    if(r.busy) h+='<div class="card"><div class="line">Replaying the loaded candles…</div></div>';
    else if(r.err) h+='<div class="card"><div class="line">'+esc(r.err)+'</div></div>';
    else{
      const n=r.wins+r.losses, pf=r.pf==null?'—':(r.pf===Infinity?'no losses':r.pf.toFixed(2));
      h+='<div class="card"><div class="top"><span>REPLAY · '+esc(r.label)+'</span><span class="tag">'+r.hours.toFixed(0)+'h of candles</span></div>'+
        (n?'<div class="grid"><div><span>SIGNALS</span><b>'+n+'</b></div><div><span>WIN RATE</span><b>'+Math.round(100*r.winRate)+'%</b></div><div><span>AVG R</span><b>'+r.avgR.toFixed(2)+'</b></div><div><span>PF</span><b>'+pf+'</b></div></div>':'<div class="line">The engine found no valid setups in this window — it stays out when nothing qualifies.</div>')+
        '<div class="note warn">Small sample'+(n<30?' ('+n+' trades — far too few to trust)':'')+'. No spread, commission or slippage modelled, and the stop counts first if both are touched in one candle. Treat it as a sanity check, not a promise.</div></div>';
    }
  }
  const res=S.results||[];
  if(res.length){
    h+='<div class="note">Last scan '+Math.max(0,Math.round((Date.now()-S.lastRun)/60000))+' min ago · '+res.filter(r=>r.ok).length+' valid of '+res.length+' pairs'+(S.skipped.length?' · no data: '+esc(S.skipped.join(', ')):'')+'</div>';
    res.slice(0,8).forEach((r,i)=>{
      h+='<div class="card'+(r.ok?' ok':'')+'"><div class="top"><span>'+esc(r.pair)+'</span><span class="tag '+(r.ok?r.side:'')+'">'+(r.ok?(r.side+' · '+r.grade+' · '+r.score):('watching · '+(r.watch?r.watch.score:0)))+'</span></div>'+
        '<div class="line">'+(r.ok?esc(r.reasons.slice(0,3).join(' · '))+' · R:R '+r.rr.toFixed(1):esc(r.waiting||(r.blockers&&r.blockers[0])||'no setup pattern present'))+'</div>'+
        '<div class="btns">'+(r.ok?'<button class="go" data-act="takeres" data-i="'+i+'">Take</button>':'')+'<button data-act="open" data-i="'+i+'">Open pair</button></div></div>';
    });
  }
  h+='<div style="margin-top:6px">'+sw('gateOn','Only enter when the scanner agrees')+sw('meganVeto','Megan must agree (Megan autopilot)')+sw('speakAlerts','Megan announces new setups')+
    '<div class="row"><span>Minimum score</span><select id="spMin">'+[65,70,75,80].map(v=>'<option value="'+v+'"'+(SP.cfg.minScore===v?' selected':'')+'>'+v+'</option>').join('')+'</select></div></div>'+
    '<div class="note">The scanner only signals when the higher-timeframe trend, structure, zones, volatility, session and news filters all line up and the trade has a real stop and at least '+SP.cfg.minRR+' reward:risk. The score is a checklist score, not a win probability — no scanner can promise profit. Test on Paper or Demo and watch the Win rate tab. The news calendar in this bot is rule-based and approximate.</div>';
  return h;
}
function curBucket(){ return state.paper?'paper':(state.env==='live'?'live':'demo'); }
function pct(x){ return x==null?'—':(x*100).toFixed(1)+'%'; }
function winTab(){
  const WT=window.WinTracker; if(!WT) return '<div class="card">The win rate tracker is not loaded.</div>';
  const tab=SP.winTab||curBucket(), s=WT.stats(tab), dec=s.wins+s.losses;
  const col=v=>v==null?'#fff':(v>=0?'#19e6b0':'#ff6b6b');
  const money=v=>v==null?'—':(v>=0?'+':'-')+'$'+Math.abs(v).toFixed(2);
  const pf=s.profitFactor==null?'—':(s.profitFactor===Infinity?'no losses yet':s.profitFactor.toFixed(2));
  let h='<div class="tabs">'+['live','demo','paper'].map(t=>'<button data-wt="'+t+'" class="'+(tab===t?'act':'')+'">'+t.toUpperCase()+'</button>').join('')+'</div><div class="card">';
  if(!s.trades) h+='<div class="line">No closed '+tab.toUpperCase()+' trades recorded yet.'+(tab==='live'?' Live orders also need Arm Live turned on in Config.':'')+'</div>';
  else{
    h+='<div class="wr">'+pct(s.winRate)+'<small>'+s.wins+' win'+(s.wins===1?'':'s')+' · '+s.losses+' loss'+(s.losses===1?'':'es')+(s.even?' · '+s.even+' even':'')+' · '+s.trades+' trade'+(s.trades===1?'':'s')+'</small></div>'+
      (s.ci?'<div class="note">95% range for the true win rate: '+pct(s.ci[0])+' – '+pct(s.ci[1])+'</div>':'')+
      (dec<30?'<div class="note warn">Only '+dec+' decided trade'+(dec===1?'':'s')+' — far too few to trust this win rate yet (aim for 100+).</div>':'')+
      '<div class="stats"><div class="stat"><span>Net P&amp;L</span><b style="color:'+col(s.net)+'">'+money(s.net)+'</b></div><div class="stat"><span>Profit factor</span><b>'+pf+'</b></div>'+
      '<div class="stat"><span>Avg win / avg loss</span><b>'+(s.avgWin==null?'—':'+'+s.avgWin.toFixed(2))+' / '+(s.avgLoss==null?'—':'-'+s.avgLoss.toFixed(2))+'</b></div><div class="stat"><span>Expectancy / trade</span><b style="color:'+col(s.expectancy)+'">'+money(s.expectancy)+'</b></div>'+
      '<div class="stat"><span>Longest losing streak</span><b>'+s.maxLossStreak+'</b></div><div class="stat"><span>Last '+(s.last20N||20)+' trades</span><b>'+pct(s.last20Rate)+'</b></div></div>'+
      '<div style="margin-top:8px">'+s.recent.map(x=>'<div class="mini"><span>'+esc(x.side)+' '+esc(x.sym)+' · '+new Date(x.t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</span><b style="color:'+col(x.pnl)+'">'+money(x.pnl)+'</b></div>').join('')+'</div>'+
      '<div class="note">'+(tab==='paper'?'Paper trades are simulated: no spread, slippage or commission.':(s.brokerConfirmed+' with broker-confirmed P&amp;L, '+s.estimated+' estimated by the bot.'))+' A high win rate can still lose money if losses are bigger than wins — watch profit factor (above 1) and net P&amp;L.</div>';
  }
  h+='<div class="btns"><button data-act="csv">⬇ Export CSV</button><button data-act="reset">↺ Reset '+tab.toUpperCase()+'</button></div></div>';
  return h;
}
function render(){
  const p=document.getElementById('spPanel'); if(!p||!p.classList.contains('show')) return;
  const keepScroll=p.scrollTop;
  p.innerHTML='<h3>📡 SIGNALS &amp; WIN RATE <button class="x" data-act="close">✕</button></h3>'+
    '<div class="tabs"><button data-tab="sig" class="'+(SP.tab==='sig'?'act':'')+'">Signals</button><button data-tab="win" class="'+(SP.tab==='win'?'act':'')+'">Win rate</button></div>'+
    (SP.tab==='sig'?sigTab():winTab());
  p.scrollTop=keepScroll;
}
function onPanelClick(e){
  const t=e.target.closest('[data-act],[data-tab],[data-wt],.sw'); if(!t) return;
  const a=state.assets[state.currentSymbol];
  if(t.dataset.tab){ SP.tab=t.dataset.tab; render(); return; }
  if(t.dataset.wt){ SP.winTab=t.dataset.wt; render(); return; }
  if(t.classList.contains('sw')){ const k=t.dataset.k; SP.cfg[k]=!SP.cfg[k]; saveCfg(); render(); return; }
  const act=t.dataset.act, i=+t.dataset.i;
  if(act==='close'){ document.getElementById('spPanel').classList.remove('show'); return; }
  if(act==='scan'){ SP.scanPairs(null,{force:true}); return; }
  if(act==='replay'){ SP.runReplay(); return; }
  if(act==='ask'){ if(window.Megan&&Megan.voice&&Megan.voice.explainChart){ Megan.voice.explainChart(); } else log('Megan is not available.'); return; }
  if(act==='take'&&a){ const s=SP.cached(a,true); if(!s.ok){ render(); return; }
    if(confirm('Take '+s.side+' '+a.label+'?\nEntry ~'+fmt(a,s.entry)+'  Stop '+fmt(a,s.sl)+'  Target '+fmt(a,s.tp)+'  R:R '+s.rr.toFixed(1)+'\nSize follows your lot / risk settings.')){ const r=SP.take(s,'button'); log('Scanner: '+r.msg); render(); } return; }
  if(act==='takeres'){ const r=SP.st.results[i]; if(r&&confirm('Take '+r.side+' '+r.pair+'?\n'+(r.key!==state.currentSymbol?'This switches pair and re-checks on live data first.\n':'')+'R:R '+r.rr.toFixed(1)+', score '+r.score+'.')){ const o=SP.take(r,'button'); log('Scanner: '+o.msg); render(); } return; }
  if(act==='open'){ const r=SP.st.results[i]; if(r){ const o=SP.openPair(r.key); log('Scanner: '+o.msg); } return; }
  if(act==='csv'){ try{ const tab=SP.winTab||curBucket(); const blob=new Blob([WinTracker.csv(tab)],{type:'text/csv'}); const l=document.createElement('a'); l.href=URL.createObjectURL(blob); l.download='trade-history-'+tab+'.csv'; document.body.appendChild(l); l.click(); setTimeout(()=>{ URL.revokeObjectURL(l.href); l.remove(); },500); }catch(err){ log('Could not export on this device.'); } return; }
  if(act==='reset'){ const tab=SP.winTab||curBucket(); if(confirm('Erase the recorded '+tab.toUpperCase()+' trade history and win rate? This cannot be undone.')){ WinTracker.reset(tab); render(); } return; }
}
function boot(){
  if(!document.getElementById('scrDash')){ setTimeout(boot,500); return; }
  css();
  const pill=document.createElement('button'); pill.id='spPill'; pill.textContent='📡 SIGNALS';
  pill.onclick=()=>{ const p=document.getElementById('spPanel'); p.classList.toggle('show'); render(); };
  document.body.appendChild(pill);
  const panel=document.createElement('div'); panel.id='spPanel'; panel.addEventListener('click',onPanelClick);
  panel.addEventListener('change',e=>{ if(e.target.id==='spMin'){ SP.cfg.minScore=parseInt(e.target.value,10)||70; saveCfg(); SP.cache={}; render(); } });
  document.body.appendChild(panel);
  if(window.WinTracker) WinTracker.onChange=()=>{ try{ if(panelOpen()&&SP.tab==='win') render(); }catch(e){} };
  setInterval(tick,5000);
  log('Scanner Pro loaded — tap 📡 for live signals and the win-rate tracker. It only signals when every filter lines up; the AI Autopilot master switch (🤖 AI) is still OFF by default.');
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();

})();
