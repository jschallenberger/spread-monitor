// ══════════════════════════════════════════════════════════════
// SPREAD-MONITOR — WEB WORKER
// ----------------------------------------------------------------
// Roda em thread separada do navegador. Web Workers NÃO sofrem o
// "background tab throttling" que limita setInterval/setTimeout a
// 1x por minuto quando a aba está minimizada/em segundo plano.
//
// Responsabilidades deste worker:
//   • Manter os timers de polling (preço a cada N segundos, funding a cada 30s)
//   • Chamar a API da Hyperliquid (/info) para buscar mids, candles e funding
//   • Enviar os dados crus para a thread principal via postMessage
//
// O que fica na thread principal (index.html):
//   • DOM, charts, log, estatísticas, P&L, alertas Telegram, localStorage
//
// Mensagens entrada (main → worker):
//   { type: 'init', api }                          — define a URL da API
//   { type: 'startPolling', pair, refreshSec }     — começa/reinicia polling do par
//   { type: 'updateRefresh', pair, refreshSec }    — muda o intervalo de polling
//   { type: 'stopPolling', pair }                  — para o polling
//
// Mensagens saída (worker → main):
//   { type: 'priceTick', pair, data: {...} }       — tick de preço novo
//   { type: 'fundingTick', pair, data: {...} }     — atualização de funding
//   { type: 'log', pair, message }                 — log de debug
// ══════════════════════════════════════════════════════════════

const PAIRS = {
  eq: {
    a: { coin: 'xyz:SP500',    candidates: ['xyz:SP500','SP500','S&P500','xyz:S&P500'] },
    b: { coin: 'xyz:XYZ100',   candidates: ['xyz:XYZ100','XYZ100'] },
  },
  oil: {
    a: { coin: 'xyz:BRENTOIL', candidates: ['xyz:BRENTOIL','BRENTOIL','BRENT','xyz:BRENT'] },
    b: { coin: 'xyz:CL',       candidates: ['xyz:CL','CL','WTI','xyz:WTI'] },
  },
};

const FUNDING_REFRESH_MS = 30_000;

let API = '';

const state = {
  eq:  { priceTimer: null, fundingTimer: null, refreshSec: 3, tickerA: null, tickerB: null, discoveryDone: false },
  oil: { priceTimer: null, fundingTimer: null, refreshSec: 3, tickerA: null, tickerB: null, discoveryDone: false },
};

function logMain(pair, msg) {
  postMessage({ type: 'log', pair, message: msg });
}

async function apiCall(body) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function apiCandle(coin, startMs, endMs, interval = '1m') {
  return apiCall({ type: 'candleSnapshot', req: { coin, interval, startTime: startMs, endTime: endMs } });
}

// Discovery — varre allMids procurando tickers que casem com os candidates
// Usado quando os tickers exatos do PAIRS não foram encontrados.
async function discover(pair) {
  try {
    const mids = await apiCall({ type: 'allMids' });
    const all = Object.keys(mids);
    const cfg = PAIRS[pair];
    for (const t of all) {
      const tu = t.toUpperCase();
      const matchCandidate = (cands) => cands.some(c => {
        const cu = c.toUpperCase();
        const cuBase = c.replace(/^[^:]+:/, '').toUpperCase();
        return tu === cu || tu === cuBase;
      });
      if (!state[pair].tickerA && matchCandidate(cfg.a.candidates)) {
        state[pair].tickerA = t;
        logMain(pair, `Auto A: "${t}"`);
      }
      if (!state[pair].tickerB && matchCandidate(cfg.b.candidates)) {
        state[pair].tickerB = t;
        logMain(pair, `Auto B: "${t}"`);
      }
    }
  } catch (e) {
    logMain(pair, 'discover err: ' + e.message);
  }
}

