# Architecture — Analyst-for-Hire

An autonomous research agent sells per-call reports on Coinbase tokenized
stocks over **x402**, and sweeps its net revenue into a basket of tokenized
stocks under an owner-signed onchain policy. Demo execution is on **Base
Sepolia**; all research data is read from **Base mainnet**.

## Components

```
 client agent ──GET /research/:ticker──► x402 server ──► research engine
 (buyer, no ETH)      │ 402 + accepts[]      │              (mainnet API +
                      │ X-PAYMENT header     │               onchain CA sync)
                      │                      ├─► settles EIP-3009 payment
                      │                      │   (self-facilitated) ──► tUSDC ──► TreasuryPolicy
                      │                      └─► POST /treasury/sweep ──► TreasuryPolicy.sweep()
                      │                                                        │ (cap + allowlist)
                      │                                                        ▼
                      │                                                  SimpleRouter ──► B20 stocks
 dashboard (read-only) ◄── chain events (Transfers, Sweeps, Buys) + balanceOfUI, Base Sepolia
```

| Folder | Role |
|---|---|
| `contracts/` | Base Sepolia contracts: real **B20 Asset** demo shares via the factory precompile (ERC-8056 multiplier semantics), `MockUSDC` (ERC-20 + EIP-3009), `TreasuryPolicy` (revenue vault + guarded sweep), `SimpleRouter` (inventory sales at owner-set reference prices). Addresses + txs: `contracts/deployments.sepolia.json`. |
| `server/` | x402 paywall server (`server.js`), research engine (`research.js`), corporate-action sync (`sync-corporate-actions.js` + `merge-corporate-actions.js`). |
| `client-agent/` | Demo buyer (`buy.js`) and the traction loop (`traction-loop.js`) that purchases reports across all tickers and triggers sweeps; every run is indexed in `traction-log.jsonl` (the chain is the durable record). |
| `dashboard/` | Read-only public dashboard; reconstructs revenue, sweeps and positions purely from chain events + the mainnet API. |

## The x402 flow (self-facilitated, and why)

1. Unpaid `GET /research/:ticker` → **HTTP 402** with an `accepts[]` entry
   (scheme `exact`, network `base-sepolia`, 0.25 tUSDC, `payTo` =
   TreasuryPolicy).
2. The buyer signs an EIP-3009 `transferWithAuthorization` and retries with
   the base64 `X-PAYMENT` header. The buyer needs **no ETH** — settlement
   is paid by the server.
3. The server performs exactly a facilitator's checks itself — signature
   recovery against the EIP-712 domain, payTo, amount, validity window,
   unused nonce, payer balance — then submits `transferWithAuthorization`
   from the agent wallet. Self-facilitation is necessary because the
   payment asset is a demo token no public facilitator settles; the
   verification standard is unchanged.
4. On settlement the report is returned with an `X-PAYMENT-RESPONSE`
   receipt header carrying the settlement tx hash.

## Research engine

Reports are assembled from the public Coinbase Tokenized Stocks API
(read-only, no key): NAV reference price with an explicit staleness flag
(feeds hold their last value outside market hours, and the report says so
when stale), UI multiplier + drift in bps, normalized supply, implied
reference value — plus the token's **latest corporate action**, resolved
from the B20 `Announcement` events emitted by the mainnet token contracts
themselves (scanned onchain, decoded, and resolved through the API's
corporate-actions endpoint by `sync-corporate-actions.js`). A ticker is
only served if the API returns real data for it; nothing is fabricated,
and an unresolved corporate action is reported as such, never invented.

## Treasury policy

Revenue accumulates in `TreasuryPolicy`. A sweep converts everything above
the 0.05 tUSDC operating reserve into the basket — NVDA 30% / TSLA 20% /
AAPL 20% / MSFT 15% / META 15% — through `SimpleRouter`, subject to the
policy's onchain per-sweep cap and asset allowlist. Positions are held as
B20 testnet shares and read back in UI units (`balanceOfUI`).

## Read-path resilience (Phase 3)

Public Sepolia RPCs rate-limit under burst load (in Phase 2 a rate-limited
read made a landed sweep look like an HTTP 500). All chain reads now go
through an ethers `FallbackProvider` over several public endpoints
(quorum 1) defined in `contracts/scripts/lib.js`, and critical reads are
wrapped in exponential-backoff retries (`withRetry`). The dashboard adds
per-chunk log-scan retries and serves its last good state (flagged
`stale`) if every endpoint fails.

## Compliance framing

Reports are **onchain data summaries, not investment advice** — no
recommendations, no return claims, NAV always labelled a reference value.
The agent manages only its own demo treasury; it holds no user funds and
executes no trades for users. The referenced tokenized stocks are non-U.S.
(Reg S) instruments; the demo instruments are testnet tokens with no
monetary value and confer no rights in any real shares. The project is an
independent build and implies no endorsement by Base, Coinbase, or any
issuer.
