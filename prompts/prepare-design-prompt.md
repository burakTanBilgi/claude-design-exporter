Package the HTML design I'm sharing into a **self-contained, import-ready folder** for the
Claude Design Exporter, which renders fixed-size HTML "slides" to images and PDF **offline** — so
every dependency must live inside the folder, referenced by paths relative to the `.html` itself.
There is no safety net: missing fonts, images, or sizes fail **silently** (tofu, blank, or wrong
dimensions), so build for that.

Deliver the result as a **.zip of one folder**, shaped like:

```
my-design/
  index.html
  styles.css
  fonts/    fonts.css + *.woff2   (include the latin-ext subset)
  assets/   *.png | *.jpg         (every image, downloaded, high-res)
```

The folder must contain at least one `.html` file, and every file must keep its parent-folder path
(import the whole folder, never loose files or a lone `.html`).

Requirements:

1. **Slides & artboard (most important)** — every slide must be a sibling element whose class is
   **literally `slide`** (or all **literally `post`** — pick one, never mix the two; no other name
   like `.card`/`section` is recognized, or the whole deck silently collapses into a single image).
   On that slide's rule, set `width` and `height` as **literal 3–4 digit px in the same rule**, e.g.
   `width:1080px; height:1350px` — not `%`, `vw/vh`, `calc()`, `var()`, `em/rem`, or HTML
   attributes; anything else silently falls back to 1080×1350. This rule may live inline or in a
   directly-linked stylesheet (e.g. `styles.css`), but keep it (and `@font-face` rules) **within ~2
   CSS levels** of the HTML — avoid deep `@import` chains, which the detector can't follow. Each
   sibling becomes one page, output in **DOM order** (slide-1..slide-N top-to-bottom). A single-screen
   design may omit slides entirely — the whole page is then captured once, anchored at the top-left
   origin, but its container still needs the literal px size. Don't rely on a `transform: scale()`
   preview; the exporter resets it.
2. **Static, final-state render** — all content must be present in the initial HTML and look correct
   with no JavaScript and no animation. The exporter waits only for fonts and images after load, then
   strips every animation/transition and never clicks, scrolls, or hovers. So: no JS-injected/
   framework-hydrated content, nothing revealed on interaction or timers, and no element that starts
   at `opacity:0` / off-position expecting an animation to bring it in.
3. **Self-host fonts** — replace all Google Fonts / CDN `@import` and `<link>` tags with local
   `.woff2` + a local `fonts.css`, including **icon fonts**. For each family, ship the **latin-ext**
   `.woff2` and an `@font-face` whose `src` points to it with the original `unicode-range`, so Turkish
   glyphs (İ Ğ Ş Ç Ö Ü ı) render instead of tofu. Declare fonts in CSS, never inject them via JS.
4. **Localize images & refs** — download every remote image (e.g. `googleusercontent.com` Drive
   links) into `assets/` at high res, and rewrite each `src` / `srcset` / CSS `url()`
   (including `background-image`) and SVG ref to a local path. Use eager `<img>` (no `loading="lazy"`,
   no JS-injected images). Bake any video/canvas/WebGL visual into a static image. Every relative ref
   must resolve from the `.html`'s own directory with **exact filename casing** (Linux is
   case-sensitive); no leading-slash (`/foo.css`) or absolute paths. Keep any path that already
   resolves; rewrite the rest.
5. **Authoring chrome** — any nav, toolbar, control panel, page counter, or watermark must use the
   class `nav` or id `tw-root` (the only selectors the exporter removes), or be absent. Anything
   else is captured into every image.

Never: inline assets as `data:` URIs · leave any network reference (`fonts.googleapis.com`,
`fonts.gstatic.com`, `googleusercontent.com`, any `http(s)://` or protocol-relative `//`) · ship a
single bundled or lone `.html` with no folder · exceed 80 MB per file or 400 files total.

Before delivering, audit the files you're shipping and confirm: (a) **zero** `http(s)://`, `//`, or
`data:` in any `href`/`src`/`srcset`/`url()`/`@import`; (b) every relative ref points to a file that
exists in the tree, relative to the `.html`, with correct `../` depth and exact casing; (c) the slide
class is exactly `slide` or `post` (never both, never another) and its rule sets width and height as
3–4 digit px together; (d) each `@font-face` has a local `.woff2` `src` and a latin-ext
`unicode-range`; (e) no `loading="lazy"`, no JS-rendered content, no `<video>`/`<canvas>`, and no
chrome outside `.nav`/`#tw-root`. Then **list every file you created** with its relative path.