// Busca preços atuais (allMids) com fallback para candle 1m
async function fetchPrices(pair) {
  const cfg = PAIRS[pair];
  let curA = null, curB = null;
  let foundA = false, foundB = false;
  let tickerA = state[pair].tickerA;
  let tickerB = state[pair].tickerB;

  try {
    const mids = await apiCall({ type: 'allMids' });
    for (const c of [cfg.a.coin, ...cfg.a.candidates]) {
      if (mids[c] !== undefined) { curA = parseFloat(mids[c]); tickerA = c; foundA = true; break; }
    }
    for (const c of [cfg.b.coin, ...cfg.b.candidates]) {
      if (mids[c] !== undefined) { curB = parseFloat(mids[c]); tickerB = c; foundB = true; break; }
    }

    if ((!foundA || !foundB) && !state[pair].discoveryDone) {
      state[pair].discoveryDone = true;
      await discover(pair);
      if (state[pair].tickerA && mids[state[pair].tickerA]) { curA = parseFloat(mids[state[pair].tickerA]); foundA = true; tickerA = state[pair].tickerA; }
      if (state[pair].tickerB && mids[state[pair].tickerB]) { curB = parseFloat(mids[state[pair].tickerB]); foundB = true; tickerB = state[pair].tickerB; }
    }
  } catch (e) {
    logMain(pair, 'allMids err: ' + e.message);
  }

  // Fallback paralelo via candle 1m para os ativos que não vieram em allMids
  const now = Date.now();
  const fallbacks = [];
  if (!foundA) {
    fallbacks.push(apiCandle(cfg.a.coin, now - 120000, now, '1m')
      .then(d => { if (d && d.length) { curA = parseFloat(d[d.length - 1].c); foundA = true; } })
      .catch(() => {}));
  }
  if (!foundB) {
    fallbacks.push(apiCandle(cfg.b.coin, now - 120000, now, '1m')
      .then(d => { if (d && d.length) { curB = parseFloat(d[d.length - 1].c); foundB = true; } })
      .catch(() => {}));
  }
  if (fallbacks.length) await Promise.all(fallbacks);

  state[pair].tickerA = tickerA;
  state[pair].tickerB = tickerB;

  postMessage({
    type: 'priceTick',
    pair,
    data: { curA, curB, tickerA, tickerB, connected: foundA || foundB }
  });
}

// Busca funding rate (atualiza com menor frequência — funding muda slow)
async function fetchFunding(pair) {
  const cfg = PAIRS[pair];
  const dexes = new Set();
  [cfg.a.coin, ...cfg.a.candidates, cfg.b.coin, ...cfg.b.candidates].forEach(c => {
    if (c && c.includes(':')) dexes.add(c.split(':')[0]);
  });
  const dexList = dexes.size > 0 ? [...dexes] : [''];

  let fundingA = null, fundingB = null;

  await Promise.all(dexList.map(async dex => {
    try {
      const body = dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' };
      const resp = await apiCall(body);
      if (!Array.isArray(resp) || resp.length < 2) return;
      const [meta, ctxs] = resp;
      if (!meta || !meta.universe) return;
      const names = meta.universe.map(u => u.name);

      names.forEach((n, i) => {
        const nUp = n.toUpperCase();
        const fullName = (dex && !n.includes(':')) ? `${dex}:${n}` : n;
        const fullUp = fullName.toUpperCase();
        const fd = ctxs[i] && ctxs[i].funding;
        const matchesAny = (candidates) => candidates.some(c => {
          const cu = c.toUpperCase();
          const cuBase = c.replace(/^[^:]+:/, '').toUpperCase();
          return cu === nUp || cu === fullUp || cuBase === nUp;
        });
        const parseValid = (val) => {
          if (val === undefined || val === null || val === '') return null;
          const p = parseFloat(val);
          return Number.isNaN(p) ? null : p;
        };
        if (matchesAny(cfg.a.candidates)) {
          const v = parseValid(fd);
          if (v !== null) fundingA = v;
        }
        if (matchesAny(cfg.b.candidates)) {
          const v = parseValid(fd);
          if (v !== null) fundingB = v;
        }
      });
      logMain(pair, `funding dex="${dex || 'core'}": A=${fundingA} B=${fundingB}`);
    } catch (e) {
      logMain(pair, `funding err (dex=${dex}): ${e.message}`);
    }
  }));

  postMessage({ type: 'fundingTick', pair, data: { fundingA, fundingB } });
}

function startPolling(pair) {
  clearInterval(state[pair].priceTimer);
  clearInterval(state[pair].fundingTimer);

  fetchPrices(pair);
  state[pair].priceTimer = setInterval(() => fetchPrices(pair), state[pair].refreshSec * 1000);

  fetchFunding(pair);
  state[pair].fundingTimer = setInterval(() => fetchFunding(pair), FUNDING_REFRESH_MS);
}

function stopPolling(pair) {
  clearInterval(state[pair].priceTimer);
  clearInterval(state[pair].fundingTimer);
  state[pair].priceTimer = null;
  state[pair].fundingTimer = null;
}

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      API = msg.api;
      break;
    case 'startPolling':
      if (msg.refreshSec) state[msg.pair].refreshSec = msg.refreshSec;
      startPolling(msg.pair);
      break;
    case 'updateRefresh':
      state[msg.pair].refreshSec = msg.refreshSec;
      startPolling(msg.pair); // reinicia com novo intervalo
      break;
    case 'stopPolling':
      stopPolling(msg.pair);
      break;
  }
};
