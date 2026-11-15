// Create the two demo stock tokens as REAL B20 Asset tokens via the Base
// factory precompile on Base Sepolia (0xB20f...), per PHASE0.md §1 upgrade:
// genuine ERC-8056 multiplier semantics from the protocol, not a Solidity mock.
//
// Tokens are TESTNET DEMO instruments. Names state that plainly; no affiliation
// with Coinbase, NVIDIA, Tesla, or any issuer is claimed or implied.
const { ethers } = require('ethers');
const { provider, agentWallet, saveDeployments, loadDeployments, EXPLORER } = require('./lib');

const FACTORY = '0xB20f000000000000000000000000000000000000';
const ACTIVATION = '0x8453000000000000000000000000000000000001';
const ASSET_FEATURE = ethers.keccak256(ethers.toUtf8Bytes('base.b20_asset'));
const MINT_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MINT_ROLE'));
const MAX_UINT128 = (1n << 128n) - 1n;

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
];
const ERC8056_ABI = [
  'function uiMultiplier() view returns (uint256)',
  'function balanceOfUI(address) view returns (uint256)',
];

const TOKENS = [
  {
    key: 'nvda',
    name: 'Testnet NVDA Share - Demo Only',
    symbol: 'NVDAxT',
    saltSeed: 'stocks-maxxing-analyst/NVDAxT',
    initialMint: 100000n * 10n ** 6n, // 100,000 demo shares to the agent wallet
  },
  {
    key: 'tsla',
    name: 'Testnet TSLA Share - Demo Only',
    symbol: 'TSLAxT',
    saltSeed: 'stocks-maxxing-analyst/TSLAxT',
    initialMint: 100000n * 10n ** 6n,
  },
];

function encodeAssetParams(name, symbol, admin, decimals) {
  return new ethers.AbiCoder().encode(
    ['tuple(uint8 version, string name, string symbol, address initialAdmin, uint8 decimals)'],
    [[1, name, symbol, admin, decimals]]
  );
}

async function main() {
  const prov = provider();
  const wallet = agentWallet(prov);
  console.log('Agent:', wallet.address);
  const bal = await prov.getBalance(wallet.address);
  console.log('ETH balance:', ethers.formatEther(bal));

  const act = new ethers.Contract(ACTIVATION, ACT_ABI, prov);
  const activated = await act.isActivated(ASSET_FEATURE);
  console.log('B20 ASSET feature activated on Sepolia:', activated);
  if (!activated) throw new Error('ASSET feature not activated — fallback required');

  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, wallet);
  const ib20 = new ethers.Interface(IB20_ABI);
  const ib20Asset = new ethers.Interface(IB20_ASSET_ABI);
  const existing = loadDeployments();
  const out = { stocks: { ...(existing.stocks || {}) } };

  for (const t of TOKENS) {
    const salt = ethers.keccak256(ethers.toUtf8Bytes(t.saltSeed));
    const predicted = await factory.getB20Address(0, wallet.address, salt);
    const already = await factory.isB20Initialized(predicted);
    console.log(`\n${t.symbol}: predicted ${predicted} initialized=${already}`);
    if (already) {
      out.stocks[t.key] = { ...(out.stocks[t.key] || {}), address: predicted, symbol: t.symbol, name: t.name, standard: 'B20 Asset (factory precompile)' };
      continue;
    }
    const params = encodeAssetParams(t.name, t.symbol, wallet.address, 6);
    const initCalls = [
      ib20.encodeFunctionData('updateSupplyCap', [MAX_UINT128]),
      ib20.encodeFunctionData('grantRole', [MINT_ROLE, wallet.address]),
      ib20Asset.encodeFunctionData('batchMint', [[wallet.address], [t.initialMint]]),
    ];
    const tx = await factory.createB20(0, salt, params, initCalls);
    console.log('createB20 tx:', tx.hash, `${EXPLORER}/tx/${tx.hash}`);
    const rcpt = await tx.wait();
    console.log('status:', rcpt.status, 'block:', rcpt.blockNumber);
    const token = new ethers.Contract(predicted, [...ERC20_ABI, ...ERC8056_ABI], prov);
    const [nm, sym, dec, supply, agentBal, mult, balUI] = await Promise.all([
      token.name(), token.symbol(), token.decimals(), token.totalSupply(),
      token.balanceOf(wallet.address), token.uiMultiplier(), token.balanceOfUI(wallet.address),
    ]);
    console.log(`verified: name="${nm}" symbol=${sym} decimals=${dec} totalSupply=${supply} agentBalance=${agentBal} uiMultiplier=${mult} balanceOfUI=${balUI}`);
    out.stocks[t.key] = {
      address: predicted,
      symbol: sym,
      name: nm,
      decimals: Number(dec),
      standard: 'B20 Asset (factory precompile)',
      createTx: tx.hash,
      initialMint: t.initialMint.toString(),
    };
  }
  saveDeployments(out);
  console.log('\nSaved to deployments.sepolia.json');
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
