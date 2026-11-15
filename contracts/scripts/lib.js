// Shared helpers for Stocks Maxxing Analyst scripts (Base Sepolia only).
//
// Read-path resilience (Phase 3): the public Sepolia endpoints rate-limit
// under burst load (sepolia.base.org answers 25 req/s with errors, which in
// Phase 2 made post-sweep treasury reads fail even though the tx had
// landed). Reads therefore go through an ethers FallbackProvider over
// several public endpoints (quorum 1 = first healthy answer wins, the rest
// are fallbacks), and callers wrap critical reads in withRetry() for
// exponential-backoff retries on top of the failover.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// Ordered Sepolia RPC endpoints. BASE_SEPOLIA_RPC (if set) is promoted to
// primary; BASE_SEPOLIA_RPCS (comma list) replaces the list entirely.
const DEFAULT_SEPOLIA_RPCS = [
  'https://sepolia.base.org',
  'https://base-sepolia-rpc.publicnode.com',
  'https://base-sepolia.drpc.org',
];
function sepoliaRpcs() {
  if (process.env.BASE_SEPOLIA_RPCS) {
    return process.env.BASE_SEPOLIA_RPCS.split(',').map((s) => s.trim()).filter(Boolean);
  }
  const list = [...DEFAULT_SEPOLIA_RPCS];
  if (process.env.BASE_SEPOLIA_RPC) {
    const primary = process.env.BASE_SEPOLIA_RPC;
    return [primary, ...list.filter((u) => u !== primary)];
  }
  return list;
}
const SEPOLIA_RPCS = sepoliaRpcs();
const SEPOLIA_RPC = SEPOLIA_RPCS[0];
const MAINNET_RPC = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org';
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';

const WALLET_PATH =
  process.env.AGENT_WALLET_PATH ||
  path.join(__dirname, '..', '..', '..', 'agent-wallet.json');

// Failover provider for READS (and wallet use): each endpoint gets a
// priority by list order; with quorum 1 a stalled or rate-limited endpoint
// is skipped for the next one instead of failing the call.
function provider() {
  const providers = SEPOLIA_RPCS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, CHAIN_ID, { staticNetwork: true }),
    priority: i + 1,
    stallTimeout: 2500,
    weight: 1,
  }));
  if (providers.length === 1) return providers[0].provider;
  return new ethers.FallbackProvider(providers, CHAIN_ID, { quorum: 1 });
}

// Retry an async operation with exponential backoff + jitter. Use for
// critical chain reads whose failure must not masquerade as a failed
// transaction (the Phase 2 sweep incident).
async function withRetry(fn, { tries = 4, baseMs = 600, label = 'rpc call' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === tries) break;
      const wait = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.error(`[withRetry] ${label} failed (attempt ${attempt}/${tries}): ${String(e.message || e).slice(0, 120)} — retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function agentWallet(prov) {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  if (!raw.privateKey) throw new Error('agent wallet file missing privateKey');
  return new ethers.Wallet(raw.privateKey, prov || provider());
}

const DEPLOY_PATH = path.join(__dirname, '..', 'deployments.sepolia.json');

function loadDeployments() {
  if (!fs.existsSync(DEPLOY_PATH)) return {};
  return JSON.parse(fs.readFileSync(DEPLOY_PATH, 'utf8'));
}

function saveDeployments(patch) {
  const cur = loadDeployments();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(DEPLOY_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

module.exports = {
  SEPOLIA_RPC,
  SEPOLIA_RPCS,
  MAINNET_RPC,
  CHAIN_ID,
  EXPLORER,
  provider,
  withRetry,
  agentWallet,
  loadDeployments,
  saveDeployments,
};
