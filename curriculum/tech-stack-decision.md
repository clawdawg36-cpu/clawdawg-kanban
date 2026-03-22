# Tech Stack Decision — Static Site Generator vs Raw HTML

**Project:** OpenClaw AI Curriculum for Middle School  
**Decision Date:** 2026-03-22  
**Status:** Finalized ✅

---

## Decision: Eleventy (11ty)

**Switch from raw HTML to Eleventy.**

---

## Rationale

### The Problem with Raw HTML at This Scale

The sitemap decision locked us into a multi-page architecture: homepage + 4 audience landing pages (`/homeschool`, `/educators`, `/school-boards`, `/policy`), plus eventual module pages. That's **6–12+ HTML files** that all need the same nav, footer, and global CSS. Raw HTML means:

- Every nav change = edit every file manually (error-prone, annoying)
- No shared components = copy-paste drift
- No frontmatter = no programmatic SEO (title, meta description, OG tags per page)
- Still works fine on GitHub Pages, but becomes a maintenance burden fast

### Why Not the Others

| Option | Verdict | Reason |
|---|---|---|
| Raw HTML | ❌ Skip | Fine for 1–2 pages; painful at 6–12+ with shared nav/footer |
| **Eleventy (11ty)** | **✅ Chosen** | Lightweight, zero-config SSG, outputs plain HTML, GitHub Pages native, Nunjucks/Liquid templating, great DX |
| Astro | ⚠️ Overkill now | Component model is great but heavier build setup; worth revisiting if we add interactivity or React components |
| Next.js | ❌ Skip | Server-side features, Vercel-optimized — we don't need any of this; pure overhead for a static curriculum site |

### Why Eleventy Wins

- **Outputs plain HTML** — GitHub Pages serves it without any adapter or special config
- **Shared layouts** — one `base.njk` for nav + footer; all pages inherit it
- **Frontmatter for SEO** — each page sets its own `title`, `description`, `og:image` in YAML
- **No JS framework overhead** — zero client-side JS by default; curriculum content doesn't need it
- **Fast builds** — sub-second for a 10-page site
- **Low learning curve** — Nunjucks templating is readable; Mike or a contractor can edit content files without knowing Eleventy internals
- **PDF download links** — just link to `/downloads/syllabus.pdf`; Eleventy passthrough copies static assets as-is
- **Active ecosystem** — well-maintained, large community, good docs

---

## Setup Instructions

### Prerequisites

```bash
node -v  # needs Node 14+
```

### Initialize the Project

```bash
cd /Users/mike/Projects/kanban/curriculum  # or wherever the site lives
npm init -y
npm install --save-dev @11ty/eleventy
```

### Project Structure

```
curriculum-site/
├── .eleventy.js          # Eleventy config
├── package.json
├── src/
│   ├── _includes/
│   │   ├── base.njk      # shared layout (nav + footer)
│   │   └── page.njk      # content page wrapper
│   ├── _data/
│   │   └── nav.json      # nav links (single source of truth)
│   ├── index.njk         # Homepage
│   ├── educators.njk     # /educators
│   ├── homeschool.njk    # /homeschool
│   ├── school-boards.njk # /school-boards
│   ├── policy.njk        # /policy
│   └── downloads/        # PDFs passthrough
│       └── syllabus.pdf
└── _site/                # build output (gitignore this)
```

### `.eleventy.js` Config

```js
module.exports = function(eleventyConfig) {
  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/downloads");
  eleventyConfig.addPassthroughCopy("src/assets");

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
};
```

### Base Layout (`src/_includes/base.njk`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ title }} | OpenClaw AI Curriculum</title>
  <meta name="description" content="{{ description }}">
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <nav>
    <a href="/">Home</a>
    {% for item in nav %}
      <a href="{{ item.url }}">{{ item.label }}</a>
    {% endfor %}
  </nav>

  <main>
    {{ content | safe }}
  </main>

  <footer>
    <p>© 2026 OpenClaw AI Curriculum. <a href="/downloads/syllabus.pdf">Download Syllabus (PDF)</a></p>
  </footer>
</body>
</html>
```

### Nav Data (`src/_data/nav.json`)

```json
[
  { "url": "/educators", "label": "Educators" },
  { "url": "/homeschool", "label": "Homeschool" },
  { "url": "/school-boards", "label": "School Boards" },
  { "url": "/policy", "label": "Policy" }
]
```

### Example Page (`src/educators.njk`)

```njk
---
layout: base.njk
title: "For Educators"
description: "Ready-to-teach AI literacy lessons for grades 6–8 classroom teachers."
---

<h1>Ready-to-Teach AI Lessons for Grades 6–8</h1>
<p>Everything you need to bring AI literacy into your classroom...</p>
```

### Build & Preview

```bash
# Dev server with live reload
npx @11ty/eleventy --serve

# Production build
npx @11ty/eleventy
```

### GitHub Pages Deployment

Add to `package.json`:

```json
{
  "scripts": {
    "build": "eleventy",
    "start": "eleventy --serve"
  }
}
```

**Option A — GitHub Actions (recommended):**

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./_site
```

**Option B — Manual:**  
Run `npm run build`, then push `_site/` contents to `gh-pages` branch.

### `.gitignore` additions

```
_site/
node_modules/
```

---

## Migration Path from Raw HTML

1. `npm install --save-dev @11ty/eleventy`
2. Move existing HTML files into `src/`
3. Extract nav + footer into `src/_includes/base.njk`
4. Add YAML frontmatter to each page (`layout`, `title`, `description`)
5. Run `npx @11ty/eleventy --serve` and verify output
6. Set up GitHub Actions workflow
7. Done — zero raw HTML maintenance debt going forward

---

## Summary

| Factor | Decision |
|---|---|
| Tool | Eleventy (11ty) |
| Templating | Nunjucks |
| Hosting | GitHub Pages |
| Build | GitHub Actions on push to main |
| PDF downloads | Static passthrough (`src/downloads/`) |
| Migration effort | ~2–3 hours (extract shared layout, add frontmatter) |
