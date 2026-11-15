// Demo buyer agent: purchases one research report via x402.
// The buyer wallet holds NO ETH — it only signs an EIP-3009 authorization;
// the server settles it (gasless for the buyer, the point of x402/exact).
//
// Usage:
//   node client-agent/buy.js --init        create/print the buyer wallet
//   node client-agent/buy.js NVDA          buy one NVDA report
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const SERVER = process.env.SERVER_URL || 'http://localhost:4021';
const WALLET_PATH = path.join(__dirname, 'client-wallet.json'); // gitignored (*-wallet.json)

function loadOrCreateWallet() {
  if (fs.existsSync(WALLET_PATH)) {
    const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
    return new ethers.Wallet(raw.privateKey);
  }
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(
    WALLET_PATH,
    JSON.stringify(
      { role: 'demo buyer agent (no ETH, signs EIP-3009 only)', address: w.address, privateKey: w.privateKey, created: new Date().toISOString() },
      null, 2
    ) + '\n',
    { mode: 0o600 }
  );
  return w;
}

async function main() {
  const wallet = loadOrCreateWallet();
  const arg = process.argv[2] || 'NVDA';
  if (arg === '--init') {
    console.log('buyer wallet:', wallet.address);
    console.log('saved to client-agent/client-wallet.json (mode 600, gitignored)');
    return;
  }
  const ticker = arg.toUpperCase();
  const url = `${SERVER}/research/${ticker}`;

  // 1. Unpaid request -> expect HTTP 402 with payment requirements
  const first = await fetch(url);
  console.log(`GET ${url} -> HTTP ${first.status}`);
  if (first.status !== 402) {
    console.log(await first.text());
    throw new Error('expected HTTP 402');
  }
  const reqs = await first.json();
  const accept = reqs.accepts[0];
  console.log('402 accepts:', JSON.stringify(accept, null, 2));

  // 2. Sign the EIP-3009 authorization
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: accept.payTo,
    value: BigInt(accept.maxAmountRequired),
    validAfter: 0n,
    validBefore: BigInt(now + accept.maxTimeoutSeconds * 5),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const domain = {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: 84532,
    verifyingContract: accept.asset,
  };
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
  const header = Buffer.from(JSON.stringify(payment)).toString('base64');

  // 3. Paid retry
  const second = await fetch(url, { headers: { 'X-PAYMENT': header } });
  console.log(`GET ${url} (X-PAYMENT) -> HTTP ${second.status}`);
  const receiptHeader = second.headers.get('x-payment-response');
  if (receiptHeader) {
    console.log('X-PAYMENT-RESPONSE:', Buffer.from(receiptHeader, 'base64').toString('utf8'));
  }
  const body = await second.json();
  console.log(JSON.stringify(body, null, 2));
  if (second.status !== 200) throw new Error('purchase failed');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
