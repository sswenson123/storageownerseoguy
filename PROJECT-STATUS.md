# PROJECT STATUS — Scott Swenson's Storage Empire + SEO Service Business
Last updated: July 31, 2026. READ THIS FIRST in any new conversation.

## Who Scott is
Owns 6 self-storage facilities in MN/WI. We completed a full local-SEO overhaul of all six sites. He is now launching **"The Storage Owner's SEO Guy"** — a service selling local-SEO cleanup to other storage facility owners. This folder is that business.

## The service business (THIS folder: Self-Storage-Guy)
- `index.html` — full sales site: hero, "3 leaks", My Story (names all 6 facilities), real findings, pricing (REVISED Sept 14, 2026 — Build & Maintain model: $997 Build one-time / $39-mo Maintain / $149-mo Maintain+Improve / $797 per-facility 3+; $1,997 tier and $99 Watchdog RETIRED), FAQ, contact form (Formspree), ProfessionalService schema
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
- Long Lake: **self-storage ranking package EXECUTED in repo Aug 6, 2026** (Scott's pasted audit, verified & corrected): new /self-storage-park-rapids-mn page (metadata+FAQPage schema), Self Storage nav item, homepage title/H1 now include "Self Storage", sitemap entry, self-storage Offer in schema. Scott pushed Aug 6 (+ his own commits: pricing & meta descriptions across pages). **DEPLOY VERIFIED LIVE Aug 6:** new page, nav, homepage title/H1 ("self storage" ×8), climate-controlled meta gone, sitemap.xml serving. Remaining verify: JSON-LD via Rich Results Test (fetch tool strips scripts). Then GSC: submit sitemap + request indexing on new pages.
- Long Lake FIT-DATA PACKAGE shipped & verified live Aug 6 (commit f02e854): real measured specs — door 10x10 ft, interior 23'9"x23'4.5" (~555 sq ft usable; "576" claims corrected sitewide incl. schema), drive lane 31'10". New /24x24-storage-unit-size-guide page (spec+comparison tables, FAQPage schema, in sitemap), fit tables on RV page, dimensions on boat page, UTM tags (utm_source=website&utm_medium=referral&utm_campaign=longlaketoysheds) on all Rent Now links. ServiceLanding now supports table+faqs props. Also: robots.ts Host line removed; .fuse_hidden sync artifacts purged from repo + gitignored. OPEN: confirm outdoor spaces really accept fifth wheels/Class A (fit tables say so); non-www→www redirect check in Vercel domains; GA4 not yet installed (UTMs ready).
- Pleasant Lake same day (Scott solo): live availability scraper → data/availability.json, direct StorEdge API call (killed CDN cache issue), GSC verification file pushed. NOTE: all 3 phone numbers work and ring Scott — (218) 227-2899 is CANONICAL for citations; 218-675-5625 = old line (keep alive, never publish); (651) 327-0146 = his Google Voice (personal only). Pleasant Lake GBP CID: 17080173087336363257 (maps.google.com/?cid=...), geo 46.8930745,-94.4978969. CMac.ws + usselfstorage corrections drafted; YellowPages says Long Lake units are 25x25/625 sqft — wrong, fix listing.
- Long Lake off-site (from same audit, Scott's court): GBP primary category → "Self-storage facility" (keep boat/RV as secondary), add self-storage language+photos to GBP, push reviews (~5 now, 15-20 targets 3-pack), get listed on SpareFoot/Storage.com, claim Yelp, Park Rapids Chamber link
- Big Door: unit size discrepancy unresolved — homepage says 43'×14'×10', contact page says 42'×14'×16'. Ask Scott which is right.
- Refresh Outdated Content for big-door-storage.vercel.app: Google says "page still exists" (redirect works); optional — index will consolidate on its own
- **Biggest remaining lever: OFF-site.** Google Business Profiles (Keewatin/Balsam/Pleasant Lake unclaimed), fresh Google reviews everywhere (Big Door's newest is 8 yrs old), citation execution
- **Citation-Tracker.xlsx (all 6 facilities, live-audited Aug 6, 2026) is at `/Users/sswenson/Claude/Self Storage/Citation-Tracker.xlsx`** — 8 tabs: NAP fact sheets + per-facility hit lists with priorities. Key finds: USSelfStorage network swaps phones to their (855) lead-gen number (hit Long Lake + Pleasant Lake; check WI64/Big Door); Big Door's SpareFoot listing filed under Wausau; Balsam has a live Crexi for-sale listing of the property; WI64 & Keewatin SHARE Scott's (651) Google Voice as their published number (flagged, keep consistent until dedicated numbers); wiroofingexperts.com domain fully dead (DNS gone) — zombie index entries will drop. Keewatin citations thinnest; Balsam+Keewatin GBPs still unclaimed = top priority rows.
- (Old note: prior session's citation toolkit/facilities.json was in a temporary outputs folder — superseded by the tracker above)
- Pleasant Lake bad citations to fix: CMac.ws lists 218-675-5625; usselfstorage lists (651) 327-0146 (both wrong; real: (218) 227-2899)

## Working style Scott prefers
- Straight to the point, concise. He pastes external audits to verify/execute.
- He runs git himself: add/commit/push; knows `git pull --rebase` and `npx prettier --write src/` for Vercel lint failures
- Vercel builds fail on prettier — always run prettier before committing to the 3 Vercel repos
- GitHub accounts: sswenson123 (Pages sites), Car-Zumo org (Vercel sites)


## Business model + launch progress (Sept 13-14, 2026)
- **Model REVISED to Build & Maintain:** Scott keeps full control (builds/maintains/fixes everything); CLIENT keeps ownership (repo in their GitHub, domain in their registrar, Scott admin on both). Pricing: $997 Build ($797 ea 3+) / $39-mo Maintain (unlimited small edits, listings check, report) / $149-mo Maintain+Improve (monthly improvement, GBP posts, review engine, rank tracking). Site copy updated everywhere: "No subscriptions" replaced with "No contracts. Cancel anytime. Keep everything." Schema priceRange now $39-$997. Scott still needs NEW Stripe subscription links ($39, $149) — old $1,997/$99 links retire.
- Site now says SEVEN facilities everywhere (matches FB post). 7th facility identity still unconfirmed in files — ask Scott (dakotaselfstoragecenter.com?). PHOTO PLACEHOLDER STILL LIVE on index (images/scott.jpg missing) — flagged repeatedly.
- New page live-pending-push: rented-vs-owned-storage-websites.html + downloads/Rented-vs-Owned-Storage-Websites.pdf; sitemap updated; footer links added.
- **FB guinea-pig campaign results:** TNC Storage (Green Bay/Ashwaubenon — invisible, unclaimed GBP; plan in TNC-CLIENT-PLAN.md; tncstorage.com was available) and Splitrock Storage (Finlayson MN — 5.0x50 GBP no hours, v0/Vercel site no robots/sitemap/schema, CC Storage portal, WV cell # loose in FB posts; plan in SPLITROCK-CLIENT-PLAN.md + client-facing Splitrock-Storage-SEO-Plan.pdf) = the 2 free slots. U Stuff It (Fort Collins — 4 phone numbers live, CLOSED Yelp twin, StorEdge site; full audit in UStuffIt-Visibility-Report.pdf) = first PAID pipeline prospect. Cold prospects audited: All In Mini Storage (Roseburg OR, StorEdge, name-collision competitor all-in-storage.com) and All Secure Mini Storage (Albany OR, 4.8x223 reviews on abandoned ThemeRex template site, Google says Millersburg).
- Reusable assets created: Citation-Tracker.xlsx (all 6 facilities), Rented-vs-Owned PDF (client value-add), client-plan template (in TNC plan), client-facing plan format (Splitrock PDF), visibility-report format (UStuffIt PDF).
