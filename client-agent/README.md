# client-agent

Demo buyer agent that purchases research via x402.

```bash
node client-agent/buy.js --init   # create the buyer wallet (no ETH, ever)
npm run fund-client               # agent mints 10 demo tUSDC to the buyer
node client-agent/buy.js NVDA     # buy one report: 402 -> sign -> 200
```

The buyer wallet holds **no ETH by design**: it pays by signing an EIP-3009
`transferWithAuthorization`, and the server settles it onchain. This is the
agent-to-agent payment pattern the product is built around — the same buyer
loop, run periodically, is the organic traction engine in later phases.

The buyer key lives in `client-wallet.json` (mode 600, gitignored).
