// Traction loop: the demo buyer agent purchases research reports across all
// supported tickers through the real x402 flow (402 -> EIP-3009 sign ->
// server-side settlement), and triggers a treasury sweep every N purchases.
// Every purchase and sweep is appended to client-agent/traction-log.jsonl
// with its onchain tx hash — the chain remains the durable record; the log
// is the convenient index.
//
// This is a demo/traction driver for the Base Sepolia deployment. It is NOT
// installed as a cron; run it manually:
//   node client-agent/traction-loop.js [--count 24] [--sweep-every 6] [--delay-ms 1500]
// Requires the x402 server to be running (server/server.js, port 4021).
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const SERVER = process.env.SERVER_URL || 'http://localhost:4021';
const WALLET_PATH = path.join(__dirname, 'client-wallet.json'); // gitignored (*-wallet.json)
const LOG_PATH = path.join(__dirname, 'traction-log.jsonl');

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const COUNT = parseInt(argVal('--count', '24'), 10);
const SWEEP_EVERY = parseInt(argVal('--sweep-every', '6'), 10);
const DELAY_MS = parseInt(argVal('--delay-ms', '1500'), 10);
const TICKERS = argVal('--tickers', 'NVDA,TSLA,AAPL,MSFT,META').split(',').map((s) => s.trim().toUpperCase());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
  console.log(JSON.stringify(entry));
}

function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) throw new Error('client-wallet.json missing — run buy.js --init and fund the buyer first');
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  return new ethers.Wallet(raw.privateKey);
}

async function buyReport(wallet, ticker) {
  const url = `${SERVER}/research/${ticker}`;
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`${ticker}: expected HTTP 402, got ${first.status}`);
  const accept = (await first.json()).accepts[0];

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: accept.payTo,
    value: BigInt(accept.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(now + accept.maxTimeoutSeconds * 5),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = { name: accept.extra.name, version: accept.extra.version, chainId: 84532, verifyingContract: accept.asset };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const signature = await wallet.signTypedData(domain, types, authorization);
  const payment = {
    x402Version: 1,
    scheme: accept.scheme,
    network: accept.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(),
        validAfter: authorization.validAfter.toString(),
        validBefore: authorization.validBefore.toString(),
        nonce: authorization.nonce,
      },
    },
  };
  const second = await fetch(url, { headers: { 'X-PAYMENT': Buffer.from(JSON.stringify(payment)).toString('base64') } });
  const body = await second.json();
  if (second.status !== 200) throw new Error(`${ticker}: purchase failed HTTP ${second.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.payment; // { txHash, payer, amount }
}

async function sweep() {
  const res = await fetch(`${SERVER}/treasury/sweep`, { method: 'POST' });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`sweep failed HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main() {
  const wallet = loadWallet();
  console.log(`traction loop: buyer ${wallet.address}, ${COUNT} purchases across ${TICKERS.join('/')}, sweep every ${SWEEP_EVERY}`);
  log({ type: 'run-start', at: new Date().toISOString(), buyer: wallet.address, count: COUNT, tickers: TICKERS, sweepEvery: SWEEP_EVERY });

  let bought = 0;
  for (let i = 0; i < COUNT; i++) {
    const ticker = TICKERS[i % TICKERS.length];
    const payment = await buyReport(wallet, ticker);
    bought++;
    log({ type: 'purchase', at: new Date().toISOString(), n: bought, ticker, tx: payment.txHash, payer: payment.payer, amount: payment.amount });
    if (SWEEP_EVERY > 0 && bought % SWEEP_EVERY === 0) {
      const s = await sweep();
      log({ type: 'sweep', at: new Date().toISOString(), afterPurchases: bought, tx: s.tx || null, swept: s.swept, reason: s.reason || null });
    }
    if (i < COUNT - 1 && DELAY_MS > 0) await sleep(DELAY_MS);
  }

  const t = await (await fetch(`${SERVER}/treasury`)).json();
  log({ type: 'run-end', at: new Date().toISOString(), purchases: bought, treasury: t });
  console.log(`done: ${bought} purchases. treasury: ${JSON.stringify(t)}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
