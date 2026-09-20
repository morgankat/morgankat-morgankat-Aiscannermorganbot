/* ================================================================
   WIN-RATE TRACKER — additive, no edits to the trading logic.
   ----------------------------------------------------------------
   Records every CLOSED trade the bot sees, separately for:
     live   — real-money account (cTrader live / Binance live)
     demo   — broker demo / testnet account
     paper  — the bot's own simulated (Paper Mode) trades

   How trades get in (nothing is typed in or invented):
     - Paper closes:  wraps paperClose(), same P&L formula it already uses.
     - Broker closes: wraps onExec(), which receives cTrader's execution
       event for EVERY close — including stop-loss / take-profit hits and
       manual closes made in the cTrader app. When the broker sends its own
       profit figures (grossProfit + swap + commission) that net number is
       used, so a "win" that commission turned into a loss counts as a loss.
       If the broker figure is missing or looks mis-scaled, the bot's own
       estimate is used and the trade is tagged "estimated".
   Stored in this browser (localStorage), survives reloads, one record per
   trade (de-duplicated by deal id). Last 3000 trades are kept in full;
   older ones are folded into running totals so the win rate never resets.

   Honest limits:
     - Binance real orders: the app's own code does not report Binance
       fills/closes back, so Binance LIVE/testnet closes are not captured.
     - Win rate on its own says nothing about profit. Look at profit factor
       and net P&L too, and don't trust it until there are ~100 trades.
   ================================================================ */
