// Analyst-for-Hire — x402 research server (Base Sepolia demo).
//
// Flow (x402 "exact" scheme, EVM / EIP-3009):
//   1. GET /research/:ticker without X-PAYMENT  -> HTTP 402 + accepts[]
//   2. Client signs an EIP-3009 transferWithAuthorization for the price in
//      tUSDC, payable to the TreasuryPolicy contract, and retries with the
//      base64 X-PAYMENT header.
//   3. This server VERIFIES the signature itself and SETTLES it by submitting
//      transferWithAuthorization from the agent wallet (self-facilitation).
//      Rationale: the payment asset is a demo token (MockUSDC) that no public
//      x402 facilitator settles; the verification performed here is exactly
//      the facilitator's job — signature recovery, payTo/amount/window/nonce
//      checks — done in-house. See PHASE1.md.
//   4. On settlement the server returns the research report (built from live
//      Base mainnet data) plus an X-PAYMENT-RESPONSE receipt header.
//
// Revenue lands in the TreasuryPolicy contract; POST /treasury/sweep runs the
// policy engine: profit above the operating reserve is swept into the stock
// basket through the policy contract (allowlist + per-sweep cap enforced
// onchain).
const http = require('http');
const { ethers } = require('ethers');
const { provider, agentWallet, loadDeployments } = require('../contracts/scripts/lib');
const { buildReport, TICKERS } = require('./research');

const PORT = process.env.PORT || 4021;
const PRICE = 250000n; // 0.25 tUSDC per report
const RESERVE = 50000n; // 0.05 tUSDC operating reserve kept in the policy
const BASKET = [
  { key: 'nvda', weightBps: 6000 }, // 60% NVDAxT
  { key: 'tsla', weightBps: 4000 }, // 40% TSLAxT
];

const dep = loadDeployments();
if (!dep.usdc || !dep.policy || !dep.stocks) {
  console.error('deployments.sepolia.json incomplete — run create-b20.js and deploy.js first');
  process.exit(1);
}

const prov = provider();
const wallet = agentWallet(prov);

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address, bytes32) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
];
const POLICY_ABI = [
  'function sweep(address[] assets, uint256[] usdcAmounts) returns (uint256)',
  'function totalSwept() view returns (uint256)',
  'function sweepCount() view returns (uint256)',
];
const STOCK_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfUI(address) view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
];

const usdc = new ethers.Contract(dep.usdc.address, USDC_ABI, wallet);
const policy = new ethers.Contract(dep.policy.address, POLICY_ABI, wallet);

const EIP712_DOMAIN = {
  name: 'Testnet USD Coin',
  version: '1',
  chainId: 84532,
  verifyingContract: dep.usdc.address,
};
const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const sales = []; // in-memory sales log; the chain is the durable record

function paymentRequirements(req, ticker) {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: PRICE.toString(),
        resource: `http://${req.headers.host}/research/${ticker}`,
        description: `Tokenized-stock research report (${ticker}) — onchain data summary, not investment advice`,
        mimeType: 'application/json',
        payTo: dep.policy.address,
        maxTimeoutSeconds: 120,
        asset: dep.usdc.address,
        extra: { name: EIP712_DOMAIN.name, version: EIP712_DOMAIN.version },
      },
    ],
  };
}

async function verifyAndSettle(payment) {
  if (!payment || payment.scheme !== 'exact' || payment.network !== 'base-sepolia') {
    throw new Error('unsupported payment scheme/network');
  }
  const { signature, authorization } = payment.payload || {};
  if (!signature || !authorization) throw new Error('malformed payment payload');
  const auth = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };
  const signer = ethers.verifyTypedData(EIP712_DOMAIN, AUTH_TYPES, auth, signature);
  if (signer.toLowerCase() !== auth.from.toLowerCase()) throw new Error('signature does not match payer');
  if (auth.to.toLowerCase() !== dep.policy.address.toLowerCase()) throw new Error('wrong payTo');
  if (auth.value < PRICE) throw new Error('insufficient payment amount');
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now <= auth.validAfter || now >= auth.validBefore) throw new Error('authorization outside validity window');
  if (await usdc.authorizationState(auth.from, auth.nonce)) throw new Error('authorization already used');
  if ((await usdc.balanceOf(auth.from)) < auth.value) throw new Error('payer balance too low');

  const sig = ethers.Signature.from(signature);
  const tx = await usdc.transferWithAuthorization(
    auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, sig.v, sig.r, sig.s
  );
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error('settlement tx reverted');
  return { txHash: tx.hash, payer: auth.from, amount: auth.value.toString() };
}

