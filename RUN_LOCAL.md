Running with Local Chromium
==========================

Quick guide to run the project using a local Chromium instance instead of the remote browserless endpoint.

Environment variables
- `USE_BROWSERLESS=true` — when set to `true` the code connects to browserless (`puppeteer-core.connect`) instead of launching local Chromium.
- `HEADLESS` — set to `false` to run with visible browser for debugging (default is headless). Example: `HEADLESS=false`.
- `USER_AGENT` — optional override for the User-Agent string sent by pages.
- `ACCEPT_LANGUAGE` — optional override for the `Accept-Language` header (default `en-US,en;q=0.9`).
- `CHROME_USER_DATA_DIR` — optional path for local Chromium profile data. Defaults to `.chrome-user-data` in the project root.
- `BROWSERLESS_API_KEY` — required only when `USE_BROWSERLESS=true`.

Run commands
------------

Run with local Chromium (headless):

```zsh
npm run generate
```

Run with visible browser (for debugging UI interactions):

```zsh
export HEADLESS=false
npm run generate
```

Optional overrides to test headers/UA:

```zsh
export USER_AGENT="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
export ACCEPT_LANGUAGE="en-US,en;q=0.9"
npm run generate
```

Run against browserless instead of local Chromium:

```zsh
export USE_BROWSERLESS=true
export BROWSERLESS_API_KEY="your_key_here"
npm run generate
```

Notes
-----
- Using local Chromium avoids IP-based blocking that can occur when running on cloud browser providers (browserless). If the site blocks by IP range, consider running the scraper from an IP the site accepts (self-host, dedicated IP, or residential proxy).
- Local Chromium is the default. Set `USE_BROWSERLESS=true` to opt into browserless.
- If you want to make local Chromium the default permanently, let me know and I can change `browser.js` to default to local launch.

Next steps
----------
- If the local run passes and you need production reliability, choose one of:
  - Self-host a headless Chromium service on a VM in a stable IP range.
  - Purchase a dedicated browserless plan with a static/dedicated IP.
  - Use a residential/rotating proxy for remote browserless calls.

Save artifacts from failures are still written to the `errors/` folder for diagnosis.
