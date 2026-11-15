// Merge per-token corporate-action sync outputs into
// server/corporate-actions.json (the file research.js reads).
//
// Phase 3 ran the sync as parallel per-token processes
// (sync-corporate-actions.js --only <SYM> --out ca-parts/ca-<SYM>.json in
// the workspace root) because a single sequential pass over ~8.5M blocks
// per token is slow on rate-limited public RPCs. Run this once those
// processes finish (or any time, to fold in partial progress):
//
//   node server/merge-corporate-actions.js [partsDir]
//
// Merge rule per symbol: an entry with a resolved `latest` wins; otherwise
// the entry whose scan reached the lowest block (most coverage) wins.
// The main file's own entries are candidates too, so nothing is lost.
const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, 'corporate-actions.json');
const partsDir = process.argv[2] || path.join(__dirname, '..', '..', 'ca-parts');

function load(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function score(entry) {
  if (!entry) return -1;
  const hasLatest = entry.latest ? 1e12 : 0;
  const coverage = entry.scan ? (entry.scan.head_block || 0) - (entry.scan.scanned_down_to || 0) : 0;
  return hasLatest + coverage;
}

function main() {
  const merged = load(MAIN) || { actions: {} };
  merged.actions = merged.actions || {};
  const files = fs.existsSync(partsDir) ? fs.readdirSync(partsDir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const part = load(path.join(partsDir, f));
    if (!part || !part.actions) continue;
    for (const [symbol, entry] of Object.entries(part.actions)) {
      if (score(entry) > score(merged.actions[symbol])) {
        merged.actions[symbol] = entry;
        console.log(`${symbol}: took entry from ${f} (latest=${entry.latest ? entry.latest.id : 'none'}, scanned_down_to=${entry.scan ? entry.scan.scanned_down_to : '?'}, complete=${entry.scan ? entry.scan.complete : '?'})`);
      } else {
        console.log(`${symbol}: kept existing entry (part ${f} not better)`);
      }
    }
  }
  merged.synced_at = new Date().toISOString();
  fs.writeFileSync(MAIN, JSON.stringify(merged, null, 2) + '\n');
  console.log('Wrote', MAIN);
}

main();
