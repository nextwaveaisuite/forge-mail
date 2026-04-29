# Forge Mail — Lead Manager Setup Guide

---

## What you need
- GitHub account
- Netlify account
- Supabase account (free)
- OpenAI API key

---

## STEP 1 — Supabase

1. Go to supabase.com → New Project → name it `forge-mail`
2. SQL Editor → paste entire `supabase/schema.sql` → Run
3. Project Settings → API → copy:
   - Project URL → `SUPABASE_URL`
   - anon public key → `SUPABASE_ANON_KEY`
   - service_role key → `SUPABASE_SERVICE_ROLE_KEY`

---

## STEP 2 — Add your Supabase keys to the frontend

Open `apps/mail/leads.html` — find at the top of the script:
```javascript
const SUPABASE_URL  = "YOUR_SUPABASE_URL";
const SUPABASE_ANON = "YOUR_SUPABASE_ANON_KEY";
```
Replace with your actual values.

Same for `apps/mail/login.html` if you copy it from forge-os.

---

## STEP 3 — Push to GitHub + Deploy to Netlify

```bash
git init && git add . && git commit -m "Forge Mail v2"
git remote add origin https://github.com/YOU/forge-mail.git
git push -u origin main
```

Netlify → Import from Git → select repo → Deploy

---

## STEP 4 — Environment Variables in Netlify

| Key | Value |
|-----|-------|
| `OPENAI_API_KEY` | sk-... |
| `SUPABASE_URL` | your URL |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key |

Redeploy after adding.

---

## STEP 5 — Subdomain

Namecheap → CNAME → `mail` → your-site.netlify.app
Netlify → Domain → Add `mail.nextwaveaisuite.com`

---

## How the Lead Manager works

### Importing leads
1. Go to `leads.html`
2. Click **Import Leads**
3. Select pool: **MLGS** (organise only) or **My Own Leads** (full control)
4. Name your batch, set batch size (100 / 250 / 350 / 500 / 1,000)
5. Add tags (e.g. "jan-2025", "weight-loss", "cold")
6. Drop your CSV file
7. Click Import

### CSV format
The importer auto-detects columns. Supported header names:
- Email: `email`, `email address`, `e-mail`
- First name: `first name`, `firstname`, `first`, `fname`
- Last name: `last name`, `lastname`, `last`, `lname`, `surname`
- Phone: `phone`, `phone number`, `mobile`, `cell`
- Postcode: `postcode`, `post code`, `zip`, `zip code`, `postal code`
- State: `state`, `province`, `region`
- Country: `country`, `country code`

### Batch sizes
- 100 leads — small test import
- 250 leads — daily MLGS allocation (~2-3 days)
- 350 leads — 3-4 days
- 500 leads — standard weekly batch
- 1,000 leads — max per import (upload in multiple batches for 15,600)

### To import all 15,600 MLGS leads
Export from MLGS → split into batches of 500 or 1,000 → import each batch
Each batch gets a name: "MLGS Batch 1", "MLGS Batch 2" etc.
At 1,000 per batch = 16 imports to get all leads in.

### Tagging system
- Tag by date: "jan-2025", "feb-2025"
- Tag by batch: "batch-1", "batch-2"
- Tag by niche: "weight-loss", "make-money"
- Tag by source: "mlgs", "own-list"
- All tags are searchable and filterable

### MLGS pool restrictions
- MLGS leads: NO export button, NO external send button
- Organise, tag, search, filter only
- Send emails through MLGS platform

### Own leads pool
- Full export as CSV
- No restrictions
- Mark as unsubscribed, bounced, active
- Filter by state, country, tags

---

## Pages
- `index.html` — Email Writer + Rotator
- `leads.html` — Lead Manager
- `login.html` — Auth (copy from forge-os)
