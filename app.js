// news — solid-apps/news
//
// A feed reader (RSS / Atom) for your pod. Subscribe to feeds, read a unified
// reverse-chron list, save articles to `bookmarks` via the intent bus.
//
// CORS reality: browsers block cross-origin feed fetches and most outlets don't
// send CORS headers. So fetchFeed tries a DIRECT fetch first (works for
// CORS-friendly feeds — plume pods, some sites) and falls back to a public CORS
// proxy. The proxy is configurable (localStorage `news.proxy`) so you can point
// at your own.
//
// Subscriptions follow the low-friction utility pattern (see weather/split):
// kept in localStorage and synced to /public/news/feeds.jsonld when signed in,
// so the app works signed-out and persists across devices when signed in.

const appEl = document.getElementById('app')
const FEEDS_DOC = new URL('../../../public/news/feeds.jsonld', location.href)
const FEEDS_CONTAINER = new URL('../../../public/news/', location.href)
const LS_FEEDS = 'news.feeds', LS_READ = 'news.read', LS_ITEMS = 'news.items', LS_PROXY = 'news.proxy'

const authFetch = (url, opts) => ((window.xlogin && window.xlogin.authFetch) || fetch)(url, opts)
const loggedIn = () => !!(window.xlogin && window.xlogin.id)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const SUGGESTED = [
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed' }
]
// Direct first, then proxies. Each is a function: feedUrl → fetchable URL.
const PROXIES = [
  (u) => u,
  (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u)
]
function proxyChain() {
  const custom = localStorage.getItem(LS_PROXY)
  if (custom) return [(u) => u, (u) => custom.replace('{url}', encodeURIComponent(u))]
  return PROXIES
}

const state = { feeds: [], items: [], read: new Set(), filter: 'all', loading: false, adding: '' }

// --- persistence (localStorage + pod sync) ---
function loadLocal() {
  try { state.feeds = JSON.parse(localStorage.getItem(LS_FEEDS) || '[]') } catch { state.feeds = [] }
  try { state.read = new Set(JSON.parse(localStorage.getItem(LS_READ) || '[]')) } catch { state.read = new Set() }
  try { state.items = JSON.parse(localStorage.getItem(LS_ITEMS) || '[]') } catch { state.items = [] }
}
function saveLocal() {
  localStorage.setItem(LS_FEEDS, JSON.stringify(state.feeds))
  localStorage.setItem(LS_READ, JSON.stringify([...state.read].slice(-1000)))
  localStorage.setItem(LS_ITEMS, JSON.stringify(state.items.slice(0, 300)))
}
async function loadFromPod() {
  if (!loggedIn()) return
  try {
    const r = await authFetch(FEEDS_DOC, { headers: { Accept: 'application/ld+json' } })
    if (!r.ok) return
    const doc = await r.json()
    const els = doc['schema:itemListElement'] || doc.itemListElement || []
    const podFeeds = (Array.isArray(els) ? els : [els]).map((e) => ({
      url: e['schema:url'] || e.url || (typeof e === 'string' ? e : ''),
      name: e['schema:name'] || e.name || ''
    })).filter((f) => f.url)
    // union by url (local ∪ pod)
    const byUrl = new Map(state.feeds.map((f) => [f.url, f]))
    podFeeds.forEach((f) => { if (!byUrl.has(f.url)) byUrl.set(f.url, f) })
    state.feeds = [...byUrl.values()]
    saveLocal()
  } catch { /* offline / no doc */ }
}
async function syncToPod() {
  if (!loggedIn()) return
  const doc = {
    '@context': { schema: 'https://schema.org/' },
    '@id': '#this', '@type': 'schema:ItemList', name: 'News feeds',
    'schema:itemListElement': state.feeds.map((f) => ({ '@type': 'schema:DataFeed', 'schema:url': f.url, 'schema:name': f.name || '' }))
  }
  const put = () => authFetch(FEEDS_DOC, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify(doc, null, 2) })
  let r = await put().catch(() => null)
  if (r && !r.ok && (r.status === 404 || r.status === 409)) {
    await authFetch(FEEDS_CONTAINER, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: '' }).catch(() => {})
    await put().catch(() => {})
  }
}

