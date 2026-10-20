# Waste Warrior Bidding

A reverse-auction marketplace for waste removal. A customer posts a job, local providers bid the price **down**, and the lowest bid wins.

- **Jobs** – waste type, how much (single item up to skip-sized), collection dates, access notes, up to 4 photos and a maximum budget
- **Private address** – bidders only see the town or postcode area; the full address and contact details go to the winning provider once the customer has paid
- **Reverse bidding** – each bid must undercut the lowest by at least 50p, countdowns, bid history, anti-sniping (late bids extend bidding by 2 minutes)
- **Accept and pay** – when bidding closes the customer accepts the lowest bid and pays by card through Stripe Checkout (or declines it); confirmed by webhook and by direct verification on return
- **Platform fee** – 10% added to the customer's price at checkout and 10% taken from the provider's bid (set `PLATFORM_FEE_PERCENT` to change it). Each Stripe payment records the provider's payout and your fee in its metadata
- **Accounts** – sign up / log in (bcrypt-hashed passwords, httpOnly cookie sessions)
- **Dashboard** – providers track their bids (lowest/undercut/won), customers track their jobs
- Prices in pounds (GBP). Search, waste-type filters and sorting; responsive, dark-mode and keyboard friendly

## Run locally

Requires Node 22.13+.

```sh
npm install
DEMO_PAYMENTS=1 npm start
```

Open http://localhost:3000. With `DEMO_PAYMENTS=1` the "Accept and pay" button simulates a payment so you can try the whole flow without Stripe. Other settings are listed in `.env.example` (set them as environment variables).

```sh
npm run seed   # optional: demo jobs for development (refuses to run in production)
npm test
```

## Turn on real payments (Stripe)

1. Create a Stripe account and set your **secret key** as `STRIPE_SECRET_KEY` (use a `sk_test_…` key first).
2. In Stripe → Developers → Webhooks add an endpoint `https://YOUR-SITE/api/stripe/webhook` listening for `checkout.session.completed`, and set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Set `BASE_URL` to your public site URL.

Test card: `4242 4242 4242 4242`, any future date, any CVC.

> Payments go to **your** Stripe account. You then owe each provider their bid minus the fee (shown on the payment in Stripe as `provider_payout_pence`). Paying providers automatically needs Stripe Connect, plus decisions about KYC and terms — not included.

## Deploy

GitHub Pages can't run this (it needs a server). Any Node host works; the included `Dockerfile` runs anywhere (Render, Railway, Fly.io, a VPS…). On Render, `render.yaml` sets this up for you (New → Blueprint, pick this repo; the persistent disk needs a paid plan). Otherwise set the variables from `.env.example`, set `NODE_ENV=production`, and mount a **persistent disk** at `/data` — it holds the SQLite database and uploaded photos.

## Layout

```
server/   Express API (auth, listings, bids, uploads, Stripe) + SQLite
public/   Single-page frontend (no build step)
test/     API tests (npm test)
```

## Before a real launch

Terms of service and privacy policy, email verification and password reset, moderation/reporting, checking providers hold a waste carrier licence, confirming a job is done before the provider is paid, and off-site backups of `/data`.