async function treasuryState() {
  const usdcBal = await usdc.balanceOf(dep.policy.address);
  const positions = {};
  for (const { key } of BASKET) {
    const stock = new ethers.Contract(dep.stocks[key].address, STOCK_ABI, prov);
    const [raw, ui, mult] = await Promise.all([
      stock.balanceOf(dep.policy.address),
      stock.balanceOfUI(dep.policy.address),
      stock.uiMultiplier(),
    ]);
    positions[dep.stocks[key].symbol] = {
      address: dep.stocks[key].address,
      balance_raw: raw.toString(),
      balance_ui: ui.toString(),
      ui_multiplier: mult.toString(),
    };
  }
  return {
    policy: dep.policy.address,
    usdc_balance: usdcBal.toString(),
    total_swept: (await policy.totalSwept()).toString(),
    sweep_count: Number(await policy.sweepCount()),
    positions,
    sales_count: sales.length,
  };
}

async function runSweep() {
  const balance = await usdc.balanceOf(dep.policy.address);
  const sweepable = balance > RESERVE ? balance - RESERVE : 0n;
  if (sweepable <= 0n) return { swept: '0', reason: 'balance at or below operating reserve', balance: balance.toString() };
  const assets = [];
  const amounts = [];
  let allocated = 0n;
  BASKET.forEach(({ key, weightBps }, i) => {
    const amt = i === BASKET.length - 1 ? sweepable - allocated : (sweepable * BigInt(weightBps)) / 10000n;
    allocated += amt;
    assets.push(dep.stocks[key].address);
    amounts.push(amt);
  });
  const tx = await policy.sweep(assets, amounts);
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error('sweep tx reverted');
  return {
    swept: sweepable.toString(),
    allocation: Object.fromEntries(assets.map((a, i) => [a, amounts[i].toString()])),
    tx: tx.hash,
    treasury: await treasuryState(),
  };
}

function sendJson(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, network: 'base-sepolia', payTo: dep.policy.address, price: PRICE.toString(), asset: dep.usdc.address });
    }
    const m = url.pathname.match(/^\/research\/([A-Za-z]+)$/);
    if (m && req.method === 'GET') {
      const ticker = m[1].toUpperCase();
      if (!TICKERS[ticker]) return sendJson(res, 404, { error: `unsupported ticker ${ticker}`, supported: Object.keys(TICKERS) });
      const header = req.headers['x-payment'];
      if (!header) return sendJson(res, 402, paymentRequirements(req, ticker));
      let payment;
      try {
        payment = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'X-PAYMENT header is not base64 JSON' });
      }
      let settled;
      try {
        settled = await verifyAndSettle(payment);
      } catch (e) {
        return sendJson(res, 402, { error: `payment invalid: ${e.message}`, accepts: paymentRequirements(req, ticker).accepts });
      }
      const report = await buildReport(ticker);
      sales.push({ ticker, ...settled, at: new Date().toISOString() });
      const responseReceipt = Buffer.from(
        JSON.stringify({ success: true, transaction: settled.txHash, network: 'base-sepolia', payer: settled.payer })
      ).toString('base64');
      return sendJson(res, 200, { report, payment: settled }, { 'X-PAYMENT-RESPONSE': responseReceipt });
    }
    if (url.pathname === '/treasury' && req.method === 'GET') {
      return sendJson(res, 200, await treasuryState());
    }
    if (url.pathname === '/treasury/sweep' && req.method === 'POST') {
      return sendJson(res, 200, await runSweep());
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Analyst-for-Hire x402 server on http://localhost:${PORT}`);
  console.log(`payTo (TreasuryPolicy): ${dep.policy.address} | asset (tUSDC): ${dep.usdc.address} | price: ${PRICE} (0.25 tUSDC)`);
});
