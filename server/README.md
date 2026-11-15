# server

The Analyst-for-Hire x402 research server. Run with `npm run server`
(port `4021`, override with `PORT`).

## Endpoints

| Route | Description |
|---|---|
| `GET /health` | Liveness + payment parameters (payTo, asset, price). |
| `GET /research/:ticker` | The paid product (`NVDA`, `TSLA`). Without payment: **HTTP 402** with an x402 `accepts[]` (scheme `exact`, network `base-sepolia`, 0.25 tUSDC, `payTo` = TreasuryPolicy). With a valid `X-PAYMENT` header: settles and returns the report + `X-PAYMENT-RESPONSE` receipt. |
| `GET /treasury` | Policy state: tUSDC balance, total swept, stock positions (raw + `balanceOfUI`). |
| `POST /treasury/sweep` | Runs the policy engine: revenue above the 0.05 tUSDC operating reserve is swept into the basket (60% NVDAxT / 40% TSLAxT) via `TreasuryPolicy.sweep`. |

## Payment verification

Verification and settlement are done **in-house** (self-facilitation): the
server recovers the EIP-3009 signer with `ethers.verifyTypedData`, checks
payTo / amount / validity window / nonce-unused / balance, then submits
`transferWithAuthorization` from the agent wallet. A public x402 facilitator
cannot settle a custom demo token, and the checks performed here are exactly
the facilitator's checks.

## Research data

Reports are built by `research.js` from the **live Base mainnet** Coinbase
Tokenized Stocks API (public, read-only, no key): NAV reference price +
staleness, UI multiplier + drift in bps, normalized supply, implied reference
value. Every report carries the disclaimer that it is an onchain data
summary, **not investment advice**.
