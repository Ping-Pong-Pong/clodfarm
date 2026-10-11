# Connectors

Accounts the farm connects once, for every Claude on it. The **CONNECTORS** button on the farm (or S) opens them.

| Connector | What it gives the farm |
|---|---|
| **Slack** | People give the farm work from Slack; a sub-agent answers in the thread ([slack.md](slack.md)). |
| **Stripe** | Every Claude can use the farm's Stripe account: customers, products, prices, payment links, invoices, subscriptions, balances, and Stripe's docs. |
| **Blender** | Every Claude can drive a Blender that runs on another machine, through its MCP server: scenes, game assets, materials, animation, renders, import and export, Python. |
| **Google Ads** | Every Claude can see the farm's ad accounts, run reports (GAQL), keep live dashboards of them, and make changes when its person asks. |
| **X** | Every Claude can read the farm's X account, its mentions and X search, and post, reply and quote as it when its person asks. |

## Stripe

The farm manager connects it: **CONNECTORS → STRIPE**, paste a key, **CONNECT**. From the box's shell:
`clodfarm stripe connect` (the key on stdin, so it stays out of your shell history), `clodfarm stripe`,
`clodfarm stripe disconnect`.

- **Which key.** Best: a **restricted key** (Stripe → Developers → API keys → Create restricted key) with only
  what the Claudes need, for example write access to Products, Prices, Payment Links and Customers, read access to
  the rest. A secret key works too. Start with a **test-mode** key (`sk_test_…` / `rk_test_…`): nothing real
  happens. A live key (`…_live_…`) means real money; the panel says so.
