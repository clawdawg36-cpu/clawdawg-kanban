# Site Architecture & Sitemap Decision

**Project:** OpenClaw AI Curriculum for Middle School  
**Decision Date:** 2026-03-21  
**Status:** Finalized ✅

---

## Decision: Option 2 — Multi-Page Architecture

**Chosen structure:** Homepage + audience-specific landing pages (`/homeschool`, `/educators`, `/school-boards`, `/policy`)

---

## Rationale

### Why Not Option 1 (Single Long-Page with Toggle/Tabs)

- **SEO killer.** A single URL means one set of meta tags, one page title, and one crawlable body — we can't rank for "AI curriculum for homeschoolers," "middle school AI lesson plans for teachers," AND "K-12 AI policy resources" simultaneously. Each audience has different search intent; they need different URLs.
- **Conversion friction.** Audience toggles require the visitor to self-identify, then interact before seeing relevant content. Audience-specific landing pages make the value proposition immediately obvious — no cognitive overhead.
- **Link sharing falls apart.** When a school board member shares the URL in a district newsletter, a single-page URL dumps every audience at the top. A `/school-boards` URL delivers them exactly where they need to be.

### Why Not Option 3 (Hybrid with PDF Downloads)

- **PDFs are maintenance debt.** Every curriculum update means regenerating and re-uploading PDFs per audience. Multi-page HTML is version-controlled and always current.
- **PDFs don't rank.** Google indexes PDFs but ranks them poorly vs. structured HTML pages, especially for conversational queries.
- **Hybrid complexity.** Maintaining a homepage that deep-links into sections PLUS separate PDFs creates two parallel content trees. This approach suits a Phase 2 "download" feature, not core site architecture.
- **Not ideal for conversion.** We want visitors to engage with the site, not download a PDF and leave. Keep them in the funnel.

### Why Option 2 Wins

| Factor | Single Page | Multi-Page (✅) | Hybrid |
|---|---|---|---|
| SEO per audience | ❌ One URL | ✅ Dedicated pages | ⚠️ Partial |
| First-load clarity | ❌ Requires toggle | ✅ Immediate relevance | ⚠️ Mixed |
| Maintenance burden | ✅ Low | ✅ Low (DRY content strategy) | ❌ High (HTML + PDFs) |
| Link sharing | ❌ Generic | ✅ Audience-specific | ⚠️ Partial |
| Conversion funnel | ❌ Diffuse | ✅ Audience-specific CTAs | ⚠️ Mixed |
| Analytics clarity | ❌ Hard to segment | ✅ Clean per-audience data | ⚠️ Partial |

**Multi-page is the clear winner for SEO, conversion, and long-term maintainability.** Shared content (curriculum overview, module list, pricing/access info) lives in reusable components — no duplication, just smart templating.

---

## Finalized Sitemap

```
openclaw-curriculum.com/
│
├── / (Homepage)
│   ├── Hero: "AI Literacy for the Next Generation"
│   ├── Audience nav cards → (homeschool / educators / school-boards / policy)
│   ├── What is OpenClaw Curriculum? (3-line pitch)
│   ├── Module overview (teaser: 7 modules, middle school)
│   ├── Social proof (quotes, school logos, usage stats)
│   └── CTA: Get Started / Download Syllabus
│
├── /educators (Classroom Teachers)
│   ├── Hero: "Ready-to-Teach AI Lessons for Grades 6–8"
│   ├── What's included (lesson plans, slide decks, labs, assessments)
│   ├── Module-by-module overview
│   ├── Standards alignment (AI4K12, CSTA, NGSS)
│   ├── "No coding required" emphasis
│   ├── Testimonials from teachers
│   └── CTA: Download Unit 1 Free / Request District License
│
├── /homeschool (Homeschool Families)
│   ├── Hero: "Self-Paced AI Curriculum Your Kid Will Love"
│   ├── How it works (parent-led or student-independent)
│   ├── Module overview with time estimates
│   ├── Sample lesson / demo activity
│   ├── FAQ (age range, prerequisites, time commitment)
│   ├── Testimonials from homeschool families
│   └── CTA: Start Module 1 Free / Full Curriculum Access
│
├── /school-boards (School Administrators & Districts)
│   ├── Hero: "Future-Ready AI Literacy at Scale"
│   ├── Why AI literacy now (stat-driven: workforce, equity, digital citizenship)
│   ├── Pilot program overview (minimal lift to launch)
│   ├── What districts get (teacher PD, admin dashboard, usage reports)
│   ├── Standards & compliance (FERPA, COPPA, state frameworks)
│   ├── District case studies / pilot results
│   └── CTA: Schedule a Demo / Request Pilot Proposal
│
├── /policy (Policy Makers & Researchers)
│   ├── Hero: "Evidence-Based AI Education for K-12"
│   ├── Curriculum framework overview (AI4K12 alignment)
│   ├── Research & citations (peer-reviewed backing)
│   ├── Equity considerations (access, bias, digital divide)
│   ├── State/federal alignment (ESSA, STEM education policy)
│   ├── Downloadable whitepaper / policy brief
│   └── CTA: Download Policy Brief / Contact for Partnership
│
├── /curriculum (Full Curriculum Overview — shared/SEO)
│   ├── All 7 modules listed with descriptions
│   ├── Scope & sequence chart
│   ├── Sample materials (free downloads)
│   └── Links to audience-specific pages
│
├── /about
│   ├── Mission & team
│   ├── OpenClaw project background
│   └── Contact
│
├── /blog (optional Phase 2)
│   └── AI education news, teacher spotlights, research
│
└── /get-started (conversion landing page)
    ├── Choose your path (audience selector)
    └── Redirect to audience-specific page or signup flow
```

---

## Notes & Implementation Guidance

### Shared Content Strategy
- **Module overview component** — reused across `/educators`, `/homeschool`, and `/curriculum`. Single source of truth; update once, reflects everywhere.
- **Testimonials** — tag by audience type. Each landing page pulls relevant quotes.
- **CTAs** — vary by audience (teacher wants "free unit," school board wants "demo," family wants "start now"). Don't use generic CTAs.

### SEO Priorities
Target keywords per page:
- `/educators` → "middle school AI lesson plans," "AI curriculum for teachers"
- `/homeschool` → "homeschool AI curriculum," "AI activities for middle schoolers"
- `/school-boards` → "K-12 AI literacy program," "district AI curriculum"
- `/policy` → "K-12 AI education policy," "AI literacy framework middle school"

### Phase 2 Additions (not blocking launch)
- `/blog` — teacher spotlights, AI news for educators
- PDF downloads per audience (whitepapers, printable guides) — add as assets, not core architecture
- Interactive module browser at `/curriculum`
- Teacher/parent dashboard post-signup

### Maintenance Burden Assessment
- **Low.** All audience pages share the same content infrastructure. Adding a new module means updating the module data once; all pages reflect it.
- **Risk:** Audience pages can drift out of sync if edited ad-hoc. Mitigation: keep audience-specific content to positioning/messaging only; factual curriculum content lives in shared components.

---

*Decision made by ClawDawg | Phase 1 — Decisions track*
