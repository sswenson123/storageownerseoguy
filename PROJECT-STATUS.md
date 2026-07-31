# PROJECT STATUS — Scott Swenson's Storage Empire + SEO Service Business
Last updated: July 31, 2026. READ THIS FIRST in any new conversation.

## Who Scott is
Owns 6 self-storage facilities in MN/WI. We completed a full local-SEO overhaul of all six sites. He is now launching **"The Storage Owner's SEO Guy"** — a service selling local-SEO cleanup to other storage facility owners. This folder is that business.

## The service business (THIS folder: Self-Storage-Guy)
- `index.html` — full sales site: hero, "3 leaks", My Story (names all 6 facilities), real findings, pricing ($997 audit+fix / $1,997 full cleanup / $99-mo maintenance / $797 per-site multi-facility), FAQ, contact form (Formspree), ProfessionalService schema
- `sample-report.html` — anonymized real audit (based on farnerstorage.com test audit)
- `css/style.css`, `README.md` (launch checklist), `images/` (waiting for scott.jpg)
- **Pricing chosen by Scott. Name chosen by Scott. Form-first contact with new email.**

### Service site LAUNCH CHECKLIST
**Domain PURCHASED July 31, 2026: storageownerseoguy.com** (Scott bought it; site files all wired to it).
Claude prepped the launch package July 31, 2026: CNAME, robots.txt, sitemap.xml, 404.html created; canonical/og:url/schema url wired to https://storageownerseoguy.com/ on both pages. Full step-by-step in `LAUNCH-RUNBOOK.md` (READ THAT for launch — it supersedes README's launch section).

Still on Scott (in order, ~1 hr): 1) ~~buy domain~~ DONE 2) create storageownerseoguy@gmail.com 3) Formspree form → replace YOUR_FORM_ID in index.html 4) add images/scott.jpg + swap headshot placeholder (exact HTML in runbook) 5) git init/push to sswenson123/storageownerseoguy, enable Pages, DNS records 6) Search Console + submit sitemap 7) Stripe payment links 8) read My Story out loud & edit 9) test form for real.
First prospects already researched: farnerstorage.com, rministorage.com (test audits done in prior conversation).

### Market research summary (full doc: outputs were in prior session; key facts)
- ~35K independent US facilities; 93% of renters search online; tenant LTV $1,200–1,400
- Closest competitor analog: StorageRankers $299–899/mo. Scott's edge: he's an actual owner with 6 facilities and real before/after results.

## The six facilities (all sites audited, fixed, deployed, verified)
| Facility | Domain (canonical) | Repo / Hosting | StorEdge facilityId |
|---|---|---|---|
| WI64 Self Storage, New Richmond WI | wi64selfstorage.com (non-www) | sswenson123/WI64SELFSTORAGE, GitHub Pages | c621f5d9-15d0-4cc0-b26f-d4aa778139e7 |
| Big Door Storage, Eagle River WI | www.bigdoorstorage.com | Car-Zumo/Big-Door-Storage, Vercel | 4672c663-377f-4bc1-b32c-4f5b939a17f5 |
| Balsam Self Storage, Bovey MN | www.balsamselfstorage.com | Car-Zumo (Vercel) ~/Balsam-Self-Storage | 0fb7cb08-5e40-4308-aa6a-f523cf02813a |
| Long Lake Toy Sheds, Park Rapids MN | www.longlaketoysheds.com | Car-Zumo (Vercel) ~/Long-Lake-Toy-Sheds | d8dff67b-e4cd-487b-9d5e-c25cfc771aa5 |
| Pleasant Lake Storage, Hackensack MN | pleasantlakestorage.com (non-www) | sswenson123/pleasantselfstorage, GH Pages + Cloudflare | 159d76bf-6636-4e86-87fe-82fc497dc971 |
| Keewatin Self Storage, Keewatin MN | www.keewatinselfstorage.com | sswenson123/keewatinSelfStorage, GH Pages | 4e5d19f2-a80f-45d0-ba9f-e13f89f04275 |

StorEdge companyId (all): ef2375f3-b212-4670-bbc0-be544f6614b6
All 6 verified in Google Search Console (HTML file google2a0891b24ccff0b8.html). Mystery: an unverified 7th property "dakotaselfstoragecenter.com" sits in his GSC list — never explained.

## What was fixed (highlights, all deployed)
- Canonicals/www consolidation on all sites; robots.txt + sitemaps everywhere
- Big Door: canonical pointed at big-door-storage.vercel.app (the twin was outranking the real site!) → fixed + middleware.ts 308-redirects *.vercel.app → real domain (VERIFIED working). Same middleware added to Balsam & Long Lake repos.
- Fake reviews/aggregateRating schema REMOVED (Keewatin page+schema, Long Lake schema) — Google bans self-serving review markup
- Cross-wired StorEdge rent buttons fixed (Big Door was renting Long Lake units)
- Balsam: "Cold Storage" → "Self Storage" keyword fix, fake template content (Ho Chi Minh address etc.) replaced
- Long Lake: pricing published as "Current special: $170/mo (indoor 24x24) / $50/mo (outdoor) for new move-ins" — wording chosen deliberately because some existing tenants pay MORE
- Pleasant Lake: 4 new city/service pages (Walker, Longville, boat, RV) + compressed facility-tour video with VideoObject schema
- Keewatin: price-attack pages vs Hibbing ($60 vs their $85)
- Old WordPress duplicate (wiroofingexperts.com) killed with 410s

## Outstanding / pending
- Long Lake: prettier fix + push may still be pending (build failed once; check Vercel deploy status)
- Big Door: unit size discrepancy unresolved — homepage says 43'×14'×10', contact page says 42'×14'×16'. Ask Scott which is right.
- Refresh Outdated Content for big-door-storage.vercel.app: Google says "page still exists" (redirect works); optional — index will consolidate on its own
- **Biggest remaining lever: OFF-site.** Google Business Profiles (Keewatin/Balsam/Pleasant Lake unclaimed), fresh Google reviews everywhere (Big Door's newest is 8 yrs old), citation execution
- Citation toolkit built in a prior session's outputs folder (facilities.json with all NAP data, tracker xlsx, check-citations.js) — outputs folder is temporary, may need regenerating; NAP data for all 6 is authoritative in that facilities.json format
- Pleasant Lake bad citations to fix: CMac.ws lists 218-675-5625; usselfstorage lists (651) 327-0146 (both wrong; real: (218) 227-2899)

## Working style Scott prefers
- Straight to the point, concise. He pastes external audits to verify/execute.
- He runs git himself: add/commit/push; knows `git pull --rebase` and `npx prettier --write src/` for Vercel lint failures
- Vercel builds fail on prettier — always run prettier before committing to the 3 Vercel repos
- GitHub accounts: sswenson123 (Pages sites), Car-Zumo org (Vercel sites)
