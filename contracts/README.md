# contracts

Base Sepolia (chainId 84532) contracts and deployment scripts. All addresses
and transaction hashes live in `deployments.sepolia.json`.

## Tokens

| Instrument | Standard | How |
|---|---|---|
| `NVDAxT` / `TSLAxT` / `AAPLxT` / `MSFTxT` / `METAxT` demo shares | **Real B20 Asset** (factory precompile) | Created with one `createB20` call each to the B20 factory (`0xB20f…`) — genuine ERC-8056 multiplier semantics from the Base protocol, not a Solidity imitation. Testnet demo instruments named after the mainnet tickers they mirror for the demo; no affiliation with Coinbase or the referenced companies is claimed, and they confer no rights in any real shares. |
| `tUSDC` payment token | ERC-20 + EIP-3009 (`MockUSDC.sol`) | 6 decimals. Implements `transferWithAuthorization` (the x402 "exact" settlement primitive), an owner mint, and a rate-limited public `faucet()` for demo buyers. |

`MockStock8056.sol` is the documented contingency: a hand-written ERC-20 +
ERC-8056 multiplier token, kept in case factory creation had failed. It was
**not** needed — the B20 ASSET feature is live on Base Sepolia.

## Contracts

- `TreasuryPolicy.sol` — holds x402 revenue (the server's `payTo`). Owner-only
  `sweep()` converts USDC into allowlisted stock positions through the router,
  under an onchain per-sweep cap.
- `SimpleRouter.sol` — sells stock from its own inventory at an owner-set
  reference price. The price is set from the live mainnet Tokenized Stocks API
  NAV at setup time (recorded in `deployments.sepolia.json`); the router does
  **not** claim to read a live oracle.

## Scripts

```bash
npm run compile      # solc -> contracts/artifacts/
npm run create-b20   # create the first two B20 Asset demo shares (NVDAxT, TSLAxT) via the factory
node contracts/scripts/create-b20-phase2.js   # create AAPLxT, MSFTxT, METAxT the same way (idempotent)
npm run deploy       # deploy MockUSDC + TreasuryPolicy + SimpleRouter, wire policy, set NAV reference prices, stock the router
npm run fund-client  # mint demo tUSDC to the buyer agent
```

The agent keypair is read from `../../agent-wallet.json` (outside the repo,
never committed).