// --- fetch + parse ---
async function fetchFeed(url) {
  let lastErr
  for (const make of proxyChain()) {
    try {
      const r = await fetch(make(url), { redirect: 'follow' })
      if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue }
      const text = await r.text()
      if (text && /<(rss|feed|rdf)[\s>:]/i.test(text)) return text
      lastErr = new Error('not a feed')
    } catch (e) { lastErr = e }
  }
  throw lastErr || new Error('fetch failed')
}
const xtext = (el) => (el && el.textContent || '').trim()
function stripHtml(s, n = 220) {
  const d = document.createElement('div'); d.innerHTML = s || ''
  let t = (d.textContent || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
function parseFeed(xml, feedUrl, feedName) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) return []
  const source = feedName || xtext(doc.querySelector('channel > title')) || xtext(doc.querySelector('feed > title')) || hostOf(feedUrl)
  const out = []
  // RSS / RDF <item>
  doc.querySelectorAll('item').forEach((it) => {
    out.push(item(source, feedUrl,
      xtext(it.querySelector('title')),
      xtext(it.querySelector('link')) || xtext(it.querySelector('guid')),
      xtext(it.querySelector('pubDate')) || xtext(it.querySelector('date')) || xtext(it.querySelector('published')),
      xtext(it.querySelector('description')) || xtext(it.querySelector('encoded'))))
  })
  // Atom <entry>
  doc.querySelectorAll('entry').forEach((en) => {
    const linkEl = en.querySelector('link[rel="alternate"]') || en.querySelector('link')
    out.push(item(source, feedUrl,
      xtext(en.querySelector('title')),
      (linkEl && linkEl.getAttribute('href')) || xtext(en.querySelector('id')),
      xtext(en.querySelector('updated')) || xtext(en.querySelector('published')),
      xtext(en.querySelector('summary')) || xtext(en.querySelector('content'))))
  })
  return out.filter((i) => i.link && i.title)
}
function item(source, feedUrl, title, link, date, summary) {
  const t = Date.parse(date)
  return { source, feedUrl, title, link: link.trim(), ts: isNaN(t) ? 0 : t, summary: stripHtml(summary) }
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

async function refreshAll() {
  if (!state.feeds.length) { state.items = []; render(); return }
  state.loading = true; render()
  const all = []
  await Promise.all(state.feeds.map(async (f) => {
    try { const xml = await fetchFeed(f.url); all.push(...parseFeed(xml, f.url, f.name)) }
    catch (e) { console.warn('feed failed', f.url, e.message) }
  }))
  // dedupe by link, newest first
  const byLink = new Map()
  for (const it of all) if (!byLink.has(it.link)) byLink.set(it.link, it)
  state.items = [...byLink.values()].sort((a, b) => b.ts - a.ts).slice(0, 300)
  state.loading = false
  saveLocal()
  render()
}

// --- actions ---
async function addFeed(url, name) {
  url = (url || '').trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  if (state.feeds.some((f) => f.url === url)) { toast('Already subscribed'); return }
  state.adding = url; render()
  try {
    const xml = await fetchFeed(url)
    const items = parseFeed(xml, url, name)
    if (!items.length) throw new Error('no items found — is that a feed URL?')
    const auto = xtext(new DOMParser().parseFromString(xml, 'application/xml').querySelector('channel > title, feed > title'))
    state.feeds.push({ url, name: name || auto || hostOf(url) })
    saveLocal(); syncToPod()
    toast('Subscribed')
  } catch (e) { toast("Couldn't add: " + e.message) }
  state.adding = ''
  await refreshAll()
}
function removeFeed(url) {
  state.feeds = state.feeds.filter((f) => f.url !== url)
  state.items = state.items.filter((i) => i.feedUrl !== url)
  if (state.filter === url) state.filter = 'all'
  saveLocal(); syncToPod(); render()
}
function markRead(link) { state.read.add(link); saveLocal() }
function markAllRead() { visibleItems().forEach((i) => state.read.add(i.link)); saveLocal(); render() }
function visibleItems() { return state.filter === 'all' ? state.items : state.items.filter((i) => i.feedUrl === state.filter) }

// --- UI ---
function toast(msg, ms = 2800) { const el = document.getElementById('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, ms) }
const when = (ts) => { if (!ts) return ''; const d = new Date(ts), now = Date.now(), diff = (now - ts) / 1000; if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + 'm'; if (diff < 86400) return Math.round(diff / 3600) + 'h'; if (diff < 604800) return Math.round(diff / 86400) + 'd'; return d.toLocaleDateString() }

function render() {
  if (!state.feeds.length && !state.adding) { appEl.innerHTML = emptyState(); wireEmpty(); return }

  const items = visibleItems()
  const unread = items.filter((i) => !state.read.has(i.link)).length
  const chips = `<button class="chip ${state.filter === 'all' ? 'on' : ''}" data-f="all">All</button>` +
    state.feeds.map((f) => `<button class="chip ${state.filter === f.url ? 'on' : ''}" data-f="${esc(f.url)}">${esc(f.name || hostOf(f.url))}</button>`).join('')

  appEl.innerHTML = `
    <form id="addbar" class="addbar">
      <input id="addurl" placeholder="Add a feed URL (RSS/Atom)…" autocomplete="off" value="${esc(state.adding)}">
      <button class="go" id="addbtn" type="submit" ${state.adding ? 'disabled' : ''}>${state.adding ? 'Adding…' : 'Add'}</button>
    </form>
    <div class="chips">${chips}</div>
    <div class="bar">
      <span class="muted">${state.loading ? 'Refreshing…' : `${items.length} article${items.length === 1 ? '' : 's'}${unread ? ` · ${unread} unread` : ''}`}</span>
      <span class="spacer"></span>
      ${unread ? `<button class="mini" id="markall">Mark read</button>` : ''}
      ${state.filter !== 'all' ? `<button class="mini" id="unsub">Unsubscribe</button>` : ''}
      <button class="mini" id="refresh" ${state.loading ? 'disabled' : ''}>↻ Refresh</button>
    </div>
    ${items.length ? `<div class="list">${items.map(rowHtml).join('')}</div>`
      : `<div class="card muted">${state.loading ? 'Loading…' : 'No articles. Try Refresh, or add another feed.'}</div>`}
  `
  wire()
}

function emptyState() {
  return `<div class="card welcome">
    <h2>Your news, on your pod</h2>
    <p>Subscribe to any RSS or Atom feed. Articles aggregate into one reading list;
       save the good ones to <b>bookmarks</b>. Your subscriptions sync to your pod
       when you're signed in.</p>
    <form id="addbar" class="addbar"><input id="addurl" placeholder="Paste a feed URL…" autocomplete="off">
      <button class="go" id="addbtn" type="submit">Add</button></form>
    <p class="muted" style="margin:.9rem 0 .3rem">Or start with:</p>
    <div class="suggest">${SUGGESTED.map((s) => `<button class="chip" data-add="${esc(s.url)}" data-name="${esc(s.name)}">+ ${esc(s.name)}</button>`).join('')}</div>
    <p class="hint muted">Feeds that don't allow cross-origin access are fetched via a public CORS proxy.</p>
  </div>`
}

function rowHtml(i) {
  const unread = !state.read.has(i.link)
  return `<div class="art ${unread ? 'unread' : ''}" data-link="${esc(i.link)}">
    <div class="art-head"><span class="src">${esc(i.source)}</span><span class="time muted">${esc(when(i.ts))}</span></div>
    <a class="title" href="${esc(i.link)}" target="_blank" rel="noopener" data-open="${esc(i.link)}">${esc(i.title)}</a>
    ${i.summary ? `<div class="snippet">${esc(i.summary)}</div>` : ''}
    <div class="art-actions">
      <a class="mini" href="${esc(i.link)}" target="_blank" rel="noopener" data-open="${esc(i.link)}">Open ↗</a>
      <button class="mini" data-save="${esc(i.link)}">Save</button>
    </div>
  </div>`
}

function wireEmpty() {
  const f = document.getElementById('addbar')
  if (f) f.onsubmit = (e) => { e.preventDefault(); addFeed(document.getElementById('addurl').value) }
  appEl.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => addFeed(b.dataset.add, b.dataset.name))
}
function wire() {
  const f = document.getElementById('addbar')
  if (f) f.onsubmit = (e) => { e.preventDefault(); addFeed(document.getElementById('addurl').value) }
  appEl.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { state.filter = b.dataset.f; render() })
  const r = document.getElementById('refresh'); if (r) r.onclick = refreshAll
  const ma = document.getElementById('markall'); if (ma) ma.onclick = markAllRead
  const un = document.getElementById('unsub'); if (un) un.onclick = () => { if (confirm('Unsubscribe from this feed?')) removeFeed(state.filter) }
  appEl.querySelectorAll('[data-open]').forEach((a) => a.addEventListener('click', () => markRead(a.dataset.open)))
  appEl.querySelectorAll('[data-save]').forEach((b) => b.onclick = (e) => {
    e.preventDefault()
    const it = state.items.find((i) => i.link === b.dataset.save)
    if (window.intent && window.intent.open) { window.intent.open('url', b.dataset.save, it ? it.title : ''); markRead(b.dataset.save) }
    else toast('Install bookmarks to save articles.')
  })
}

// --- init ---
async function boot() {
  loadLocal()
  render()
  await loadFromPod()
  await refreshAll()
}
document.addEventListener('xlogin', async () => { await loadFromPod(); render(); refreshAll() })
document.addEventListener('xlogout', () => { /* keep localStorage view */ render() })

// inbound url intent → prefill subscribe
const inIntent = window.intent && window.intent.receive && window.intent.receive()
if (inIntent && inIntent.type === 'url' && inIntent.value) { loadLocal(); addFeed(inIntent.value) }
else boot()
