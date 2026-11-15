// Research engine: builds a structured report for a tokenized stock from
// REAL Base mainnet data — the public Coinbase Tokenized Stocks API
// (read-only, no key). Reports are factual onchain-data summaries with
// derived observations (staleness, multiplier drift, implied reference
// value). They are NOT investment advice and contain no recommendations.
const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';

// Client-facing ticker -> mainnet tokenized symbol.
const TICKERS = {
  NVDA: 'NVDAc',
  TSLA: 'TSLAc',
};

let cache = { at: 0, tokens: null };
async function fetchTokens() {
  if (cache.tokens && Date.now() - cache.at < 60_000) return cache.tokens;
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const data = await res.json();
  cache = { at: Date.now(), tokens: data.tokens || [] };
  return cache.tokens;
}

async function buildReport(ticker) {
  const symbol = TICKERS[ticker];
  if (!symbol) throw new Error(`unsupported ticker ${ticker}`);
  const tokens = await fetchTokens();
  const t = tokens.find((x) => x.symbol === symbol);
  if (!t) throw new Error(`token ${symbol} not found in API response`);

  const now = Date.now();
  const navUpdatedMs = t.nav_price_updated_at ? Date.parse(t.nav_price_updated_at) : null;
  const stalenessSec = navUpdatedMs ? Math.max(0, Math.round((now - navUpdatedMs) / 1000)) : null;
  const multiplier = typeof t.multiplier === 'number' ? t.multiplier : 1;
  const multiplierDriftBps = Math.round((multiplier - 1) * 10000 * 100) / 100;
  const supply = typeof t.total_supply === 'number' ? t.total_supply : null;
  const nav = typeof t.nav_price === 'number' ? t.nav_price : null;
  const impliedReferenceValue = supply !== null && nav !== null ? Math.round(supply * nav * 100) / 100 : null;

  const observations = [];
  if (nav !== null) {
    observations.push(
      `NAV reference value is $${nav} per token (Chainlink-based, published onchain ${t.nav_price_updated_at || 'n/a'}).`
    );
  }
  if (stalenessSec !== null) {
    observations.push(
      stalenessSec <= 6 * 3600
        ? `NAV staleness is ${stalenessSec}s — within a 6h freshness bound. Feeds hold their last value outside market hours.`
        : `NAV staleness is ${stalenessSec}s — beyond a 6h freshness bound; treat the reference value as stale (feeds hold their last value outside market hours).`
    );
  }
  observations.push(
    multiplierDriftBps === 0
      ? 'UI multiplier is exactly 1.0 — token units currently map 1:1 to underlying shares.'
      : `UI multiplier is ${multiplier} (${multiplierDriftBps} bps from 1.0), reflecting reinvested distributions / corporate-action adjustments since issuance.`
  );
  if (supply !== null) {
    observations.push(`Normalized total supply is ${supply} tokens on Base mainnet.`);
  }
  if (impliedReferenceValue !== null) {
    observations.push(`Supply x NAV implies a reference value of about $${impliedReferenceValue} for the tokenized float.`);
  }

  return {
    ticker,
    subject: {
      tokenized_symbol: t.symbol,
      name: t.name,
      mainnet_contract: t.contract_address,
      isin: t.isin || null,
      decimals_mainnet: t.decimals,
    },
    market_reference: {
      nav_price_usd: nav,
      nav_price_updated_at: t.nav_price_updated_at || null,
      nav_staleness_seconds: stalenessSec,
      ui_multiplier: multiplier,
      multiplier_drift_bps: multiplierDriftBps,
      total_supply_tokens: supply,
      implied_reference_value_usd: impliedReferenceValue,
    },
    observations,
    disclaimer:
      'This report is an onchain data summary generated from public reference data. It is not investment advice, not a recommendation, and not an offer to buy or sell any security. NAV is a reference value, not a live bid/ask or execution price.',
    data_source: 'Coinbase Tokenized Stocks API (Base mainnet, read-only, no key)',
    generated_at: new Date().toISOString(),
  };
}

module.exports = { buildReport, TICKERS };