- **How the Claudes use it.** The farm checks the key with Stripe, keeps it in `/workspace/.farm/connectors/stripe.json`
  (readable by the farm's user only; the UI shows only its last 4 characters), and gives every Claude Stripe's own
  MCP server (`https://mcp.stripe.com`, authorized with that key) as its `mcp__stripe__*` tools. Their farm guide
  says: build freely in test mode; in live mode, charge, refund, pay out, cancel or delete only when their person
  asks for that one thing.
- **Per Claude.** A person can turn Stripe off for their own Claude: its SETTINGS → tools → *Stripe (payments)*.
- **Disconnect** removes the key and every Claude's Stripe tools. Revoke the key in Stripe too if it may have leaked.

The Claudes share one container: a Claude with a shell could read the key file. Give the farm a restricted key with
only the permissions you're happy for any of its Claudes to use ([security.md](security.md)).

## Blender

The farm manager connects a Blender MCP server that runs elsewhere (a streamable-HTTP MCP endpoint, often ending in
`/mcp`): **CONNECTORS → BLENDER**, its URL and token, **CONNECT**. From the box's shell:
`clodfarm blender connect https://host/mcp` (its token on stdin, so it stays out of your
shell history; an empty line for a server without one), `clodfarm blender`, `clodfarm blender disconnect`.

- **How the Claudes use it.** The farm opens an MCP session with the server to check it answers, keeps the URL and
  token in `/workspace/.farm/connectors/blender.json` (readable by the farm's user only; only the token's last 4
  characters are shown, and only the manager sees where the server runs), and gives every Claude the server as its
  `mcp__blender__*` tools. Their farm guide says the Blender runs there, not on the farm's box, so paths in its
  tools are on that server.
- **Per Claude.** A person can turn Blender off for their own Claude: its SETTINGS → tools → *Blender (3D)*.
- **Your own server.** A `blender` MCP server you set up by hand in a Claude's config is left alone.
- **Disconnect** removes the URL, the token and every Claude's Blender tools.

The Claudes share one container: a Claude with a shell could read the token. Such a server usually runs Python in
Blender, so connect only a server whose token you're happy for any of the farm's Claudes to use.

## Google Ads

Google Ads has no single key: the API wants three things, and a fourth when you go through a manager account.

| Field | Where it comes from |
|---|---|
| **OAuth client ID + secret** | Google Cloud console → APIs & Services → Credentials → Create OAuth client ID (*Desktop app*), in a project with the **Google Ads API** enabled. The project's **access level** is what Google checks: a new one has *Test* (test accounts only); on the Google Ads API page, Access levels → Manage, apply for *Explorer* to reach real accounts (usually granted in minutes). |
| **Refresh token** | Sign in once, as a Google user who can see the ad accounts, with scope `https://www.googleapis.com/auth/adwords` (Google's `generate_user_credentials.py` example, or the OAuth Playground with your own client). |
| **Login customer ID** (optional) | The manager account's ID (123-456-7890), when the ad accounts are reached through it. |
| **Developer token** (optional) | Only if you have one from a manager account's API Center (Google's older access model). The farm sends it as the `developer-token` header when it's there. |

The farm manager connects it: **CONNECTORS → GOOGLE ADS**, paste the fields, **CONNECT**. The panel then lists the
ad accounts (and a developer token's last 4 characters, if there is one), never the secrets. Or from the box's shell:

```bash
clodfarm gads connect          # asks for each field (the secrets aren't echoed)
clodfarm gads connect < creds.json   # or: {"client_id": ..., "client_secret": ..., "refresh_token": ...,
                                     #      "login_customer_id": "1234567890"}   (+ "developer_token", optional)
clodfarm gads                  # status
clodfarm gads disconnect
```

On AWS, run them in the container (`docker exec -i clodfarm clodfarm gads connect < creds.json` over SSM). The farm
turns the refresh token into an access token, asks Google Ads which accounts it reaches (trying the newest API
version first), and lists them.

- **How the Claudes use it.** The credentials go in `/workspace/.farm/connectors/google-ads.json`, plus a
  `google-ads.yaml` for Google's own Python library (both readable by the farm's user only). Every Claude's farm guide
  teaches `clodfarm gads`:
  - `clodfarm gads accounts [--refresh]`: the ad accounts;
  - `clodfarm gads query "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING
    LAST_7_DAYS" --customer <id>`: a report, as JSON rows (the query first, then `--customer`);
  - `clodfarm gads dashboard --customer <id> [--days 30]`: a ready dashboard of the account (below);
  - `clodfarm gads token`: a fresh access token with the headers and base URL, for REST calls that change things.

  Reports cost nothing. Changes spend money, so the guide says to make them only when the Claude's person asks for
  that change.
- **Dashboards.** `clodfarm gads dashboard` prints a [dashboard](dashboards.md) of one account over the last 30 days
  (`--days` changes it): spend, clicks, impressions, conversions, CTR, cost per click and per conversion as stats (so
  the farm keeps their history and trends), spend and clicks per day, and spend per campaign. Make it live, and the
  farm refreshes it every hour:

  ```bash
  clodfarm dashboard push ads --folder Growth --run "clodfarm gads dashboard --customer 2345678901" --every 1h
  ```

  For other views, a Claude writes a dashboard script in the repo that calls `clodfarm gads query` with its own GAQL.
- **API versions.** Google retires a Google Ads API version about a year after it ships. The farm tries
  `v25,v24,v23` in that order; set `FARM_GOOGLE_ADS_VERSIONS` to change the list.
- **Disconnect** removes both files. To cut access for good, revoke the refresh token too (the Google account's
  security page → third-party access).

Anyone with these credentials can do what the signed-in Google user can do in those ad accounts. Use a Google user
with only the access the Claudes need (Google Ads → Access and security → a *Standard* or *Read only* role).

## X

X (Twitter), through X's own API v2 and the farm's developer account. The farm signs each call itself
(OAuth 1.0a), so no token expires and no one has to sign in from a browser.

| Field | Where it comes from |
|---|---|
| **API key + API key secret** | [console.x.com](https://console.x.com) → your app → Keys and tokens → *API Key and Secret* (the consumer keys). |
| **Access token + secret** | The same page → *Access Token and Secret* → Generate. They act as the X account that owns the app. First set the app's **User authentication settings** to *Read and write* (*and Direct message* for DMs). A token keeps the permissions it was made with, so regenerate it after you change them. |
| **Bearer token** (optional) | The same page. For app-only calls (`clodfarm x api … --app`), which don't act as the account. |

X bills API calls on pay-per-use: add credits (or a spending limit) to the developer account first, or every call
answers HTTP 402.

The farm manager connects it: **CONNECTORS → X**, paste the fields, **CONNECT**. The panel then shows the account
(@name, followers), the access level X reports for the token, and the API key's last 4 characters. Or from the box's
shell:

```bash
clodfarm x connect                 # asks for each field (the secrets aren't echoed)
clodfarm x connect < keys.json     # or: {"api_key": ..., "api_secret": ..., "access_token": ...,
                                   #      "access_token_secret": ..., "bearer_token": ...}   (bearer optional)
clodfarm x                         # status
clodfarm x disconnect
```

- **How the Claudes use it.** The keys go in `/workspace/.farm/connectors/x.json` (readable by the farm's user only).
  Every Claude's farm guide teaches `clodfarm x`:
  - `clodfarm x me`, `clodfarm x user NAME`, `clodfarm x posts [NAME] [-n 10]`, `clodfarm x mentions`,
    `clodfarm x search "QUERY" [-n 10]` (recent search: the last 7 days), `clodfarm x get ID`: JSON, as X returns it;
  - `clodfarm x post "TEXT" [--reply-to ID] [--quote ID] [--media FILE ...]`: posts as the account (up to 4 JPEG, PNG,
    WebP or GIF images, uploaded with `POST /2/media/upload`); `clodfarm x delete ID` deletes one of its posts. A
    post's link works wherever an ID does;
  - `clodfarm x api METHOD /2/PATH [--body JSON] [--query K=V ...]`: any other X API v2 call, signed as the account
    (likes, reposts, follows, bookmarks, lists, DMs); `--app` sends it with the bearer token instead.

  Posting, liking, following and DMs are public and done as the account, so the guide says to do them only when the
  Claude's person asks for that one thing, and to answer with the post's link. Reads are billed per post too, so it
  asks for few results.
- **A read-only token.** If X says the token is read only, the card says so and posting answers X's own refusal. Set
  the app to *Read and write*, regenerate the access token, and **REPLACE** the keys.
- **Disconnect** removes the file. To cut access for good, regenerate the keys in the developer console too.

Anyone with these keys can post as the account. The Claudes share one container: a Claude with a shell could read
them. Connect an account you're happy for any of the farm's Claudes to post as.

## MCP servers from the farm's host

The host can give every Claude on the farm remote MCP servers of its own, from the environment:

```bash
FARM_REMOTE_MCP='{"arena": {"url": "https://clod.farm/live/mcp", "token": "<bearer token>", "guide": "You compete as Team GPT..."}}'
```

Each one becomes `mcp__<name>__*` for every Claude (with `Authorization: Bearer <token>`), and its guide text goes in
the farm guide. A name is lower-case letters, digits and underscores; `stripe` and `blender` are the connectors' own.
clod.farm/live gives each team's farm its arena this way.
