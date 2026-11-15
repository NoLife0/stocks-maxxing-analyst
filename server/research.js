// Research engine: builds a structured report for a tokenized stock from
// REAL Base mainnet data — the public Coinbase Tokenized Stocks API
// (read-only, no key) plus onchain corporate-action announcements resolved
// through the same API (see corporateActions.js / sync-corporate-actions.js).
// Reports are factual onchain-data summaries with derived observations
// (staleness, multiplier drift, implied reference value). They are NOT
// investment advice and contain no recommendations.
const fs = require('fs');
const path = require('path');

const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';

// Client-facing ticker -> mainnet tokenized symbol.
// A ticker is only listed here if the Tokenized Stocks API actually returns
// NAV + supply + multiplier data for it (verified 2026-11-15). Tickers
// without API data are NOT supported — no data is ever invented.
const TICKERS = {
  NVDA: 'NVDAc',
  TSLA: 'TSLAc',
  AAPL: 'AAPLc',
  MSFT: 'MSFTc',
  META: 'METAc',
};

// Client ticker -> key in contracts/deployments.sepolia.json (testnet B20
// demo token whose treasury position is reported alongside the research).
const SEPOLIA_KEY = {
  NVDA: 'nvda',
  TSLA: 'tsla',
  AAPL: 'aapl',
  MSFT: 'msft',
  META: 'meta',
};

const CA_PATH = path.join(__dirname, 'corporate-actions.json');

let cache = { at: 0, tokens: null };
async function fetchTokens() {
  if (cache.tokens && Date.now() - cache.at < 60_000) return cache.tokens;
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const data = await res.json();
  cache = { at: Date.now(), tokens: data.tokens || [] };
  return cache.tokens;
}

// Latest corporate action for a mainnet symbol, from the local sync file
// (server/corporate-actions.json, produced by sync-corporate-actions.js from
// onchain Announcement events -> API resolution). Returns null when the sync
// has no record — the report then says so instead of inventing an action.
function latestCorporateAction(symbol) {
  try {
    const data = JSON.parse(fs.readFileSync(CA_PATH, 'utf8'));
    const entry = data.actions && data.actions[symbol];
    if (!entry) return { known: false, synced_at: data.synced_at || null };
    return { known: true, synced_at: data.synced_at || null, action: entry.latest || null };
  } catch {
    return { known: false, synced_at: null };
  }
}

async function buildReport(ticker, treasuryPosition = null) {
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

  const ca = latestCorporateAction(symbol);
  const latestAction = !ca.known
    ? null
    : ca.action
      ? {
          description: ca.action.description || null,
          status: ca.action.status || null,
          announced_at: ca.action.announced_at || null,
          applied_at: ca.action.applied_at || null,
          multiplier_before: typeof ca.action.multiplier_before === 'number' ? ca.action.multiplier_before : null,
          multiplier_after: typeof ca.action.multiplier_after === 'number' ? ca.action.multiplier_after : null,
          uri: ca.action.uri || null,
          source: 'Onchain Announcement event -> Coinbase Tokenized Stocks API corporate-actions endpoint',
          synced_at: ca.synced_at,
        }
      : {
          description: null,
          status: null,
          announced_at: null,
          applied_at: null,
          multiplier_before: null,
          multiplier_after: null,
          uri: null,
          note: 'No corporate-action announcement with an addressable URI was found for this token in the onchain Announcement scan (see server/corporate-actions.json for scan coverage).',
          source: 'Onchain Announcement event scan (Base mainnet)',
          synced_at: ca.synced_at,
        };

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
  if (latestAction && latestAction.description) {
    observations.push(
      `Latest corporate action on record: ${latestAction.description} (${latestAction.status || 'n/a'}), announced ${latestAction.announced_at || 'n/a'}${latestAction.applied_at ? `, applied ${latestAction.applied_at}` : ''}.`
    );
  }
  if (supply !== null) {
    observations.push(`Normalized total supply is ${supply} tokens on Base mainnet.`);
  }
  if (impliedReferenceValue !== null) {
    observations.push(`Supply x NAV implies a reference value of about $${impliedReferenceValue} for the tokenized float.`);
  }
  if (treasuryPosition) {
    observations.push(
      `The seller's demo treasury (Base Sepolia) holds ${treasuryPosition.balance_ui_shares} ${treasuryPosition.testnet_symbol} (UI units) accumulated from research revenue sweeps.`
    );
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
    latest_corporate_action: latestAction,
    treasury_position: treasuryPosition,
    observations,
    disclaimer:
      'This report is an onchain data summary generated from public reference data. It is not investment advice, not a recommendation, and not an offer to buy or sell any security. NAV is a reference value, not a live bid/ask or execution price.',
    data_source: 'Coinbase Tokenized Stocks API (Base mainnet, read-only, no key)',
    generated_at: new Date().toISOString(),
  };
}

module.exports = { buildReport, TICKERS, SEPOLIA_KEY };
