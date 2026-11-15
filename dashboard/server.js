// Analyst-for-Hire — public dashboard (read-only).
//
// Everything on this page is reconstructed from chain state, not from the
// x402 server's memory:
//   * Base Sepolia: TreasuryPolicy balances (tUSDC + balanceOfUI per B20
//     testnet stock), totalSwept / sweepCount, the full sales history
//     (tUSDC Transfer events into the policy = settled report payments)
//     and the sweep history (policy Sweep events + SimpleRouter Buy events
//     for the per-asset allocation).
//   * Base mainnet: live NAV reference per ticker from the public Coinbase
//     Tokenized Stocks API.
// No private keys are used or needed here — this server only reads.
//
// Run: node dashboard/server.js   (PORT env, default 4030)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
// The public sepolia.base.org endpoint rate-limits (25 req/s) under bursty
// log scans; default this read-only dashboard's PRIMARY endpoint to
// publicnode instead (override with DASHBOARD_RPC). lib.js turns the list
// into a FallbackProvider, so sepolia.base.org and drpc remain automatic
// fallbacks behind it. Must be set before lib.js loads.
process.env.BASE_SEPOLIA_RPC =
  process.env.DASHBOARD_RPC || process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia-rpc.publicnode.com';
const { provider, loadDeployments } = require('../contracts/scripts/lib');

const PORT = process.env.PORT || 4030;
const EXPLORER = 'https://sepolia.basescan.org';
const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';
const MAINNET_SYMBOL = { nvda: 'NVDAc', tsla: 'TSLAc', aapl: 'AAPLc', msft: 'MSFTc', meta: 'METAc' };

const dep = loadDeployments();
const prov = provider();

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const POLICY_ABI = [
  'function totalSwept() view returns (uint256)',
  'function sweepCount() view returns (uint256)',
  'event Sweep(uint256 indexed sweepId, uint256 totalUsdc, uint256 timestamp)',
];
const STOCK_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfUI(address) view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
];
const ROUTER_ABI = ['event Buy(address indexed buyer, address indexed asset, uint256 usdcIn, uint256 stockOut, address indexed to)'];

const usdc = new ethers.Contract(dep.usdc.address, ERC20_ABI, prov);
const policy = new ethers.Contract(dep.policy.address, POLICY_ABI, prov);
const routerIface = new ethers.Interface(ROUTER_ABI);
const stockByAddress = {};
for (const [key, s] of Object.entries(dep.stocks)) stockByAddress[s.address.toLowerCase()] = { key, ...s };

let deployBlock = null;
async function getDeployBlock() {
  if (deployBlock) return deployBlock;
  const rcpt = await prov.getTransactionReceipt(dep.deployTxs.policyDeploy);
  deployBlock = rcpt.blockNumber;
  return deployBlock;
}

async function getLogsChunked(contract, filter, from, to) {
  // Per-chunk retry with backoff (Phase 3): a single rate-limited chunk
  // must not discard the whole state build. The provider underneath is
  // already a multi-endpoint FallbackProvider (contracts/scripts/lib.js)
  // with this dashboard's RPC promoted to primary.
  const out = [];
  const CH = 10000;
  for (let f = from; f <= to; f += CH) {
    const t = Math.min(to, f + CH - 1);
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        out.push(...(await contract.queryFilter(filter, f, t)));
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (lastErr) throw lastErr;
  }
  return out;
}

const blockTimeCache = new Map();
async function blockTime(bn) {
  if (!blockTimeCache.has(bn)) {
    const b = await prov.getBlock(bn);
    blockTimeCache.set(bn, b.timestamp);
  }
  return blockTimeCache.get(bn);
}

let navCache = { at: 0, map: {} };
async function fetchNav() {
  if (Date.now() - navCache.at < 60_000) return navCache.map;
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const { tokens } = await res.json();
  const map = {};
  for (const t of tokens) map[t.symbol] = t;
  navCache = { at: Date.now(), map };
  return map;
}

