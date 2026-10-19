# Waste Warrior Bidding

A marketplace where people auction recyclable waste to collectors.

- **Accounts** – sign up / log in (bcrypt-hashed passwords, httpOnly cookie sessions)
- **Photo upload** – up to 4 photos per listing (JPEG/PNG/WebP, 5 MB each, verified by file signature)
- **Live auctions** – minimum increments, countdowns, bid history, anti-sniping (late bids extend the auction by 2 minutes)
- **Payments** – the winner pays by card through Stripe Checkout; confirmed by webhook and by direct verification on return
- **Dashboard** – track your bids (leading/outbid/won) and your listings
- Search, category filters and sorting; responsive, dark-mode and keyboard friendly

## Run locally

Requires Node 22.13+.

```sh
npm install
DEMO_PAYMENTS=1 npm start
```

Open http://localhost:3000. With `DEMO_PAYMENTS=1` the "Pay" button simulates a payment so you can try the whole flow without Stripe. Other settings are listed in `.env.example` (set them as environment variables).

```sh
npm test
```

## Turn on real payments (Stripe)

1. Create a Stripe account and set your **secret key** as `STRIPE_SECRET_KEY` (use a `sk_test_…` key first).
2. In Stripe → Developers → Webhooks add an endpoint `https://YOUR-SITE/api/stripe/webhook` listening for `checkout.session.completed`, and set its signing secret as `STRIPE_WEBHOOK_SECRET`.
3. Set `BASE_URL` to your public site URL.

Test card: `4242 4242 4242 4242`, any future date, any CVC.

> Payments currently go to **your** Stripe account. Paying sellers directly (or taking a platform fee) needs Stripe Connect, plus decisions about KYC and terms — not included.

## Deploy

GitHub Pages can't run this (it needs a server). Any Node host works; the included `Dockerfile` runs anywhere (Render, Railway, Fly.io, a VPS…). Set the variables from `.env.example`, set `NODE_ENV=production`, and mount a **persistent disk** at `/data` — it holds the SQLite database and uploaded photos.

## Layout

```
server/   Express API (auth, listings, bids, uploads, Stripe) + SQLite
public/   Single-page frontend (no build step)
test/     API tests (npm test)
```

## Before a real launch

Terms of service and privacy policy, email verification and password reset, moderation/reporting, handling of regulated waste types, and off-site backups of `/data`.
