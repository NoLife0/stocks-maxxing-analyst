// Deploy MockUSDC + TreasuryPolicy + SimpleRouter to Base Sepolia and wire
// the demo: router reference prices are set from the LIVE mainnet Tokenized
// Stocks API NAV at deploy time (recorded in deployments.sepolia.json), the
// router is stocked with B20 share inventory, and the policy gets its cap +
// allowlist.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { provider, agentWallet, saveDeployments, loadDeployments, EXPLORER } = require('./lib');

const API = 'https://api.coinbase.com/v1/tokenized-stocks?page_size=500';
const PER_SWEEP_CAP = 5000000n; // 5 tUSDC per sweep (demo guardrail)
const ROUTER_INVENTORY = 10000n * 10n ** 6n; // 10,000 shares per stock
const AGENT_FLOAT = 50n * 10n ** 6n; // 50 tUSDC operating float for the agent

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', `${name}.json`), 'utf8'));
}

async function fetchNav(symbol) {
  const res = await fetch(API);
  if (!res.ok) throw new Error(`Tokenized Stocks API HTTP ${res.status}`);
  const data = await res.json();
  const tok = (data.tokens || []).find((t) => t.symbol === symbol);
  if (!tok || !tok.nav_price) throw new Error(`NAV missing for ${symbol}`);
  return tok;
}

async function main() {
  const prov = provider();
  const wallet = agentWallet(prov);
  const dep = loadDeployments();
  if (!dep.stocks || !dep.stocks.nvda || !dep.stocks.tsla) {
    throw new Error('B20 stocks missing — run create-b20.js first');
  }
  console.log('Agent:', wallet.address, 'ETH:', ethers.formatEther(await prov.getBalance(wallet.address)));

  // 1. Deploy contracts
  const usdcArt = artifact('MockUSDC');
  const usdc = await new ethers.ContractFactory(usdcArt.abi, usdcArt.bytecode, wallet).deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log('MockUSDC:', usdcAddr, `${EXPLORER}/address/${usdcAddr}`);

  const polArt = artifact('TreasuryPolicy');
  const policy = await new ethers.ContractFactory(polArt.abi, polArt.bytecode, wallet).deploy(usdcAddr);
  await policy.waitForDeployment();
  const policyAddr = await policy.getAddress();
  console.log('TreasuryPolicy:', policyAddr);

  const routerArt = artifact('SimpleRouter');
  const router = await new ethers.ContractFactory(routerArt.abi, routerArt.bytecode, wallet).deploy(usdcAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log('SimpleRouter:', routerAddr);

  const txs = {
    usdcDeploy: usdc.deploymentTransaction().hash,
    policyDeploy: policy.deploymentTransaction().hash,
    routerDeploy: router.deploymentTransaction().hash,
  };

  // 2. Reference prices from live mainnet NAV
  const prices = {};
  for (const [key, mainnetSymbol] of [['nvda', 'NVDAc'], ['tsla', 'TSLAc']]) {
    const tok = await fetchNav(mainnetSymbol);
    const price = BigInt(Math.round(tok.nav_price * 1e6));
    const tx = await router.setPrice(dep.stocks[key].address, price);
    await tx.wait();
    prices[key] = {
      mainnetSymbol,
      navPriceUsd: tok.nav_price,
      navUpdatedAt: tok.nav_price_updated_at,
      routerPriceAtomic: price.toString(),
      setPriceTx: tx.hash,
    };
    console.log(`price ${dep.stocks[key].symbol}: $${tok.nav_price} (NAV ${tok.nav_price_updated_at}) tx ${tx.hash}`);
  }

  // 3. Policy wiring
  let tx = await policy.setRouter(routerAddr); await tx.wait(); txs.policySetRouter = tx.hash;
  tx = await policy.setPerSweepCap(PER_SWEEP_CAP); await tx.wait(); txs.policySetCap = tx.hash;
  for (const key of ['nvda', 'tsla']) {
    tx = await policy.setAllowlisted(dep.stocks[key].address, true); await tx.wait();
  }
  console.log('policy wired: router + cap 5 tUSDC + allowlist NVDAxT/TSLAxT');

  // 4. Router inventory: agent -> router stock transfers (B20 ERC-20 transfers)
  const erc20 = ['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)'];
  const inventory = {};
  for (const key of ['nvda', 'tsla']) {
    const stock = new ethers.Contract(dep.stocks[key].address, erc20, wallet);
    const t = await stock.transfer(routerAddr, ROUTER_INVENTORY);
    await t.wait();
    inventory[key] = { amount: ROUTER_INVENTORY.toString(), tx: t.hash, routerBalance: (await stock.balanceOf(routerAddr)).toString() };
    console.log(`router inventory ${dep.stocks[key].symbol}: 10000 shares, tx ${t.hash}`);
  }

  // 5. Agent operating float of tUSDC
  tx = await usdc.mint(wallet.address, AGENT_FLOAT); await tx.wait();
  txs.mintAgentFloat = tx.hash;
  console.log('minted 50 tUSDC operating float to agent');

  saveDeployments({
    network: 'base-sepolia',
    chainId: 84532,
    agent: wallet.address,
    usdc: { address: usdcAddr, symbol: 'tUSDC', name: 'Testnet USD Coin', decimals: 6, standard: 'ERC-20 + EIP-3009 (MockUSDC.sol)' },
    policy: { address: policyAddr, perSweepCap: PER_SWEEP_CAP.toString() },
    router: { address: routerAddr },
    prices,
    routerInventory: inventory,
    deployTxs: txs,
  });
  console.log('\nSaved deployments.sepolia.json');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
