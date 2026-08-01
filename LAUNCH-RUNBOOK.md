# LAUNCH RUNBOOK — storageownerseoguy.com
Do these in order; ~1 hour total.
Everything marked ✅ DONE was prepped by Claude on July 31, 2026.

## Already done (in this folder)

- ✅ **Domain PURCHASED: storageownerseoguy.com** (Scott, July 31, 2026)
- ✅ `CNAME` file created (`storageownerseoguy.com`)
- ✅ `robots.txt` + `sitemap.xml` created
- ✅ `404.html` created
- ✅ Canonical + og:url + schema url wired to https://storageownerseoguy.com/ in both pages

## Step 1 — Domain ✅ DONE

storageownerseoguy.com purchased July 31, 2026. No hosting/email/SSL add-ons
needed — GitHub Pages provides free SSL.

## Step 2 — Business email (5 min)

Create the Gmail: **storageownerseoguy@gmail.com** (matches the domain now).
Use it for Formspree, Search Console, and Stripe below. Keep it OFF the
website itself — form-first, as planned.

## Step 3 — Formspree ✅ DONE

Form created; live endpoint `https://formspree.io/f/mojgoapk` is wired into
index.html. Free tier = 50 submissions/mo — plenty for launch.
After the site is live: submit the form once for real and confirm the email arrives.

## Step 4 — Photo

Drop a real photo at `images/scott.jpg` — you at one of the facilities beats
anything staged. Then in `index.html` replace the placeholder:

```html
<div class="headshot">[ Photo of Scott —<br>add images/scott.jpg ]</div>
```
with:
```html
<img class="headshot" src="images/scott.jpg" alt="Scott Swenson, owner of six self-storage facilities in Minnesota and Wisconsin">
```

## Step 5 — GitHub repo + Pages (10 min, same playbook as WI64/Keewatin)

On the **sswenson123** account:

```bash
cd ~/Claude/Self\ Storage/Self-Storage-Guy
git init
git add .
git commit -m "Launch: Storage Owner's SEO Guy site"
git branch -M main
git remote add origin https://github.com/sswenson123/storageownerseoguy.git
git push -u origin main
```

Then: repo → Settings → Pages → Source: Deploy from branch → `main` / `(root)` →
Save. Custom domain: `storageownerseoguy.com` → Save → wait for DNS check →
**Enforce HTTPS** (checkbox appears after DNS propagates, up to an hour).

## Step 6 — DNS at Namecheap (5 min — domain is registered there)

Namecheap → Domain List → storageownerseoguy.com → **Manage** → **Advanced DNS** tab.

First DELETE Namecheap's defaults: the `CNAME www → parkingpage.namecheap.com`
record and the `URL Redirect @` record. Then add:

| Type     | Host | Value | TTL |
|----------|------|-------|-----|
| A Record | @    | 185.199.108.153 | Automatic |
| A Record | @    | 185.199.109.153 | Automatic |
| A Record | @    | 185.199.110.153 | Automatic |
| A Record | @    | 185.199.111.153 | Automatic |
| CNAME    | www  | sswenson123.github.io | Automatic |

(Leave nameservers on "Namecheap BasicDNS" — records go in Advanced DNS, not Personal DNS Server.)
The Search Console TXT record in Step 7 also gets added here: TXT Record, Host `@`, paste Google's value.

## Step 7 — Search Console (5 min)

1. search.google.com/search-console → Add property → Domain: `storageownerseoguy.com`
   (use the new Gmail — keeps the business separate from the facility GSC)
2. Verify via the DNS TXT record it gives you (add at registrar)
3. Sitemaps → submit `https://storageownerseoguy.com/sitemap.xml`
4. URL Inspection → request indexing on `/` and `/sample-report.html`

## Step 8 — Stripe payment links (10 min)

stripe.com → Payment Links → create four:

| Product | Price |
|---|---|
| Local SEO Cleanup | $997 one-time |
| Market Domination | $1,997 one-time |
| Multi-Facility Cleanup (per facility, 3+) | $797 one-time |
| Watchdog | $99/mo subscription |

Don't put the links on the site yet — send them by email when someone says yes.
(Invoicing feels more personal at this price point anyway.)

## Step 9 — Pre-flight (before sending any traffic)

- [ ] Read "My Story" out loud; edit anything that doesn't sound like you
- [ ] Confirm you're OK naming the six facility towns publicly
- [ ] Submit the form once for real; confirm the email arrives
- [ ] Load the site on your phone
- [ ] Click every nav link and both sample-report links

## Step 10 — First 10 leads

Plan is in README.md: your six facilities' GBPs + reviews are the portfolio,
then 10 free audits (farnerstorage.com and rministorage.com already done),
then the 3-findings email. Goal: 2 paid cleanups in month one.
