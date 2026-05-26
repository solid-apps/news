# news

An **RSS / Atom feed reader** for your [Solid](https://solidproject.org) pod.
Subscribe to feeds, read everything in one reverse-chron list, and save the good
ones to [`bookmarks`](https://github.com/solid-apps/bookmarks). Your
subscriptions live on your pod.

## What it does

- **Subscribe** to any RSS or Atom feed by URL (with one-click suggestions to
  start). Share a feed URL from another app via the intent bus and it lands here
  ready to subscribe (`"handles": ["url"]`).
- **Unified reading list** — all feeds merged, newest first, deduped by link,
  with per-feed filter chips, unread tracking, and "mark read".
- **Save** an article → hands the URL to `bookmarks` over the `url` intent.
  **Open ↗** reads it at the source.
- **Refresh** re-fetches; the last list is cached so it shows instantly on open.

## CORS — how feeds are fetched

Browsers block cross-origin feed fetches and most outlets don't send CORS
headers. `news` tries a **direct fetch first** (works for CORS-friendly feeds —
`plume` pods, some sites) and **falls back to a public CORS proxy**
(allorigins → corsproxy). To use your own proxy, set
`localStorage['news.proxy']` to a template containing `{url}`, e.g.
`https://my.proxy/?u={url}`. This proxy dependency is the one concession to the
no-server ethos; everything else is plain pod + browser.

## Subscriptions on your pod

Follows the low-friction utility pattern (cf. `weather`, `split`): kept in
`localStorage` and synced to your pod when signed in, so it works signed-out and
follows you across devices.

```
/public/news/feeds.jsonld
{ "@context": {"schema":"https://schema.org/"}, "@id":"#this",
  "@type":"schema:ItemList", "name":"News feeds",
  "schema:itemListElement":[ {"@type":"schema:DataFeed","schema:url":"…","schema:name":"…"} ] }
```

Read state stays in `localStorage` (not synced — it's device-local noise).

## Run

Static — open `index.html`, or install via the **store** to
`/public/apps/news/`.

AGPL-3.0-only.
