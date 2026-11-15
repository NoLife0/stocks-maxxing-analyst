// Sync the latest corporate action per supported tokenized stock from
// Base mainnet into server/corporate-actions.json (read by research.js).
//
// How it works (per the official Tokenized Stocks API docs):
//   * Corporate actions are announced onchain by the token contract in an
//     `Announcement` event. The event's topic0 is
//     0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7
//     (verified 2026-11-15 against the GOOGLc cash-dividend announcement
//     txs 0xb5aa54fb… / 0xcd45e69e…: 1 indexed address topic, data =
//     [offsetA, offsetB, uint] with string A = announcement id, string B =
//     description). Early announcements carry a numeric id ("2097"); the
//     applied/addressable announcement carries a UUID id.
//   * The UUID is the id for GET /v1/tokenized-stocks/corporate-actions/{id},
//     which returns the full action (status, multiplier before/after, ...).
//
// The scan walks BACKWARD from the chain head to each token's creation
// block (found by binary search on eth_getCode — no block-rate assumption)
// and stops early once the newest UUID announcement is found.
// Progress is persisted after every chunk batch, so the script is resumable
// and partial coverage is recorded honestly (scan.complete flag).
//
// Usage: node server/sync-corporate-actions.js [--only NVDAc,TSLAc] [--chunk 10000] [--out path]
// --out lets parallel per-token runs write separate state files (merged
// afterwards); default is server/corporate-actions.json.
const fs = require('fs');
const path = require('path');

const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';
const args = process.argv.slice(2);
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(__dirname, 'corporate-actions.json');
const ANNOUNCEMENT_TOPIC = '0xccebf8218a62875909564adef86a6f4df81503cb617221e793357d62f8e813f7';
// Archive-capable public endpoints for old-block eth_getLogs (checked
// 2026-11-15): mainnet.base.org (archive, rate-limits under load) and the
// Pinax public endpoint (archive, slow). publicnode refuses archive ranges
// without a token and drpc free caps the range, so both stay in the
// rotation only as extra chances for the non-log calls.
const RPCS = [
  'https://mainnet.base.org',
  'https://base.rpc.service.pinax.network',
  'https://base-rpc.publicnode.com',
  'https://base.drpc.org',
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYMBOLS = ['NVDAc', 'TSLAc', 'AAPLc', 'MSFTc', 'METAc'];

const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : SYMBOLS;
const CHUNK = args.includes('--chunk') ? parseInt(args[args.indexOf('--chunk') + 1], 10) : 10000;

let rpcIdx = 0;
async function rpc(method, params) {
  let lastErr;
  for (let tries = 0; tries < RPCS.length * 2; tries++) {
    const url = RPCS[rpcIdx++ % RPCS.length];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const data = await res.json();
      if (data.error) throw new Error(`${url}: ${data.error.message || JSON.stringify(data.error)}`);
      return data.result;
    } catch (e) {
      lastErr = e;
      // Back off progressively — mainnet.base.org answers bursts with
      // "request limit reached"; hammering it makes the limit worse.
      await new Promise((r) => setTimeout(r, 400 * (tries + 1)));
    }
  }
  throw lastErr || new Error('all RPC endpoints failed');
}

const hex = (n) => '0x' + n.toString(16);

async function getLogs(address, from, to) {
  return rpc('eth_getLogs', [{ address, topics: [ANNOUNCEMENT_TOPIC], fromBlock: hex(from), toBlock: hex(to) }]);
}

// Decode string A (announcement id) from the Announcement event data:
// head = [offsetA, offsetB, uint]; each string = [length][bytes] at its offset.
function decodeAnnouncementId(data) {
  const buf = Buffer.from(data.slice(2), 'hex');
  if (buf.length < 64) return null;
  const offA = Number(buf.readBigUInt64BE(24));
  if (offA + 32 > buf.length) return null;
  const len = Number(buf.readBigUInt64BE(offA + 24));
  if (offA + 32 + len > buf.length) return null;
  return buf.subarray(offA + 32, offA + 32 + len).toString('utf8');
}

function loadOut() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    return { actions: {} };
  }
}

function saveOut(state) {
  state.synced_at = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n');
}

