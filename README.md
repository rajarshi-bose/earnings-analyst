# Earnings Report Qualitative Analyst

Pick an S&P 500 company and one of its quarterly earnings releases. The tool reads the release from SEC EDGAR, scores the tone of every word, and sets it next to how the stock moved in the two quarters before.

Live at https://jarsh.us/earnings-analyst/ and launched from its project page on jarsh.us.

## How it is built

- `index.html` is the whole app: styles, the tone word list, the chart, the word cloud and the jarsh.us return button.
- `worker/` is a small Cloudflare Worker. A web page cannot fetch SEC EDGAR or price feeds directly (they block cross-site requests), so the worker fetches them and hands the page clean JSON. It caches every answer at the edge.

| Route | Returns |
| --- | --- |
| `/companies` | Current S&P 500 companies with their SEC numbers |
| `/filings?ticker=AAPL` | Earnings releases (Form 8-K, item 2.02) with the quarter each one covers |
| `/report?cik=…&acc=…` | The press release itself (usually exhibit 99.1) |
| `/prices?symbol=AAPL&from=…&to=…` | Daily closes, adjusted for splits and dividends |

## Setup

1. Create the repository `rajarshi-bose/earnings-analyst`, push this folder to `main`, and turn on GitHub Pages from `main`. It appears at jarsh.us/earnings-analyst.
2. Deploy the worker (free Cloudflare plan is enough):
   - In `worker/wrangler.toml`, set `CONTACT_EMAIL` to an address you check. The SEC asks automated clients to name a contact.
   - From the `worker` folder run `npx wrangler login`, then `npx wrangler deploy`.
   - Wrangler prints the worker address, something like `https://earnings-analyst-api.<your-subdomain>.workers.dev`.
3. In `index.html`, set the address near the top of the script (`const API`) to that worker address, then push.
4. Open jarsh.us/earnings-analyst and try a company.

## Testing locally

Serve the folder (for example `python3 -m http.server`) and open `http://localhost:8000/?api=<worker address>`. The `api` override only works on localhost.

## Notes

- The worker only answers pages on jarsh.us, rajarshi-bose.github.io and localhost.
- Prices come from Yahoo Finance's chart data, with Stooq as a fallback. Both are unofficial and free; if one changes format, the other keeps the tool running.
- The S&P 500 list is read from Wikipedia's constituents table and refreshed daily.
