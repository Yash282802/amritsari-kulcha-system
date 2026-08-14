# Amritsari Kulcha — QR Dine-in Ordering System

A complete QR-based dine-in ordering platform for the Amritsari Kulcha restaurant chain (4 branches). Customers scan a table QR code, browse a 155-item menu, place orders that land in the kitchen's queue, and the reception generates and settles the bill — which is then delivered to the customer on WhatsApp, followed by a Google review request the next day.

**Live:** https://amritsari-kulcha-system.onrender.com

---

## What it does

### Customer side (`/b/:branch/:table?t=<token>`)
- Each table has its own QR code. Scanning it opens the ordering page **only for that table** — the code is validated against a per-table secret token, so a QR printed for table 3 can't be used to order on table 9 (or from home).
- The menu is a catalog: tap a category chip (Kulchas, Starters, Paneer Sabzi, Dal, Rice, etc.) to see that category's dishes. Kulchas come in **Maida / Atta** variants plus an optional **Extra Butter (+₹10)**.
- Add items to a cart, review it in a bottom sheet (subtotal + 5% GST + ₹15 restaurant charge), confirm, and track order status live (`/track`).

### Kitchen (`/kitchen`)
- Live order queue for the branch. Orders flow through a strict state machine: **new → preparing → ready → delivered** (no skipping, one step at a time).
- Mistake? Undo one step, but only within **60 seconds** of the last update.

### Reception (`/reception`)
- Live view of all tables with order status. When a table's orders are delivered, generate a bill (subtotal, 5% GST, ₹15 service charge).
- Collect the customer's phone number and mark the bill paid (Cash / UPI / Card). On payment, the table unlocks and the **bill is sent to the customer's WhatsApp** automatically.

### Owner / Admin (`/admin`)
- Revenue report with a period selector (today / 7 days / 30 days / all time), broken down per branch.
- Edit any menu item's price, set the GST % and restaurant charge, and see which WhatsApp notifications failed to send.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js (ESM), zero-build vanilla JS frontend |
| Database | PostgreSQL (Supabase-hosted), `pg` driver |
| Hosting | Render (free web service, auto-deploy on push to `main`) |
| WhatsApp | Meta WhatsApp Business Cloud API (templates) |
| Styling | Hand-rolled utility classes in HTML (no framework) |

The whole app is a single Node server: `server.js` wraps the request handler in `api/index.js`, which serves both the static pages and the JSON API. There is no build step.

### Why vanilla, no framework
The frontend is intentionally dependency-free. Every page is one HTML file with inline JS that polls the API every few seconds. For a small restaurant chain this keeps deploys instant, the bundle tiny, and there is nothing to break between environments.

---

## Project structure

```
├── api/index.js          # All HTTP routes: static pages, catalog, orders, bills, auth, admin
├── db.js                 # Postgres pool, schema, seeding, menu data (155 items), helpers
├── wa.js                 # WhatsApp Cloud API sender (templates, test-mode hook)
├── server.js             # Local dev server entry point
├── render.yaml           # Render deploy config (free plan, health check)
├── public/
│   ├── order.html        # Customer menu / cart / order (one category at a time)
│   ├── track.html        # Customer order status + bill preview
│   ├── kitchen.html      # Kitchen order queue + status machine
│   ├── reception.html    # Table overview, bill generation, payment, phone capture
│   ├── admin.html        # Revenue, price editing, tax/charge config, notif failures
│   ├── login.html        # Staff login (tap branch → role → password)
│   ├── tables-qr.html    # Print QR codes per table (staff only)
│   ├── dashboard.html    # Shared dashboard
│   └── invalid-qr.html   # Shown when a table QR is invalid
└── test-e2e.mjs          # End-to-end API test against a local server
```

---

## Data model

- **branches** — id (slug), name, whatsapp_number, address, gstin, review_link
- **tables** — branch, table_number, status (available/occupied), locked, and a per-table **token** (12-char random hex) that secures the QR
- **menu_items** — category, name, description, base_price (in **paise**), is_veg, available, bestseller
- **menu_item_variants** — variant_name (Maida/Atta/Extra Butter), price_delta
- **orders** — branch, table, status (new→preparing→ready→delivered), timestamps
- **order_items** — menu item, variant, quantity, and **price_at_order** (a snapshot, so later price changes never rewrite history)
- **bills** — subtotal, tax_amount, tax_rate_snapshot, service_charge, total, payment_status, payment_method, customer_phone, paid_at, notif_failed
- **bill_orders** — link between a bill and its orders
- **staff_accounts** — per-branch kitchen/reception logins + owner; passwords stored as scrypt salt:hash
- **notification_log** — every WhatsApp send attempt (invoice / review_request) with status
- **settings** — tax rate and service charge, editable from the admin page
- **sessions** / **login_attempts** — staff sessions and login rate limiting

All prices are stored as **integer paise** (₹240 = `24000`) to avoid floating-point money bugs.

