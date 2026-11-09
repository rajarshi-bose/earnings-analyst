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

Already done: the repository serves the app at jarsh.us/earnings-analyst, and the worker runs at https://earnings-analyst-api.rajarshi-bose-us.workers.dev with `CONTACT_EMAIL` set in the Cloudflare dashboard.

To redeploy the worker after changing `worker/worker.js`, either paste it into the worker's code editor in the Cloudflare dashboard and deploy, or run `npx wrangler deploy` from the `worker` folder.

Headlines come from Finnhub's company news when the worker has a `FINNHUB_KEY` secret (free key from finnhub.io, added in the Cloudflare dashboard under Settings, Variables and secrets, type Secret). Without it, the worker tries Google News and then GDELT, which often refuse requests from Cloudflare's servers. The free Finnhub plan covers roughly the last year of news.

## Testing locally

Serve the folder (for example `python3 -m http.server`) and open `http://localhost:8000/?api=<worker address>`. The `api` override only works on localhost.

## Notes

- The worker only answers pages on jarsh.us, rajarshi-bose.github.io and localhost.
- Prices come from Yahoo Finance's chart data, with Stooq as a fallback. Both are unofficial and free; if one changes format, the other keeps the tool running.
- The S&P 500 list is read from Wikipedia's constituents table and refreshed daily.
