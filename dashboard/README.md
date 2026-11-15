# dashboard

Public, read-only dashboard for Analyst-for-Hire. Run with
`node dashboard/server.js` (port `4030`, override with `PORT`).

**Live instance:** https://specials-dividend-simply-bowling.trycloudflare.com
(VPS Tencent, systemd `stocks-dashboard.service` + `stocks-dashboard-tunnel.service` — a cloudflared quick tunnel, so the URL changes if the tunnel restarts; re-read it from `journalctl -u stocks-dashboard-tunnel.service`.)

## What it shows

Everything is reconstructed from Base Sepolia chain state — there is no
database and no server-side bookkeeping to trust:

- **Revenue** — every tUSDC `Transfer` into the TreasuryPolicy is a settled
  report payment (the only inbound flow by construction).
- **Sweeps** — TreasuryPolicy `Sweep` events, with the per-asset allocation
  decoded from the SimpleRouter `Buy` events in the same receipts.
- **Positions** — `balanceOfUI` per B20 testnet stock, valued against live
  mainnet NAV reference prices from the Coinbase Tokenized Stocks API.
- Every row links to https://sepolia.basescan.org.

## Resilience (Phase 3)

Reads go through a multi-endpoint `FallbackProvider`
(`contracts/scripts/lib.js`) — this dashboard promotes the publicnode
Sepolia endpoint to primary (`DASHBOARD_RPC` overrides), with
sepolia.base.org and drpc as automatic fallbacks. Log scans retry per
chunk with backoff, state builds retry as a whole, and if every endpoint
fails the last good state is served with a `stale` flag (shown on the page)
instead of an error.

## Framing

The page carries the project disclaimer in its footer: testnet instruments
have no monetary value, reports are onchain data summaries — not investment
advice — NAV figures are reference values, and the agent manages only its
own demo treasury and executes no trades for users.
