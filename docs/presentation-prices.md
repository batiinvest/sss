# Presentation Daily Closes

## Price contract

- `price_at`: the unadjusted daily close on `presented_at` (KRW).
- `price_adjusted_at`: the provider's current adjusted close for that same date, used only for return comparisons.
- `price_date`, `price_source`, `price_checked_at`: verified date, provider/version and retrieval timestamp.
- Domestic six-digit codes are automatic. Overseas symbols and industry-only topics are excluded until a market/currency-aware provider is added.
- No previous-session or current-price fallback: a missing exact-date quote remains pending and causes the sync job to report failure for retry.
- Completed presentations become eligible at 18:00 KST on the presentation date. Planned rows are never finalized by the price job.

The raw daily endpoint is `https://m.stock.naver.com/api/stock/{code}/price?pageSize=60&page={page}`. Adjusted closes come from `https://api.finance.naver.com/siseJson.naver` for the exact presentation dates. Both are unofficial public data endpoints and may change; failures must not silently become zero or current prices. Corporate-action adjusted returns are provider-based price returns, not total shareholder returns including cash flows.

## Operation

1. Apply `sql/20260922-presentation-prices.sql` before deploying the frontend or workflow. It backs up existing rows in the non-public, RLS-protected `sss_audit` schema.
2. The `Presentation daily closes` workflow runs at 18:20, 22:20 and 06:20 KST daily and supports manual dispatch. GitHub scheduling may be delayed. Existing repository secrets `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are used only on the runner.
3. The worker groups requests by stock code, paginates history, retries network failures three times, and applies each quote through a service-role-only RPC. Old presentations are refreshed too, so later corporate actions update the adjusted comparison basis.
4. On failure, the workflow fails visibly and the next scheduled run retries. Previously verified values are retained, never replaced with a failed lookup.
5. The RPC locks and rechecks row identity/date/completion state. Outdated responses are skipped; repeated equal prices update only the check timestamp. Price changes are recorded in `sss_audit.presentation_price_changes`.
6. A DB trigger clears price provenance when the stock, presentation date or completion state is reset. Authenticated browser clients cannot override automatic domestic prices.

The UI displays actual presentation-day prices while all presentation returns share `getPresentationReturnBase()`. The price tooltip identifies the date/provider and adjusted basis when it differs. Unknown automatic prices are excluded from returns rather than falling back to a selection-time quote.

## Verification

```powershell
npm test
node scripts/presentation-prices.cjs --input reports/presentation-price-before-20260922.json --output reports/presentation-price-quotes-20260922.json
```

The input/output files under `reports/` contain private operational snapshots and are excluded from Git. `--apply` requires service credentials in the environment and writes through the guarded RPC. Without `--apply`, no DB prices are written.

`sql/test-presentation-prices.sql` tests valid updates, idempotency, stale identity/date/timestamp rejection, date invalidation, planned-row exclusion and RPC privileges inside a rollback transaction. Run against an approved database only. Tests briefly lock one completed presentation row; lock and statement timeouts are bounded.
