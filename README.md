# The Storage Owner's SEO Guy — Launch Checklist

Static site, no build step. Same playbook as your facility sites.

## Launch (about 1 hour, all steps you've done before)

1. **Domain** — check availability and buy ONE (GoDaddy, ~$12/yr):
   - storageownerseoguy.com (first choice)
   - storageseoguy.com (shorter fallback)
   - theseoguy.storage (novelty fallback)
2. **Photo** — add a real photo of yourself as `images/scott.jpg` and replace the placeholder box in index.html (search for "headshot"). A photo of you AT one of your facilities is perfect. This matters more than any design choice.
3. **Form** — create a free account at formspree.io → New Form → name it "Free Report Requests" → copy the form ID → in index.html replace `YOUR_FORM_ID` in the form action. Submissions arrive by email.
4. **Email** — create the business Gmail (e.g., storageownerseoguy@gmail.com) and use it for Formspree + everything else. Keep it out of the site itself for now (form-first).
5. **GitHub** — new repo (e.g., `seo-guy-site`), push this folder, Settings → Pages → deploy from main/(root) → custom domain → Enforce HTTPS. Point the domain's DNS at GitHub Pages (same A records + CNAME as your other sites).
6. **Search Console** — verify, submit sitemap after adding one (or just request indexing on the two pages — a 2-page site doesn't need a sitemap on day one).

## Before you send traffic to it

- [ ] Replace headshot placeholder with your photo
- [ ] Read the My Story section out loud — edit anything that doesn't sound like you (it's YOUR voice on the line)
- [ ] Confirm you're comfortable naming the facility towns in the story section (currently: Hackensack, Keewatin, Park Rapids, Eagle River, Bovey, New Richmond)
- [ ] Test the form with a real submission
- [ ] Decide payment method for when someone says yes: Stripe payment links are the easy answer (stripe.com → Payment Links → $997 / $1,997 / $797 / $99-mo subscription)

## First 10 leads (the plan from the business brief)

1. Finish YOUR six facilities' GBPs + reviews first — they're the portfolio.
2. Run free audits on 10 independent facilities in MN/WI (not near your own).
3. Send each owner the 3-findings email. Template:

> Subject: Found a problem with [Facility Name]'s Google listing
>
> Hi [Name] — I own six storage facilities in MN/WI, so I look at storage websites the way you'd look at another guy's gate motor. I ran a quick check on [Facility] and found [specific finding #1 — e.g., "your listing on [directory] shows the phone number as XXX, which isn't yours"], plus two other things costing you rentals. No charge, no pitch — want me to send the full report?

4. Goal: 2 paying cleanups in the first month. Their before/afters become your testimonials.

## Files

- `index.html` — the whole pitch: hero, problems, your story, real findings, how it works, published pricing, FAQ, intake form
- `sample-report.html` — the anonymized Farner audit as the sample deliverable (doubles as your report template)
- `css/style.css` — all styling
