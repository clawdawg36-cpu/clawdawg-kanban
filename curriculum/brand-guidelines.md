# AI Explorers — Brand Guidelines
**Version:** 1.0 (Phase 1 Decisions)
**Last Updated:** 2026-03-21
**Status:** Draft ✅

---

## Overview

AI Explorers is the marketing-facing identity for the OpenClaw AI Curriculum. The brand must appeal simultaneously to:
- **Curious 10–14 year olds** who want to build, not just learn about, AI
- **Homeschool and distance-education families** who make purchasing decisions
- **Educators** looking for ready-to-teach classroom content
- **School boards and policy audiences** needing institutional credibility

The visual system is designed to hold all of these audiences without fracturing into incoherence. One brand, one spine — with audience-specific tonal flexion, not a separate design system per audience.

---

## 1. Brand Positioning (Visual North Star)

**The brand feeling:** *"A real lab, not a classroom."*

AI Explorers should feel like stepping into a slightly chaotic, deeply exciting maker space — the kind of place where experiments are in-progress, ideas are pinned to the wall, and someone just built something cool. Not a corporate training portal. Not a cheesy "kids learn coding!" site. Not dry academic standards documentation.

**Competitors we are NOT:**
- Code.org (broad, gamified, pixel-art nostalgia)
- AI4K12 (institutional, standards-forward, adult-only voice)
- Inspirit AI (prestige-exclusionary, cost-barrier, college-prep pressure)

**What we are:**
- Smart and direct, like a confident middle schooler who actually built the thing
- Warm but not condescending to either students or adults
- Dark-first (immersive, focused, premium) with purposeful light moments
- Evidence of real work: screenshots, project outputs, honest voices

---

## 2. Color Palette

### Design decision: Evolve the dark theme, don't abandon it

