// Phase 2 expansion: issue testnet B20 Asset tokens for the additional
// flagship tickers that enter the sweep basket (AAPL, MSFT, META), wire them
// into the existing SimpleRouter (reference price from LIVE mainnet NAV +
// inventory) and the TreasuryPolicy allowlist.
//
// Same pattern as create-b20.js (Phase 1): REAL B20 Asset tokens via the Base
// factory precompile on Base Sepolia — genuine ERC-8056 multiplier semantics.
// Names state plainly that these are testnet demo instruments; no affiliation
// with Coinbase, Apple, Microsoft, Meta, or any issuer is claimed or implied.
// Idempotent: re-running skips steps that are already done.
const { ethers } = require('ethers');
const { provider, agentWallet, saveDeployments, loadDeployments, EXPLORER } = require('./lib');

const FACTORY = '0xB20f000000000000000000000000000000000000';
const ACTIVATION = '0x8453000000000000000000000000000000000001';
const ASSET_FEATURE = ethers.keccak256(ethers.toUtf8Bytes('base.b20_asset'));
const MINT_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINT_ROLE'));
const MAX_UINT128 = (1n << 128n) - 1n;
const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';
const ROUTER_INVENTORY = 10000n * 10n ** 6n; // 10,000 shares per stock

const FACTORY_ABI = [
  'function createB20(uint8 variant, bytes32 salt, bytes params, bytes[] initCalls) payable returns (address)',
  'function getB20Address(uint8 variant, address sender, bytes32 salt) view returns (address)',
  'function isB20Initialized(address token) view returns (bool)',
];
const ACT_ABI = ['function isActivated(bytes32 feature) view returns (bool)'];
const IB20_ABI = [
  'function grantRole(bytes32 role, address account)',
  'function updateSupplyCap(uint256 newSupplyCap)',
];
const IB20_ASSET_ABI = ['function batchMint(address[] recipients, uint256[] amounts)'];
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const ERC8056_ABI = [
  'function uiMultiplier() view returns (uint256)',
  'function balanceOfUI(address) view returns (uint256)',
];
const ROUTER_ABI = [
  'function priceUsdcPerShare(address) view returns (uint256)',
  'function setPrice(address asset, uint256 price)',
];
const POLICY_ABI = [
  'function allowlisted(address) view returns (bool)',
  'function setAllowlisted(address asset, bool allowed)',
];

const TOKENS = [
  { key: 'aapl', name: 'Testnet AAPL Share - Demo Only', symbol: 'AAPLxT', mainnetSymbol: 'AAPLc', saltSeed: 'stocks-maxxing-analyst/AAPLxT', initialMint: 100000n * 10n ** 6n },
  { key: 'msft', name: 'Testnet MSFT Share - Demo Only', symbol: 'MSFTxT', mainnetSymbol: 'MSFTc', saltSeed: 'stocks-maxxing-analyst/MSFTxT', initialMint: 100000n * 10n ** 6n },
  { key: 'meta', name: 'Testnet META Share - Demo Only', symbol: 'METAxT', mainnetSymbol: 'METAc', saltSeed: 'stocks-maxxing-analyst/METAxT', initialMint: 100000n * 10n ** 6n },
];

function encodeAssetParams(name, symbol, admin, decimals) {
  return new ethers.AbiCoder().encode(
    ['tuple(uint8 version, string name, string symbol, address initialAdmin, uint8 decimals)'],
    [[1, name, symbol, admin, decimals]]
  );
}

async function fetchNav(symbol) {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const data = await res.json();
  const tok = (data.tokens || []).find((t) => t.symbol === symbol);
  if (!tok || typeof tok.nav_price !== 'number') throw new Error(`NAV missing for ${symbol} — refusing to invent a price`);
  return tok;
}

