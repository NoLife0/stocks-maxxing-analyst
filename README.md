# stocks-maxxing-analyst *(working title — provisional)*

**Analyst-for-Hire** — an autonomous equity-research agent that sells per-call research on Coinbase tokenized stocks, paid in USDC via **x402**, and automatically sweeps its net revenue into a basket of tokenized stocks under an owner-signed onchain policy.

Built in public for the **Base — Stocks Maxxing Season**, track **Agentic Stock Finance**. Submission deadline: **5 December 2026**.

> Status: **Phase 3 complete — feature freeze** (15 Nov 2026). The full loop — 402 → EIP-3009 payment → research report from live mainnet data → treasury sweep into B20 stock positions — runs end-to-end on Base Sepolia with real testnet transactions: **38 reports sold, 9.50 tUSDC revenue, 9.45 tUSDC swept across 8 sweeps** (all verifiable onchain). Remaining work is Phase 4 only: the demo video and the submission.

**Live dashboard:** https://specials-dividend-simply-bowling.trycloudflare.com — every figure on it is reconstructed from Base Sepolia chain events; there is no database.

## How it works

1. A client (human or another agent) requests research on a tokenized stock (`NVDA`, `TSLA`, `AAPL`, `MSFT`, `META` — a ticker is served only if the Tokenized Stocks API returns real data for it).
2. The server answers **HTTP 402** with an x402 payment scheme (exact, USDC).
3. The client pays by signing an EIP-3009 authorization (no ETH, no gas for the buyer) and retries with an `X-PAYMENT` header; the server verifies and settles it onchain and returns a research report built from real mainnet data (Tokenized Stocks API + Chainlink NAV reference + corporate actions resolved from the token contracts' own onchain `Announcement` events), with an `X-PAYMENT-RESPONSE` receipt.
4. Revenue accumulates in the TreasuryPolicy contract; a policy engine sweeps net revenue above a 0.05 tUSDC operating reserve into the stock basket (NVDA 30% / TSLA 20% / AAPL 20% / MSFT 15% / META 15%), under an onchain per-sweep cap and asset allowlist.

Demo execution runs on **Base Sepolia testnet** (expressly allowed by the quest rules and not judged less favorably); research data is read from Base mainnet. Full design notes: [docs/architecture.md](docs/architecture.md).

## Architecture

| Folder | Contents |
|---|---|
| `contracts/` | Base Sepolia contracts: **real B20 Asset** demo shares (factory precompile, ERC-8056 multiplier), mock USDC with EIP-3009, policy/treasury contract, simple swap router |
| `server/` | x402 paywall server + research engine (Tokenized Stocks API → report generator) + corporate-action sync from onchain `Announcement` events |
| `client-agent/` | Demo buyer agent that purchases research via x402 (also the traction loop driver) |
| `dashboard/` | Public read-only dashboard: revenue, treasury positions in UI amounts (`balanceOfUI`), full sales & sweep log — all rebuilt from chain events |
| `docs/` | Architecture notes and compliance framing |

## Contracts (Base Sepolia, chainId 84532)

| Contract | Address |
|---|---|
| TreasuryPolicy (x402 `payTo`) | `0x8718b7ff1913545353a9D5aaAc0BB85211E69743` |
| tUSDC (MockUSDC, ERC-20 + EIP-3009) | `0x97F2fED7B906D5D7C05C5BA4b0D8B4B6B6D4adF4` |
| SimpleRouter | `0x23b5aEdE94cAde47Fb7057d2E888d5D47b105FaF` |
| NVDAxT (B20 Asset) | `0xB2000000000000000000006240055811d9B6D91e` |
| TSLAxT (B20 Asset) | `0xB200000000000000000000351A6Ed0992c14ce6C` |
| AAPLxT (B20 Asset) | `0xb2000000000000000000000Fca5EC87196265070` |
| MSFTxT (B20 Asset) | `0xB200000000000000000000C94Bf96D3Bc0fb5DC4` |
| METAxT (B20 Asset) | `0xB200000000000000000000fCaD4Ff6D0EFd21eDe` |
| Agent wallet | `0x9a5F56260566Aa697c9Ac45B50fb6B9940519242` |

Full deployment record (create/deploy txs, prices): `contracts/deployments.sepolia.json`. Explorer: https://sepolia.basescan.org.

## Run it

Prerequisites: Node 20+, `npm install` in the repo root. The server and
scripts read the agent keypair from `../../agent-wallet.json` relative to
the repo (outside the repo, never committed).

```bash
# x402 research server (port 4021)
npm run server
curl http://localhost:4021/health
curl http://localhost:4021/research/NVDA          # -> HTTP 402 + payment terms

# buy a report as the demo client agent (buyer holds no ETH)
node client-agent/buy.js --init                   # once: create the buyer wallet
npm run fund-client                               # once: mint demo tUSDC to the buyer
node client-agent/buy.js NVDA                     # 402 -> sign -> settle -> report

# traction loop: N purchases across all tickers + periodic sweeps
node client-agent/traction-loop.js --count 10 --sweep-every 5

# dashboard (port 4030) — read-only, no keys needed
node dashboard/server.js

# corporate actions: scan / refresh the local sync file, then merge
# parallel per-token outputs (see server/sync-corporate-actions.js header)
node server/sync-corporate-actions.js
node server/merge-corporate-actions.js
```

Chain reads go through a multi-endpoint fallback provider with
retry/backoff (`contracts/scripts/lib.js`) — public testnet RPCs
rate-limit, and a failed read must never masquerade as a failed
transaction.

## Compliance framing

Reports are **onchain data summaries, not investment advice**: no
recommendations, no return claims, and NAV is always labelled a reference
value, not an execution price. The agent manages only its own demo
treasury — it holds no user funds and executes no trades for users. The
referenced tokenized stocks are non-U.S. (Reg S) instruments; the *xT
demo shares are testnet instruments with no monetary value and confer no
rights (such as voting rights) in any real shares. This is an independent
build; nothing here implies endorsement by Base, Coinbase, or any issuer.

## License

MIT — see [LICENSE](LICENSE).