The dark-theme base is retained as the primary system. It signals:
- Focus and seriousness (this isn't a toy)
- Technical identity (developers, makers, builders live in dark mode)
- Premium quality vs. the pastel/bright primary-colors default of ed-tech

We add a **vibrant accent layer** to inject energy, differentiate audiences, and create visual hierarchy that doesn't feel clinical.

---

### Core Colors

| Token | Hex | Use |
|---|---|---|
| `--bg-base` | `#0D0F14` | Primary page background |
| `--bg-surface` | `#161B27` | Cards, panels, elevated surfaces |
| `--bg-border` | `#252D40` | Dividers, input borders, subtle lines |
| `--text-primary` | `#F0F4FF` | Body copy, headings |
| `--text-secondary` | `#8B9BC2` | Captions, metadata, supporting copy |
| `--text-muted` | `#4A5578` | Placeholder text, disabled states |

### Accent Colors

| Token | Hex | Name | Primary Use |
|---|---|---|---|
| `--accent-electric` | `#4F8FFF` | Electric Blue | Primary CTAs, links, brand hero |
| `--accent-pulse` | `#7C5CFC` | Pulse Purple | Module highlights, progress, milestones |
| `--accent-signal` | `#00D9B8` | Signal Teal | Success states, interactive hover, code output |
| `--accent-spark` | `#FF6B35` | Spark Orange | Alerts, badges, limited-availability tags |
| `--accent-glow` | `#FFD23F` | Glow Yellow | Highlights, "new" callouts, achievement moments |

### Gradient (hero/feature use only)

```
background: linear-gradient(135deg, #4F8FFF 0%, #7C5CFC 50%, #00D9B8 100%);
```

Use the gradient on: hero text highlights, illustration backgrounds, hero-section overlays. **Do not use on body copy or navigation.** The gradient should feel earned — a visual reward for the most important moments.

### Light Mode Variant (educator/policy pages)

For `/educators`, `/school-boards`, and `/policy` landing pages, a light-mode surface layer is available to signal institutional approachability:

| Token | Hex | Use |
|---|---|---|
| `--bg-base-light` | `#F7F9FF` | Light page background |
| `--bg-surface-light` | `#FFFFFF` | Cards, panels |
| `--bg-border-light` | `#DDE3F0` | Dividers |
| `--text-primary-light` | `#0D1326` | Headings, body |
| `--text-secondary-light` | `#4A5578` | Supporting copy |

Accent colors remain identical across both modes — the brand is still AI Explorers in a blazer, not a different brand.

**Rule:** Never full-light-mode on student-facing pages. Never full-dark-mode on policy pages. The homepage is dark. The `/educators` hero may use a light surface with a dark nav.

---

## 3. Typography

### Typefaces

| Role | Typeface | Weight(s) | Notes |
|---|---|---|---|
| **Display / Hero** | [Clash Display](https://www.fontshare.com/fonts/clash-display) | 600, 700 | Bold, geometric, modern — used for big headlines only. Free from Fontshare. |
| **Headings (H1–H4)** | [Inter](https://fonts.google.com/specimen/Inter) | 500, 600, 700 | Clean, highly legible, widely loved in dev/tech contexts. Google Fonts. |
| **Body / UI Text** | Inter | 400, 500 | Consistent with headings for simplicity. |
| **Code / Monospace** | [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | 400, 500 | Excellent readability, open source, built for code contexts. |

**Why these fonts:**
- Clash Display gives the hero moments distinctiveness without being quirky or immature
- Inter is the de facto standard for technical products — zero learning curve for the eye
- JetBrains Mono is what working developers and students actually use; it signals authenticity in code blocks and CLI examples

### Scale

```
--text-xs:   0.75rem   (12px)  — labels, tags, metadata
--text-sm:   0.875rem  (14px)  — captions, helper text
--text-base: 1rem      (16px)  — body copy
--text-lg:   1.125rem  (18px)  — lead/intro paragraphs
--text-xl:   1.25rem   (20px)  — card headings, H4
--text-2xl:  1.5rem    (24px)  — H3, section headings
--text-3xl:  1.875rem  (30px)  — H2, major section titles
--text-4xl:  2.25rem   (36px)  — H1, page titles
--text-5xl:  3rem      (48px)  — Hero sub-headline
--text-6xl:  3.75rem   (60px)  — Hero display (Clash Display)
--text-7xl:  4.5rem    (72px)  — Max hero size (Clash Display, mobile reduces to 5xl)
```

### Rules
- **Line height:** 1.6 for body; 1.2 for display/hero; 1.4 for headings
- **Max line length:** 70ch for body copy; do not let text span full-width containers
- **Letter spacing:** `-0.02em` on display/hero type; `0` on body; `0.06em` on small caps/labels
- **All caps:** Only for UI labels (e.g., `MODULE 3`), never for body or headlines

---

## 4. Illustration & Icon Style

### Decision: Line-art + spot color, with emoji accents

**Primary illustration style:** Clean technical line art with selective color fills using the accent palette. Think: circuit diagrams crossed with editorial tech illustration — precise but not sterile, expressive but not cartoonish.

**Why not:**
- **Flat fill / blob illustration** (Code.org, Code Academy) — too common in ed-tech, reads as juvenile
- **Photorealistic renders** — expensive, dates quickly, hard to make inclusive
- **Stock photo** — generic, kills brand distinctiveness
- **Pure emoji** — great for messaging, too casual for hero moments

**Why line art with spot color:**
- Scales from hero illustrations to small icons without style mismatch
- Works on both dark and light backgrounds
- Signals "technical product" without being cold
- Allows the accent color palette to do expressive work while keeping illustrations secondary to content

### Icon System

**Primary icon library:** [Phosphor Icons](https://phosphoricons.com/) (open source, MIT license)
- Use the **Regular** weight for UI/nav; **Bold** for featured/callout contexts
- Never mix Phosphor with other icon libraries on the same page

**Custom icons needed (asset list — see Section 7):**
- Module icons (7 custom illustrations, one per curriculum module)
- "Explorer" mascot variants (see Section 6)
- Social sharing assets

### Emoji Use

Emoji are permitted and encouraged in:
- Marketing copy and social content
- Module titles and callouts on student-facing pages
- Error states and achievement moments

Emoji are **not appropriate** in:
- Navigation
- Formal headings on educator/policy pages
- Legal, pricing, or terms content

---

## 5. Logo / Wordmark

### AI Explorers Wordmark

**Concept:** The wordmark combines two visual ideas — the technical precision of AI and the forward momentum of exploration.

**Wordmark spec:**
- **"AI"** set in Clash Display Bold, all caps, with the gradient applied as a text fill (`--accent-electric` → `--accent-pulse`)
- **"Explorers"** set in Clash Display 600, lowercase except initial cap, in `--text-primary` (`#F0F4FF`) on dark backgrounds or `--text-primary-light` on light
- A subtle **navigation arrow glyph** (→ or ↗) in `--accent-signal` placed after "Explorers" at approximately 0.5em size — optional usage, primarily for print/social

**Clearspace:** Minimum clearspace equal to the cap-height of the "A" on all sides.

**Minimum size:** 120px wide (digital); 1.5 inches wide (print)

**Forbidden uses:**
- Do not recolor the gradient — always electric blue → pulse purple
- Do not change the relative size of "AI" vs "Explorers"
- Do not place on a background with insufficient contrast (minimum 4.5:1)
- Do not add a drop shadow or outer glow

### Logomark (Icon-only variant)

A standalone logomark for favicons, app icons, and small contexts:

**Spec:** A stylized compass rose with one arm replaced by a neural network node connection line. Composed in the gradient. Circular bounding shape optional for app icon contexts.

*(Logomark requires custom vector execution — listed in asset list, Section 7.)*

---

## 6. Mascot / Character (Optional but Recommended)

**Decision: Proceed with a mascot, student-facing pages only**

**Character:** "Patch" — a small robot companion with a visible processing LED array on its chest (shows "thinking" states), a rounded form factor (approachable, not intimidating), and interchangeable expression panels.

**Why a mascot:**
- Creates a consistent friendly presence across the 7-module journey
- Gives the brand something distinctive that competitors uniformly lack
- Enables micro-animations (loading states, success moments) without full custom illustration per-instance
- Students in our personas (curious 10–14 year olds) respond well to a non-human guide that doesn't feel like a teacher

**Why not on educator/policy pages:**
- A mascot on a school board landing page signals "this is for kids," which undercuts the institutional credibility we're building for adult decision-makers
- Educators should see professionalism; Patch should not be in their hero

**Patch visual spec:**
- Line art primary; single accent color fill (uses `--accent-signal` teal as primary glow)
- Expressions: neutral, thinking, excited, confused, celebratory
- Format: SVG with CSS-animatable elements for the LED array

*(Patch requires custom illustration — listed in Section 7.)*

---

## 7. Audience Visual Tiers

### One brand, two modes

| Page/Context | Mode | Mascot | Emoji in copy | Gradient usage |
|---|---|---|---|---|
| Homepage | Dark | No (hero), Yes (footer) | Limited | Yes (hero) |
| `/homeschool` | Dark | Yes | Yes | Yes |
| `/students` (direct) | Dark | Yes | Yes | Yes |
| `/educators` | Light-surface + dark nav | No | Minimal | No |
| `/school-boards` | Light-surface + dark nav | No | None | No (use Electric Blue flat) |
| `/policy` | Light-surface + dark nav | No | None | No |

**The rule:** The core color tokens, typography, and iconography are **identical across all pages.** The differences are:
1. Light vs. dark surface layer
2. Mascot presence/absence
3. Emoji density
4. Gradient vs. flat accent for hero moments

This is not a "two design systems" situation. It's one design system with an audience dial.

---

## 8. Motion & Interaction Principles

- **Prefer CSS transitions** over JavaScript-heavy animations for performance
- **Duration tokens:**
  - `--duration-fast: 100ms` — hover states, toggles
  - `--duration-normal: 200ms` — panel opens, accordion
  - `--duration-slow: 350ms` — page transitions, hero entrances
- **Easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (spring-like) for UI interactions; `ease-out` for content entrance
- **Reduced motion:** Respect `prefers-reduced-motion: reduce` — all non-essential animations must disable or simplify
- **Avoid:** Infinite loops, continuous particle effects, anything that competes with reading

---

## 9. Voice & Visual Tone (Interaction)

These aren't copy guidelines (see Message Matrix) but design choices that reinforce voice:

- **Error states:** Human, not mechanical. ("That didn't work — try again?" vs. "Error: 422")
- **Empty states:** Show an opportunity, not a void. Patch (on student pages) or a brief directional message on educator pages.
- **Loading states:** Pulse animation on the LED array (Patch) for student pages; simple `--accent-electric` progress bar on educator/policy pages.
- **Achievement moments:** Confetti burst using the full accent palette — reserved for module completions only. Don't cheapen it.

---

## 10. Asset List (Required for Launch)

### Priority 1 — Blocking (needed before any page ships)

| Asset | Description | Format | Notes |
|---|---|---|---|
| AI Explorers wordmark (dark bg) | Full wordmark, dark background variant | SVG | Gradient "AI" + white "Explorers" |
| AI Explorers wordmark (light bg) | Full wordmark, light background variant | SVG | Gradient "AI" + dark "Explorers" |
| Logomark (full color) | Compass/neural node icon | SVG | For favicon, app icon, social avatar |
| Logomark (monochrome) | Single-color version | SVG | For embroidery, dark bg without gradient |
| OG/social default image | 1200×630 hero card | PNG | Dark bg, wordmark, tagline |
| Favicon set | `.ico`, 16/32/48/180/192/512px PNGs | Multi | Generated from logomark SVG |

### Priority 2 — Module Icons (needed before curriculum pages ship)

| Asset | Description | Format |
|---|---|---|
| Module 1 icon | "What is AI?" — brain/circuit concept | SVG |
| Module 2 icon | "How AI Learns" — training/data concept | SVG |
| Module 3 icon | "AI & Language" — text/NLP concept | SVG |
| Module 4 icon | "AI & Vision" — camera/image concept | SVG |
| Module 5 icon | "AI Ethics" — scale/fairness concept | SVG |
| Module 6 icon | "Building with AI" — wrench/builder concept | SVG |
| Module 7 icon | "AI & Your Future" — path/horizon concept | SVG |

### Priority 3 — Mascot (needed before student-facing pages ship)

| Asset | Description | Format |
|---|---|---|
| Patch — neutral | Default standing pose | SVG |
| Patch — thinking | LED array pulsing, thoughtful expression | SVG |
| Patch — excited | Arms up, full LED glow | SVG |
| Patch — confused | Question mark display | SVG |
| Patch — celebratory | Confetti, star burst | SVG |
| Patch animation spec | LED array CSS animation guide | MD/CSS |

### Priority 4 — Marketing Illustrations (needed for homepage/landing pages)

| Asset | Description | Format |
|---|---|---|
| Hero illustration | Student at a workstation building something with AI elements | SVG |
| Educators hero illustration | Teacher viewing student work on a screen | SVG |
| Community illustration | Group of diverse students collaborating | SVG |
| Social sharing cards × 5 | Audience-specific OG cards | PNG |

### Priority 5 — Component-Level (can phase in post-launch)

| Asset | Description | Format |
|---|---|---|
| Pattern / texture | Subtle circuit/grid background for hero sections | SVG |
| Gradient mesh | Ambient glow background for dark-mode hero | CSS/SVG |
| Empty state illustrations × 3 | Dashboard, search results, error page | SVG |

---

## 11. Design Files & Tools

- **Primary design tool:** Figma
- **File structure:**
  - `AI Explorers / 00-Tokens` — color, typography, spacing tokens as Figma variables
  - `AI Explorers / 01-Foundations` — logo, wordmark, type specimens
  - `AI Explorers / 02-Components` — button, card, nav, module tile, badge
  - `AI Explorers / 03-Pages` — homepage, /educators, /homeschool, /school-boards
  - `AI Explorers / 04-Assets` — exported icons, illustrations, mascot states
- **Source of truth for tokens:** Figma variables export → CSS custom properties in `tokens.css`
- **Icon source:** Phosphor Icons NPM package (not manual SVG imports)
- **Font loading:** Google Fonts (Inter) + Fontshare CDN (Clash Display) + local fallback system stack

---

## Appendix A: Color Contrast Reference

| Combo | Ratio | WCAG Level | Use |
|---|---|---|---|
| `--text-primary` on `--bg-base` | 14.5:1 | AAA | ✅ All text |
| `--text-secondary` on `--bg-base` | 4.8:1 | AA | ✅ Body/captions |
| `--accent-electric` on `--bg-base` | 5.2:1 | AA | ✅ Links, CTAs |
| `--accent-signal` on `--bg-base` | 8.1:1 | AAA | ✅ Hover states |
| `--accent-spark` on `--bg-base` | 4.6:1 | AA | ✅ Badges |
| `--accent-glow` on `--bg-base` | 9.3:1 | AAA | ✅ Highlights |
| `--text-muted` on `--bg-base` | 2.1:1 | Fail | ⚠️ Decorative only |

*Contrast ratios are approximate pending final color validation in Figma. All body text must meet AA minimum. Interactive elements must meet AA. Decorative elements are exempt.*

---

## Appendix B: Out-of-Scope for v1.0

The following are intentionally deferred:

- **Animation library** (Lottie/Rive files for Patch) — Phase 2
- **Print/physical design** (workbooks, poster templates) — Phase 2
- **Video brand identity** (intro/outro bumpers, YouTube thumbnails) — Phase 2
- **Dark mode toggle** on educator pages — Phase 2 (v1.0 educator pages are light-surface-only)
- **Accessibility audit** (formal WCAG 2.1 AA audit by third party) — pre-launch milestone, not brand deliverable