async function fetchAction(uuid) {
  const res = await fetch(`https://api.coinbase.com/v1/tokenized-stocks/corporate-actions/${uuid}`);
  if (!res.ok) return null;
  const a = await res.json();
  if (!a || a.code) return null;
  return {
    id: a.id,
    uri: a.uri || null,
    description: a.description || null,
    status: a.status || null,
    announced_at: a.announced_at || null,
    applied_at: a.applied_at || null,
    multiplier_before: typeof a.multiplier_before === 'number' ? a.multiplier_before : null,
    multiplier_after: typeof a.multiplier_after === 'number' ? a.multiplier_after : null,
  };
}

// Find a contract's creation block by binary search on eth_getCode
// (code absent before creation, present after). Assumption-free — the
// chain's block rate is not constant, so date->block estimates mislead.
async function findCreationBlock(address, head) {
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpc('eth_getCode', [address, hex(mid)]);
    if (code && code !== '0x') hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function main() {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const { tokens } = await res.json();
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  console.log('mainnet head:', latest);

  const state = loadOut();
  state.actions = state.actions || {};

  for (const symbol of only) {
    const tok = tokens.find((t) => t.symbol === symbol);
    if (!tok) {
      console.log(`${symbol}: not in API list, skipped`);
      continue;
    }
    const prev = state.actions[symbol] || {};
    if (prev.scan && prev.scan.complete && prev.latest) {
      console.log(`${symbol}: already synced (latest action ${prev.latest.id}), skipping full rescan`);
      continue;
    }
    // Scan floor = the token contract's creation block (binary search),
    // cached in the state file across runs.
    const estMintBlock =
      prev.scan && prev.scan.first_mint_block_est
        ? prev.scan.first_mint_block_est
        : await findCreationBlock(tok.contract_address, latest);
    const startTo = prev.scan && prev.scan.scanned_down_to ? prev.scan.scanned_down_to : latest;
    console.log(`\n${symbol} (${tok.contract_address}): scanning ${startTo} -> ${estMintBlock} in ${CHUNK}-block chunks`);

    const found = prev.found || []; // [{block, id, tx}]
    let to = startTo;
    let complete = false;
    let chunks = 0;
    while (to > estMintBlock) {
      const from = Math.max(estMintBlock, to - CHUNK + 1);
      let logs;
      try {
        logs = await getLogs(tok.contract_address, from, to);
      } catch (e) {
        console.log(`  chunk ${from}-${to} failed (${e.message.slice(0, 80)}) — progress saved, will resume`);
        break;
      }
      for (const l of logs) {
        const id = decodeAnnouncementId(l.data);
        if (id) found.push({ block: parseInt(l.blockNumber, 16), id, tx: l.transactionHash });
      }
      chunks++;
      to = from - 1;
      const hasUuid = found.some((f) => UUID_RE.test(f.id));
      state.actions[symbol] = {
        contract: tok.contract_address,
        first_mint_date: tok.first_mint_date || null,
        found,
        scan: { head_block: latest, scanned_down_to: to, first_mint_block_est: estMintBlock, complete: false },
        latest: prev.latest || null,
      };
      saveOut(state);
      if (hasUuid) {
        complete = false; // newest UUID found; earlier history not needed for "latest"
        console.log(`  UUID announcement found after ${chunks} chunks (down to block ${to})`);
        break;
      }
      if (chunks % 25 === 0) console.log(`  ...${chunks} chunks, down to ${to}, announcements so far: ${found.length}`);
    }
    if (to <= estMintBlock) complete = true;

    // Resolve the newest UUID announcement via the API.
    const uuids = found.filter((f) => UUID_RE.test(f.id)).sort((a, b) => b.block - a.block);
    let latestAction = prev.latest || null;
    if (uuids.length) {
      const action = await fetchAction(uuids[0].id);
      if (action) latestAction = action;
      console.log(`  announcements: ${found.length}, UUID announcements: ${uuids.length}, latest resolved: ${latestAction ? latestAction.id : 'FAILED'}`);
    } else {
      console.log(`  announcements: ${found.length}, no UUID announcement in scanned range`);
    }
    state.actions[symbol] = {
      contract: tok.contract_address,
      first_mint_date: tok.first_mint_date || null,
      found,
      scan: { head_block: latest, scanned_down_to: to, first_mint_block_est: estMintBlock, complete },
      latest: latestAction,
    };
    saveOut(state);
    console.log(`  saved. complete=${complete}`);
  }
  console.log('\nDone. Wrote', OUT);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
