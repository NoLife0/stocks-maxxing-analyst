// Compile the Solidity sources with solc-js into contracts/artifacts/.
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const CONTRACTS_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(CONTRACTS_DIR, 'artifacts');
const FILES = ['MockUSDC.sol', 'TreasuryPolicy.sol', 'SimpleRouter.sol', 'MockStock8056.sol'];

function main() {
  const sources = {};
  for (const f of FILES) {
    sources[f] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), 'utf8') };
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of FILES) {
    for (const [name, c] of Object.entries(output.contracts[f])) {
      fs.writeFileSync(
        path.join(OUT_DIR, `${name}.json`),
        JSON.stringify({ contractName: name, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2) + '\n'
      );
      console.log('compiled', name);
    }
  }
}

main();
