// Shared helpers for Stocks Maxxing Analyst scripts (Base Sepolia only).
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const MAINNET_RPC = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org';
const CHAIN_ID = 84532;
const EXPLORER = 'https://sepolia.basescan.org';

const WALLET_PATH =
  process.env.AGENT_WALLET_PATH ||
  path.join(__dirname, '..', '..', '..', 'agent-wallet.json');

function provider() {
  return new ethers.JsonRpcProvider(SEPOLIA_RPC);
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
  MAINNET_RPC,
  CHAIN_ID,
  EXPLORER,
  provider,
  agentWallet,
  loadDeployments,
  saveDeployments,
};