async function buildState() {
  const from = await getDeployBlock();
  const head = await prov.getBlockNumber();
  const nav = await fetchNav();

  const [usdcBal, totalSwept, sweepCount] = await Promise.all([
    usdc.balanceOf(dep.policy.address),
    policy.totalSwept(),
    policy.sweepCount(),
  ]);

  const positions = [];
  for (const [key, s] of Object.entries(dep.stocks)) {
    const stock = new ethers.Contract(s.address, STOCK_ABI, prov);
    const [raw, ui, mult] = await Promise.all([
      stock.balanceOf(dep.policy.address),
      stock.balanceOfUI(dep.policy.address),
      stock.uiMultiplier(),
    ]);
    const m = nav[MAINNET_SYMBOL[key]];
    const uiShares = Number(ui) / 1e6;
    positions.push({
      key,
      symbol: s.symbol,
      address: s.address,
      balance_raw: raw.toString(),
      balance_ui: ui.toString(),
      ui_shares: uiShares,
      ui_multiplier: (Number(mult) / 1e18).toString(),
      nav_usd: m && typeof m.nav_price === 'number' ? m.nav_price : null,
      nav_updated_at: m ? m.nav_price_updated_at || null : null,
      reference_value_usd: m && typeof m.nav_price === 'number' ? Math.round(uiShares * m.nav_price * 10000) / 10000 : null,
    });
  }

  // Sales history: every tUSDC transfer INTO the policy is a settled report
  // payment (the only inbound flow by construction).
  const saleLogs = await getLogsChunked(usdc, usdc.filters.Transfer(null, dep.policy.address), from, head);
  const sales = [];
  let revenue = 0n;
  for (const l of saleLogs) {
    revenue += l.args.value;
    sales.push({
      kind: 'sale',
      tx: l.transactionHash,
      block: l.blockNumber,
      time: new Date((await blockTime(l.blockNumber)) * 1000).toISOString(),
      payer: l.args.from,
      amount_tusdc: (Number(l.args.value) / 1e6).toString(),
    });
  }

  // Sweep history: policy Sweep events; per-asset allocation from the
  // router Buy events inside the same transaction.
  const sweepLogs = await getLogsChunked(policy, policy.filters.Sweep(), from, head);
  const sweeps = [];
  for (const l of sweepLogs) {
    const rcpt = await prov.getTransactionReceipt(l.transactionHash);
    const buys = [];
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== dep.router.address.toLowerCase()) continue;
      try {
        const parsed = routerIface.parseLog(log);
        if (parsed && parsed.name === 'Buy') {
          const st = stockByAddress[parsed.args.asset.toLowerCase()];
          buys.push({
            asset: st ? st.symbol : parsed.args.asset,
            usdc_in: (Number(parsed.args.usdcIn) / 1e6).toString(),
            stock_out_ui: (Number(parsed.args.stockOut) / 1e6).toString(),
          });
        }
      } catch { /* not a Buy log */ }
    }
    sweeps.push({
      kind: 'sweep',
      tx: l.transactionHash,
      block: l.blockNumber,
      time: new Date((await blockTime(l.blockNumber)) * 1000).toISOString(),
      sweep_id: Number(l.args.sweepId),
      total_tusdc: (Number(l.args.totalUsdc) / 1e6).toString(),
      buys,
    });
  }

  const activity = [...sales, ...sweeps].sort((a, b) => b.block - a.block || (a.kind === 'sweep' ? -1 : 1));
  return {
    generated_at: new Date().toISOString(),
    network: 'base-sepolia',
    explorer: EXPLORER,
    contracts: {
      policy: dep.policy.address,
      usdc: dep.usdc.address,
      router: dep.router.address,
      agent: dep.agent,
    },
    revenue: {
      reports_sold: sales.length,
      total_tusdc: (Number(revenue) / 1e6).toString(),
      price_per_report_tusdc: '0.25',
    },
    treasury: {
      usdc_balance_tusdc: (Number(usdcBal) / 1e6).toString(),
      total_swept_tusdc: (Number(totalSwept) / 1e6).toString(),
      sweep_count: Number(sweepCount),
      positions,
      positions_reference_value_usd:
        Math.round(positions.reduce((a, p) => a + (p.reference_value_usd || 0), 0) * 10000) / 10000,
    },
    activity,
  };
}

let cache = { at: 0, state: null };
async function getState() {
  if (cache.state && Date.now() - cache.at < 15_000) return cache.state;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const state = await buildState();
      cache = { at: Date.now(), state };
      return state;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  // Last resort: serve the last good state rather than an error page —
  // the dashboard is a read-only view and slightly stale beats broken.
  if (cache.state) return { ...cache.state, stale: true, stale_since: new Date(cache.at).toISOString() };
  throw lastErr;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/state') {
      const body = JSON.stringify(await getState(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(body);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Analyst-for-Hire dashboard on http://localhost:${PORT} (read-only, Base Sepolia)`);
});