async function main() {
  const prov = provider();
  const wallet = agentWallet(prov);
  const dep = loadDeployments();
  if (!dep.router || !dep.policy) throw new Error('Phase 1 deployments missing');
  console.log('Agent:', wallet.address, 'ETH:', ethers.formatEther(await prov.getBalance(wallet.address)));

  const act = new ethers.Contract(ACTIVATION, ACT_ABI, prov);
  if (!(await act.isActivated(ASSET_FEATURE))) throw new Error('ASSET feature not activated');

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, wallet);
  const router = new ethers.Contract(dep.router.address, ROUTER_ABI, wallet);
  const policy = new ethers.Contract(dep.policy.address, POLICY_ABI, wallet);
  const ib20 = new ethers.Interface(IB20_ABI);
  const ib20Asset = new ethers.Interface(IB20_ASSET_ABI);

  const out = {
    stocks: { ...(dep.stocks || {}) },
    prices: { ...(dep.prices || {}) },
    routerInventory: { ...(dep.routerInventory || {}) },
    phase2: { ...(dep.phase2 || {}), txs: { ...((dep.phase2 || {}).txs || {}) } },
  };

  for (const t of TOKENS) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(t.saltSeed));
    const predicted = await factory.getB20Address(0, wallet.address, salt);
    const already = await factory.isB20Initialized(predicted);
    console.log(`\n${t.symbol}: predicted ${predicted} initialized=${already}`);
    let createTx = (out.stocks[t.key] || {}).createTx || null;
    if (!already) {
      const params = encodeAssetParams(t.name, t.symbol, wallet.address, 6);
      const initCalls = [
        ib20.encodeFunctionData('updateSupplyCap', [MAX_UINT128]),
        ib20.encodeFunctionData('grantRole', [MINT_ROLE, wallet.address]),
        ib20Asset.encodeFunctionData('batchMint', [[wallet.address], [t.initialMint]]),
      ];
      const tx = await factory.createB20(0, salt, params, initCalls);
      createTx = tx.hash;
      console.log('createB20 tx:', tx.hash, `${EXPLORER}/tx/${tx.hash}`);
      const rcpt = await tx.wait();
      console.log('status:', rcpt.status, 'block:', rcpt.blockNumber);
      out.phase2.txs[`create_${t.key}`] = tx.hash;
    }
    const token = new ethers.Contract(predicted, [...ERC20_ABI, ...ERC8056_ABI], wallet);
    const [nm, sym, dec, supply, mult, balUI] = await Promise.all([
      token.name(), token.symbol(), token.decimals(), token.totalSupply(), token.uiMultiplier(), token.balanceOfUI(wallet.address),
    ]);
    console.log(`verified: name="${nm}" symbol=${sym} decimals=${dec} totalSupply=${supply} uiMultiplier=${mult} agentBalanceOfUI=${balUI}`);
    out.stocks[t.key] = {
      address: predicted, symbol: sym, name: nm, decimals: Number(dec),
      standard: 'B20 Asset (factory precompile)', createTx, initialMint: t.initialMint.toString(),
    };

    // Router reference price from live mainnet NAV
    const nav = await fetchNav(t.mainnetSymbol);
    const price = BigInt(Math.round(nav.nav_price * 1e6));
    const curPrice = await router.priceUsdcPerShare(predicted);
    if (curPrice !== price) {
      const tx = await router.setPrice(predicted, price);
      await tx.wait();
      out.phase2.txs[`setPrice_${t.key}`] = tx.hash;
      console.log(`price set: $${nav.nav_price} (NAV ${nav.nav_price_updated_at}) tx ${tx.hash}`);
    } else {
      console.log(`price already $${nav.nav_price}`);
    }
    out.prices[t.key] = {
      mainnetSymbol: t.mainnetSymbol, navPriceUsd: nav.nav_price, navUpdatedAt: nav.nav_price_updated_at,
      routerPriceAtomic: price.toString(), setPriceTx: out.phase2.txs[`setPrice_${t.key}`] || (out.prices[t.key] || {}).setPriceTx || null,
    };

    // Router inventory top-up to 10,000 shares
    const routerBal = await token.balanceOf(dep.router.address);
    if (routerBal < ROUTER_INVENTORY) {
      const top = ROUTER_INVENTORY - routerBal;
      const tx = await token.transfer(dep.router.address, top);
      await tx.wait();
      out.phase2.txs[`inventory_${t.key}`] = tx.hash;
      console.log(`router inventory topped up +${top} (tx ${tx.hash})`);
    }
    out.routerInventory[t.key] = {
      amount: ROUTER_INVENTORY.toString(),
      tx: out.phase2.txs[`inventory_${t.key}`] || (out.routerInventory[t.key] || {}).tx || null,
      routerBalance: (await token.balanceOf(dep.router.address)).toString(),
    };

    // Policy allowlist
    if (!(await policy.allowlisted(predicted))) {
      const tx = await policy.setAllowlisted(predicted, true);
      await tx.wait();
      out.phase2.txs[`allowlist_${t.key}`] = tx.hash;
      console.log(`policy allowlisted (tx ${tx.hash})`);
    } else {
      console.log('policy already allowlisted');
    }
  }

  out.phase2.completedAt = new Date().toISOString();
  saveDeployments(out);
  console.log('\nSaved to deployments.sepolia.json');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
