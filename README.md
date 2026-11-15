# stocks-maxxing-analyst *(working title — provisional)*

**Analyst-for-Hire** — an autonomous equity-research agent that sells per-call research on Coinbase tokenized stocks, paid in USDC via **x402**, and automatically sweeps its net treasury profit into a basket of tokenized stocks.

Built in public for the **Base — Stocks Maxxing Season**, track **Agentic Stock Finance**. Submission deadline: **5 December 2026**.

> Status: **Phase 1 — payment & treasury rails LIVE on Base Sepolia** (15 Nov 2026). The full loop — 402 → EIP-3009 payment → research report → treasury sweep into B20 stock positions — runs end-to-end with real testnet transactions. Contract addresses and tx hashes: `contracts/deployments.sepolia.json`.

## How it works

1. A client (human or another agent) requests research on a tokenized stock (e.g. NVDA).
2. The server answers **HTTP 402** with an x402 payment scheme (exact, USDC).
3. The client pays and retries with an `X-PAYMENT` header; the server settles and returns a research report built from real mainnet data (Tokenized Stocks API + Chainlink NAV feeds + corporate actions).
4. A policy engine tracks the agent's net earnings; on each sweep, profit is converted into tokenized-stock positions under an owner-signed policy (per-tx caps, asset allowlist).

Demo execution runs on **Base Sepolia testnet** (expressly allowed by the quest rules, not judged less favorably); research data is read from Base mainnet.

## Architecture

| Folder | Contents |
|---|---|
| `contracts/` | Base Sepolia contracts: **real B20 Asset** demo shares (factory precompile, ERC-8056 multiplier), mock USDC with EIP-3009, policy/treasury contract, simple swap router |
| `server/` | x402 paywall server + research engine (Tokenized Stocks API + Chainlink readers → report generator) |
| `client-agent/` | Demo buyer agent that purchases research via x402 (also the organic traction loop) |
| `dashboard/` | Web dashboard: revenue, treasury positions in UI amounts (`balanceOfUI`), transaction log |
| `docs/` | Architecture notes, compliance framing, demo storyboard |

## Compliance framing

Reports are **onchain data summaries, not investment advice**. The product is positioned for non-US users, consistent with the underlying tokenized stocks (Reg S). No claim is made to any rights (e.g. voting) that the underlying assets do not grant.

## License

MIT — see [LICENSE](LICENSE).
