# Waste Warrior Bidding

A reverse-auction marketplace for waste removal. A customer posts a job, local providers bid the price **down**, and the lowest bid wins.

- **Jobs** – waste type, how much (single item up to skip-sized), collection dates, access notes, up to 4 photos and a maximum budget
- **Private address** – bidders only see the town or postcode area; the full address and contact details go to the winning provider once the customer has paid
- **Reverse bidding** – each bid must undercut the lowest by at least 50p, countdowns, bid history, and bidding always ends at the advertised time (late bids don't extend the clock)
- **Accept and pay** – when bidding closes the customer accepts the lowest bid and pays by card through Stripe Checkout (or declines it); confirmed by webhook and by direct verification on return
- **Platform fee** – 10% added to the customer's price at checkout and 10% taken from the provider's bid (set `PLATFORM_FEE_PERCENT` to change it). Each Stripe payment records the provider's payout and your fee in its metadata
- **Waste Warrior Plus** – a £2.95/month subscription (`#/plus`) for customers that lowers their service fee from 10% to 6%. Billed by Stripe; cancel any time and keep Plus to the end of the paid month. Set `STRIPE_PLUS_PRICE_ID` to the monthly Stripe price, and add the `customer.subscription.updated` and `customer.subscription.deleted` events to the Stripe webhook
- **Hauler Pro** – a £4.99/month subscription for haulers that lowers the fee taken from their winning bids from 10% to 6%. Set `STRIPE_PRO_PRICE_ID`. Both plans are on the Plans page (`#/plus`), and each job's fees are fixed when the customer starts paying
- **Haulers & waste carrier checks** – a Haulers page (`#/haulers`) where anyone can check a waste carrier number live against the Environment Agency public register, and haulers verify their own number (CBDU/CBDL) to get a “Registered carrier” badge on their bids and a place on the haulers list. Registrations are re-checked weekly
- **Hauler payouts** – haulers add their bank account or debit card on Stripe's secure onboarding page (`#/payouts`, “Get paid”); the site never sees card or bank numbers. When a customer pays, the hauler's share (winning bid minus their fee) is transferred to them automatically with Stripe Connect and Stripe pays it into their bank. Money for haulers who haven't set up yet waits and is sent as soon as they finish
- **Admin** – accounts listed in `ADMIN_EMAILS` get an Admin page (`#/admin`) with earnings, every job and member, and can remove unpaid jobs
- **Members only** – job details, photos, bidding, haulers, plans and stats need an account
- **Public pages for growth** – signed-out visitors get a front page with how it works, a price guide and a preview of open jobs (waste type, area and price only). Server-rendered local pages for Google (`/rubbish-removal/hull` and nine other East Yorkshire towns, `/services/sofa-removal` and five other services), a `/for-haulers` page, `/terms`, `/privacy`, `robots.txt`, `sitemap.xml` and a share image (`og.png`). Set `CONTACT_EMAIL` to show a contact address on the terms and privacy pages
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

Terms of service and privacy policy, email verification and password reset, moderation/reporting, deciding whether to require a verified waste carrier number before providers can bid, confirming a job is done before the provider is paid, and off-site backups of `/data`.

## Turn on hauler payouts (Stripe Connect)

1. In Stripe → Connect, click **Get started** and choose the **Express** account type (UK platform). Fill in your platform profile and branding.
2. In Stripe → Developers → Webhooks, add a second endpoint to the same URL `https://YOUR-SITE/api/stripe/webhook`, set to **Events on Connected accounts**, listening for `account.updated`. If its signing secret differs from your main one, use one endpoint for both: add `account.updated` to the existing endpoint and tick “Listen to events on Connected accounts”.
3. Haulers go to **Get paid** and click **Set up payouts**. Once Stripe verifies them, any money they're owed is sent automatically. Payouts also refresh whenever a hauler opens the Get paid page.

With `DEMO_PAYMENTS=1` the setup button switches payouts on instantly so you can try it.