The menu is defined once in `db.js`. On server start, `seed()` ensures the schema exists and **syncs the live DB to the menu definition** — new dishes are inserted, prices updated, and removed dishes hidden (`available=0`) rather than deleted, because `order_items` reference them historically.

---

## API endpoints

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/health` | public | health check for Render |
| GET | `/api/catalog/menu?branch=` | public | available menu + variants, grouped by category |
| POST | `/api/orders` | public (needs table token) | place an order |
| GET | `/api/orders/:id/track` | public (random order id) | order status + bill preview |
| POST | `/api/auth/login` | public | staff login (rate-limited) |
| GET | `/api/auth/me` · POST | session | session check / logout |
| GET | `/api/host` | session | LAN address (dashboard) |
| GET | `/api/tables/numbers?branch=` | staff | table numbers + tokens (for QR printing) |
| GET | `/api/orders?branch=` | staff | order queue |
| PATCH | `/api/orders/:id/status` | staff | advance status machine |
| POST | `/api/orders/:id/undo` | staff | undo one step (60s window) |
| GET | `/api/tables?branch=` | staff | live table states |
| POST | `/api/bills/generate` | staff | build bill from delivered orders |
| PATCH | `/api/bills/:id/pay` | staff | mark paid, capture phone → sends WhatsApp bill |
| GET | `/api/bills/:id` | staff | bill detail |
| GET | `/api/admin/revenue` | admin | per-branch revenue for a period |
| GET/PUT | `/api/admin/config` | admin | tax rate & service charge |
| PUT | `/api/admin/menu` | admin | update a menu item price |

---

## WhatsApp automation

Built in `wa.js` using the **WhatsApp Business Cloud API**. Two flows, both **template-based** (WhatsApp only allows businesses to start a conversation with approved templates):

1. **Bill receipt** — when reception marks a bill paid with a phone number, a `bill_receipt` template is sent with the branch name, table, and total. Retried once on failure; failures are flagged on the bill and surfaced in admin.
2. **Review request** — ~24 hours after payment, a `review_request` template with the branch's Google review link is sent. This runs lazily: every staff page poll calls `reviewJob()`, which finds paid bills older than 24h that haven't been asked yet (deduped per phone per day).

### Env vars

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase) |
| `WA_TOKEN` | Meta WhatsApp permanent access token |
| `WA_PHONE_ID` | WhatsApp phone-number ID |
| `WA_TEST_TO` | optional — forces all sends to one number (for testing) |
| `WA_TPL_BILL` | template name, default `bill_receipt` |
| `WA_TPL_REVIEW` | template name, default `review_request` |

If `WA_TOKEN`/`WA_PHONE_ID` aren't set, sends are skipped and logged — the app never crashes without WhatsApp configured.

> **Cost note:** Meta gives 1,000 free *service* conversations/month (bill receipts count here). Marketing conversations (review requests) cost a few rupees each. Setup, templates, and up to 5 test recipients are free.

---

## Staff accounts (seed defaults — change before going live)

- Kitchen: `kitchen_<branch> / kitchen123`
- Reception: `reception_<branch> / reception123`
- Owner: `owner / owner123`

Branches: `alkapuri`, `nizampura`, `old-chhani-road`, `gorwa`. Owner can switch branches in the admin page. Login is rate-limited per IP.

---

## Local development

```bash
npm install
# create .env with DATABASE_URL=postgres://...
npm run dev      # http://localhost:4000
npm test         # runs test-e2e.mjs against a local server
```

`npm start` loads `.env` via `node --env-file-if-exists=.env`.

---

## Deployment (Render)

`render.yaml` defines the free web service: `npm install`, `npm start`, health check at `/api/health`, auto-deploy on every push to `main`. The `DATABASE_URL` is set once in the Render dashboard (not committed). Push to GitHub → Render deploys → QR pages, kitchen, reception, and admin all go live.

---

## How a meal flows end to end

1. Customer scans the table QR → opens `order.html` for that table.
2. Picks a category, chooses dishes and kulcha variants, confirms the cart.
3. Order appears instantly in the branch kitchen queue (polled every few seconds).
4. Kitchen cooks it: new → preparing → ready → delivered.
5. Reception sees the delivered table, generates the bill, takes payment + phone number.
6. On payment, the bill goes to the customer's WhatsApp; the table unlocks for the next guest.
7. Next day, the customer gets the Google review link.

---

## Known limitations / next steps

- **Existing printed QR codes are invalid** after the token-security update — reprint them from the staff-only `tables-qr` page.
- Branch `whatsapp_number` and `review_link` are placeholders — real numbers/review links need to be added once the WhatsApp Business account and Google Business profiles are set up.
- The free Render plan **sleeps after ~15 minutes of inactivity**; the first request after idle takes a few seconds to wake the server.
- Supabase is used with RLS disabled — the server is the only client (via `DATABASE_URL`). If the API ever needs to be exposed directly to the browser, row-level security should be enabled.
- WhatsApp is only half-configured until a Meta Business account, permanent token, phone-number ID, and two approved templates exist (see `wa.js` and the env vars above).
