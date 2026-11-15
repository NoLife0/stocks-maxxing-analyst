// Fund the demo buyer agent with tUSDC (agent-signed owner mint).
// The buyer needs no ETH: it pays by signing EIP-3009 authorizations.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { provider, agentWallet, loadDeployments } = require('./lib');

async function main() {
  const clientPath = path.join(__dirname, '..', '..', 'client-agent', 'client-wallet.json');
  if (!fs.existsSync(clientPath)) throw new Error('client wallet missing — run: node client-agent/buy.js --init');
  const client = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
  const dep = loadDeployments();
  const prov = provider();
  const wallet = agentWallet(prov);
  const usdc = new ethers.Contract(
    dep.usdc.address,
    ['function mint(address to, uint256 amount)', 'function balanceOf(address) view returns (uint256)'],
    wallet
  );
  const amount = 10n * 10n ** 6n; // 10 tUSDC demo funds
  const tx = await usdc.mint(client.address, amount);
  await tx.wait();
  console.log(`minted 10 tUSDC to buyer ${client.address}, tx ${tx.hash}`);
  console.log('buyer tUSDC balance:', (await usdc.balanceOf(client.address)).toString());
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