(function(){
'use strict';

function has(n){ try{ return (0,eval)('typeof '+n)!=='undefined'; }catch(e){ return false; } }
function need(names){ for(const n of names){ if(!has(n)){ console.warn('[WinTracker] missing global: '+n); return false; } } return true; }
if(!need(['state','log','dollarPerUnitFor','paperClose','onExec'])) return;

const KEY='tpea_tracker_v1', MAX_FULL=3000, EPS=0.005;
const BUCKETS=['live','demo','paper'];

function emptyBase(){ return {n:0,w:0,l:0,e:0,gp:0,gl:0,net:0}; }
function load(){
  try{
    const d=JSON.parse(localStorage.getItem(KEY));
    if(d && Array.isArray(d.trades)){ d.base=d.base||{}; BUCKETS.forEach(b=>{ d.base[b]=Object.assign(emptyBase(),d.base[b]||{}); }); return d; }
  }catch(e){}
  const base={}; BUCKETS.forEach(b=>{ base[b]=emptyBase(); });
  return {v:1,trades:[],base};
}
const WT = window.WinTracker = { data:load(), onChange:null };

function save(){ try{ localStorage.setItem(KEY,JSON.stringify(WT.data)); }catch(e){ /* storage full/blocked: keep running, just don't persist */ } }
function classify(pnl){ return pnl>EPS?'w':(pnl<-EPS?'l':'e'); }

function foldOverflow(){
  const t=WT.data.trades;
  while(t.length>MAX_FULL){
    const x=t.shift(), b=WT.data.base[x.b]; if(!b) continue;
    const c=classify(x.pnl); b.n++; b.net+=x.pnl;
    if(c==='w'){ b.w++; b.gp+=x.pnl; } else if(c==='l'){ b.l++; b.gl+=-x.pnl; } else b.e++;
  }
}

function envBucket(){ return state.env==='live' ? 'live' : 'demo'; }   // Binance 'testnet' counts as demo

function record(o){
  if(!o || !Number.isFinite(o.pnl) || BUCKETS.indexOf(o.bucket)<0) return;
  const tr=WT.data.trades;
  if(o.id && tr.slice(-300).some(x=>x.id===o.id)) return;   // execution events can repeat
  tr.push({t:Date.now(),b:o.bucket,sym:o.sym||'',side:o.side||'',pnl:Math.round(o.pnl*10000)/10000,src:o.src||'est',id:o.id||null});
  foldOverflow(); save();
  if(typeof WT.onChange==='function'){ try{ WT.onChange(); }catch(e){} }
}
WT.record=record;

/* ---------- statistics ---------- */
function wilson(w,n){
  if(!n) return null;
  const z=1.96, p=w/n, d=1+z*z/n, c=p+z*z/(2*n), m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n);
  return [Math.max(0,(c-m)/d), Math.min(1,(c+m)/d)];
}
WT.stats=function(bucket){
  const b=WT.data.base[bucket]||emptyBase();
  let n=b.n,w=b.w,l=b.l,e=b.e,gp=b.gp,gl=b.gl,net=b.net;
  let streak=0,maxLossStreak=0,broker=0,est=0;
  const list=WT.data.trades.filter(x=>x.b===bucket);
  list.forEach(x=>{
    const c=classify(x.pnl); n++; net+=x.pnl;
    if(c==='w'){ w++; gp+=x.pnl; streak=0; }
    else if(c==='l'){ l++; gl+=-x.pnl; streak++; if(streak>maxLossStreak) maxLossStreak=streak; }
    else e++;
    if(x.src==='broker') broker++; else est++;
  });
  const decided=w+l;
  const last=list.slice(-20); const lw=last.filter(x=>classify(x.pnl)==='w').length, ll=last.filter(x=>classify(x.pnl)==='l').length;
  return {
    bucket, trades:n, wins:w, losses:l, even:e,
    winRate: decided?w/decided:null,
    ci: wilson(w,decided),
    net, grossProfit:gp, grossLoss:gl,
    profitFactor: gl>0 ? gp/gl : (gp>0?Infinity:null),
    avgWin: w?gp/w:null, avgLoss: l?gl/l:null,
    expectancy: n?net/n:null,
    maxLossStreak,
    last20Rate: (lw+ll)?lw/(lw+ll):null, last20N: lw+ll,
    brokerConfirmed:broker, estimated:est,
    recent:list.slice(-5).reverse()
  };
};

WT.reset=function(bucket){
  WT.data.trades=WT.data.trades.filter(x=>x.b!==bucket);
  WT.data.base[bucket]=emptyBase();
  save();
  if(typeof WT.onChange==='function'){ try{ WT.onChange(); }catch(e){} }
};

WT.csv=function(bucket){
  const rows=['time_utc,account,symbol,side,pnl_usd,pnl_source'];
  WT.data.trades.filter(x=>!bucket||x.b===bucket).forEach(x=>{
    rows.push([new Date(x.t).toISOString(),x.b,x.sym,x.side,x.pnl,x.src==='broker'?'broker':'estimated'].join(','));
  });
  return rows.join('\n');
};

/* ---------- hooks ---------- */
// Paper closes
const origPaperClose=window.paperClose;
window.paperClose=function(a,pos){
  let pnl=null;
  try{ pnl=(pos.side==='BUY'?a.lastPrice-pos.entryPrice:pos.entryPrice-a.lastPrice)*dollarPerUnitFor(pos.volume,a); }catch(e){}
  const r=origPaperClose.apply(this,arguments);
  if(pnl!=null) record({bucket:'paper',sym:a&&a.label,side:pos&&pos.side,pnl:pnl,src:'est'});
  return r;
};

// Broker profit for a close deal: gross + swap + commission, scaled by the broker's own moneyDigits.
// Only used when the broker actually sent the figures and the result is plausible; otherwise null.
function brokerNet(deal,local){
  const d=deal.closePositionDetail||{};
  const md=Number.isFinite(d.moneyDigits)?d.moneyDigits:(Number.isFinite(deal.moneyDigits)?deal.moneyDigits:null);
  if(md==null || !Number.isFinite(d.grossProfit)) return null;
  const net=(d.grossProfit+(+d.swap||0)+(+d.commission||0))/Math.pow(10,md);
  if(!Number.isFinite(net)) return null;
  if(Math.abs(net)>Math.max(50*Math.abs(local),25)) return null;   // looks mis-scaled: don't trust it
  return net;
}

// Broker closes (stop-loss, take-profit, bot close, or a manual close in the cTrader app)
const origOnExec=window.onExec;
window.onExec=function(p){
  let rec=null;
  try{
    const deal=p&&p.deal;
    if(deal && deal.closePositionDetail){
      const a=Object.values(state.assets).find(x=>x.symbolId===deal.symbolId);
      const pos=a&&a.positions.find(x=>x.positionId===deal.positionId);   // must run BEFORE the original removes it
      if(a&&pos){
        const exit=deal.executionPrice||0;
        const local=(pos.side==='BUY'?exit-pos.entryPrice:pos.entryPrice-exit)*dollarPerUnitFor(pos.volume,a);
        const bn=brokerNet(deal,local);
        rec={bucket:pos.paper?'paper':envBucket(), sym:a.label, side:pos.side, pnl:(bn!=null?bn:local), src:(bn!=null?'broker':'est'),
             id:'d'+(deal.dealId!=null?deal.dealId:(deal.positionId+':'+(deal.executionTimestamp||'')))};
      }
    }
  }catch(e){}
  try{ return origOnExec.apply(this,arguments); }
  finally{ if(rec) record(rec); }
};

log('Win-rate tracker active — closed trades are recorded separately for Live, Demo and Paper.');
})();
