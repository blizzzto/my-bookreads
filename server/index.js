import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const app = express();
app.use(cors(), express.json());

const STATS = { charisma: '🗣️ Charisma', intelligence: '🧠 Intelligence', creativity: '🎨 Creativity', emotional: '💗 Emotional Intel.', discipline: '🎯 Discipline', wisdom: '🦉 Wisdom', empathy: '🤝 Empathy' };
const LEVELS = { Easy: 10, Medium: 25, Hard: 40, Expert: 80 };
const CATS = {
  Thriller: ['Psychological thriller', 'Crime & detective', 'Spy & espionage', 'Legal thriller'],
  Historical: ['Ancient history', 'World War II', 'Biography', 'Medieval'],
  Fiction: ['Main character dealing with grief', 'Coming of age', 'Fantasy', 'Sci-fi', 'Romance', 'Classic literature'],
  'Self-help': ['How to make friends', 'Habit forming', 'Confidence & mindset', 'Productivity', 'Money & wealth', 'Mindfulness'],
  Science: ['Psychology', 'Space', 'Technology', 'Nature'],
  Philosophy: ['Stoicism', 'Ethics', 'Meaning of life'],
};
const CAT_W = { Thriller: { intelligence: .5, discipline: .2, creativity: .3 }, Historical: { wisdom: .5, intelligence: .4, empathy: .1 }, Fiction: { creativity: .4, empathy: .3, emotional: .3 }, 'Self-help': { charisma: .3, discipline: .3, emotional: .2, wisdom: .2 }, Science: { intelligence: .7, creativity: .3 }, Philosophy: { wisdom: .6, intelligence: .2, emotional: .2 } };
// keywords (in Open Library subjects, title or author) that point to a category, used when there is no AI
const CAT_HINTS = {
  Thriller: ['thriller', 'suspense', 'mystery', 'detective', 'crime', 'espionage', 'spy '],
  Historical: ['histor', 'biograph', 'world war', 'medieval', 'civilization', 'memoir'],
  Fiction: ['fiction', 'fantasy', 'novel', 'romance', 'stories', 'fairy tales'],
  'Self-help': ['self-help', 'self help', 'personal growth', 'habit', 'success', 'self-actualization', 'motivation', 'productivity', 'mindfulness', 'finance', 'business', 'conduct of life', 'interpersonal relations'],
  Science: ['science', 'physics', 'astronomy', 'biology', 'psychology', 'technology', 'evolution', 'cosmology', 'mathematics', 'neuroscience', 'nature'],
  Philosophy: ['philosoph', 'stoic', 'ethics', 'metaphysics', 'existential', 'seneca', 'marcus aurelius', 'epictetus', 'plato', 'aristotle', 'socrates', 'nietzsche', 'kant', 'schopenhauer', 'spinoza', 'camus', 'confucius', 'lao tzu'],
};
const SUB_KEYS = { friend: 'charisma', confiden: 'charisma', habit: 'discipline', productiv: 'discipline', grief: 'emotional', mindful: 'emotional', fantasy: 'creativity', 'sci-fi': 'creativity', romance: 'empathy', stoic: 'wisdom', psychology: 'emotional', money: 'intelligence' };

// ---------- storage (data.json) ----------
const FILE = fileURLToPath(new URL('./data.json', import.meta.url));
const load = () => fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8'))
  : { goal: null, level: null, books: [], log: {}, stats: Object.fromEntries(Object.keys(STATS).map(k => [k, 0])) };
const save = s => fs.writeFileSync(FILE, JSON.stringify(s, null, 2));
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time

// ---------- AI + book data ----------
async function claude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 600, messages: [{ role: 'user', content: prompt + '\nRespond with ONLY valid JSON, no markdown.' }] }),
    });
    const d = await r.json();
    return JSON.parse(d.content[0].text.replace(/```json|```/g, '').trim());
  } catch (e) { console.warn('AI failed:', e.message); return null; }
}
async function olSearch(title, author) {
  try {
    const q = new URLSearchParams({ title, limit: 1, fields: 'title,author_name,number_of_pages_median,ratings_average,subject' });
    if (author) q.set('author', author);
    const d = await (await fetch('https://openlibrary.org/search.json?' + q)).json();
    return d.docs?.[0] || null;
  } catch { return null; }
}
// Title autocomplete: prefix search, most-read first, titles that start with the query on top
const suggestCache = new Map();
const plain = t => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function olSuggest(q) {
  const key = plain(q);
  if (key.length < 2) return [];
  if (suggestCache.has(key)) return suggestCache.get(key);
  const params = new URLSearchParams({ q: `title:(${key.split(' ').join(' AND ')}*)`, sort: 'readinglog', limit: 100, fields: 'title,author_name,number_of_pages_median' });
  const d = await (await fetch('https://openlibrary.org/search.json?' + params)).json();
  const rank = t => t.startsWith(key) ? 0 : (' ' + t).includes(' ' + key) ? 1 : 2;
  const seen = new Set();
  const out = (d.docs || [])
    .map(x => ({ title: x.title, author: x.author_name?.[0] || '', pages: x.number_of_pages_median || null, rank: rank(plain(x.title)) }))
    .filter(x => { const id = plain(x.title) + '|' + plain(x.author); return x.rank < 2 && !seen.has(id) && seen.add(id); })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 6)
    .map(({ rank, ...x }) => x);
  if (suggestCache.size > 500) suggestCache.clear();
  suggestCache.set(key, out);
  return out;
}
// Decide what a book is worth: which stats it trains (b.w, shares that sum to 1) and the points
// for reading all of it (b.total). Done once per book; pages then pay out a share of it as they are read.
// Best guess of category + subcategory without AI; null when nothing points anywhere
function guessCat(b, doc) {
  const subjects = (doc?.subject || []).slice(0, 40).join(' | ').toLowerCase().replace(/non-?fiction/g, '').replace(/science fiction/g, 'sci-fi fiction');
  const text = `${b.title} | ${b.author} | ${subjects}`.toLowerCase();
  const hits = c => CAT_HINTS[c].reduce((n, k) => n + text.split(k).length - 1, 0) * (c === 'Fiction' ? .5 : 1); // "fiction" is in thriller subjects too
  const cat = Object.keys(CAT_HINTS).sort((a, c) => hits(c) - hits(a))[0];
  if (!hits(cat)) return null;
  const sub = CATS[cat].find(x => text.includes(x.toLowerCase()) || Object.keys(SUB_KEYS).some(k => x.toLowerCase().includes(k) && text.includes(k))) || '';
  return { cat, sub };
}
async function scoreBook(b, doc) {
  doc ||= await olSearch(b.title, b.author);
  const rating = doc?.ratings_average || 3.8;
  const ai = await claude(`A reader is reading "${b.title}" by ${b.author} (${b.cat} / ${b.sub}, ~${b.pages} pages, community rating ${rating.toFixed(2)}/5). Decide the RPG stat points for reading the whole book (total 3-10, more for better rated/longer books) and how they are shared among: ${Object.keys(STATS).join(', ')}. JSON: {"total":7,"shares":{"charisma":0.4,"wisdom":0.6},"why":"short reason"}`);
  let w = {}, total = +ai?.total, why = ai?.why;
  for (const k in ai?.shares || {}) if (STATS[k] && ai.shares[k] > 0) w[k] = +ai.shares[k];
  if (!Object.keys(w).length || !(total > 0)) {
    w = { ...(CAT_W[b.cat] || { intelligence: .5, wisdom: .5 }) };
    const sub = (b.sub || '').toLowerCase();
    for (const k in SUB_KEYS) if (sub.includes(k)) w[SUB_KEYS[k]] = (w[SUB_KEYS[k]] || 0) + .6;
    total = Math.max(3, Math.round(rating * 1.4 + b.pages / 150));
    why = `Based on a ${rating.toFixed(1)}/5 community rating (Open Library).`;
  }
  const sum = Object.values(w).reduce((a, c) => a + c, 0);
  for (const k in w) w[k] = round(w[k] / sum);
  Object.assign(b, { rating, w, total: Math.min(10, total), why });
}
const round = n => Math.round(n * 1e4) / 1e4;
// Pay out the points for `pages` pages of a book (negative when progress is corrected down)
function award(s, b, pages) {
  const gained = {};
  b.gains ||= {};
  for (const k in b.w) {
    const p = b.w[k] * b.total * pages / b.pages;
    s.stats[k] = round(Math.max(0, (s.stats[k] || 0) + p));
    b.gains[k] = round(Math.max(0, (b.gains[k] || 0) + p));
    gained[k] = round(p);
  }
  return gained;
}
async function aiRecommend(b, read) {
  const ai = await claude(`Reader finished "${b.title}" by ${b.author} (${b.cat}/${b.sub}). Already read: ${JSON.stringify(read)}. Recommend ONE next book, same genre or same author. JSON: {"title":"","author":"","why":""}`);
  if (ai?.title) return ai;
  try {
    const d = await (await fetch('https://openlibrary.org/search.json?' + new URLSearchParams({ author: b.author, limit: 15, fields: 'title,author_name,ratings_average' }))).json();
    const c = (d.docs || []).filter(x => !read.some(t => t.toLowerCase() === x.title.toLowerCase())).sort((a, c) => (c.ratings_average || 0) - (a.ratings_average || 0))[0];
    if (c) return { title: c.title, author: c.author_name?.[0] || b.author, why: `Another book by ${b.author}.` };
    const s = await (await fetch('https://openlibrary.org/search.json?' + new URLSearchParams({ subject: (b.sub || b.cat).toLowerCase(), limit: 20, fields: 'title,author_name', sort: 'rating' }))).json();
    const c2 = (s.docs || []).find(x => !read.includes(x.title));
    if (c2) return { title: c2.title, author: c2.author_name?.[0] || '', why: `Popular in "${b.sub || b.cat}".` };
  } catch {}
  return { title: 'Ask a librarian!', author: '', why: 'Could not reach the book database.' };
}

// ---------- routes ----------
app.get('/api/state', (_, res) => res.json({ ...load(), meta: { STATS, LEVELS, CATS, ai: !!process.env.ANTHROPIC_API_KEY } }));

app.put('/api/settings', (req, res) => {
  const s = load(); s.level = req.body.level; s.goal = +req.body.goal; save(s); res.json({ ok: true });
});

app.get('/api/lookup', async (req, res) => res.json(await olSearch(req.query.title, req.query.author) || {}));

app.get('/api/suggest', async (req, res) => {
  try { res.json(await olSuggest(String(req.query.q || ''))); } catch { res.json([]); }
});

app.post('/api/books', async (req, res) => {
  const s = load();
  const b = { id: Date.now(), title: (req.body.title || '').trim(), author: (req.body.author || '').trim(), pages: +req.body.pages || 0, read: 0, cat: req.body.cat || '', sub: req.body.sub || '', notes: [], done: false };
  if (!b.title) return res.status(400).json({ error: 'Title required' });
  const d = await olSearch(b.title, b.author);
  b.pages ||= d?.number_of_pages_median || 300;
  b.author ||= d?.author_name?.[0] || '';
  b.read = Math.min(b.pages, Math.max(0, Math.round(+req.body.read) || 0)); // pages read before adding the book
  if (!b.cat) {
    const r = await claude(`Book: "${b.title}" by ${b.author}. Choose category from ${JSON.stringify(Object.keys(CATS))} and best subcategory (from ${JSON.stringify(CATS)} or your own). JSON: {"cat":"","sub":""}`);
    const g = r?.cat ? r : guessCat(b, d);
    b.cat = g?.cat || 'Fiction'; b.sub = g?.sub || '';
    b.guessed = !g; // nothing pointed to a category, the reader should pick one
  }
  await scoreBook(b, d);
  s.books.push(b); save(s); res.json(b);
});

// set the page you are on; the difference counts toward (or is taken back from) today's pages and points
app.put('/api/books/:id/progress', async (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id), p = Math.round(+req.body.read);
  if (!b || b.done || !(p >= 0)) return res.status(400).json({ error: 'Bad request' });
  if (p > b.pages) return res.status(400).json({ error: `This book has only ${b.pages} pages` });
  if (!b.w) await scoreBook(b);
  s.log[today()] = Math.max(0, (s.log[today()] || 0) + p - b.read);
  const gained = award(s, b, p - b.read);
  b.read = p;
  save(s); res.json({ ...b, gained });
});

// move a book to another category; its points are worked out again and what it already earned is re-shared
app.put('/api/books/:id/category', async (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id);
  if (!b || !CATS[req.body.cat]) return res.status(400).json({ error: 'Bad request' });
  b.cat = req.body.cat; b.sub = String(req.body.sub || ''); delete b.guessed;
  await scoreBook(b);
  const earned = Object.values(b.gains || {}).reduce((a, c) => a + c, 0);
  for (const k in b.gains) s.stats[k] = round(Math.max(0, (s.stats[k] || 0) - b.gains[k]));
  if (earned) { b.gains = {}; for (const k in b.w) { b.gains[k] = round(earned * b.w[k]); s.stats[k] = round((s.stats[k] || 0) + b.gains[k]); } }
  save(s); res.json(b);
});

// editions differ in length: set how many pages this copy has (pages still to read pay out at the new rate)
app.put('/api/books/:id/pages', (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id), p = Math.round(+req.body.pages);
  if (!b || b.done || !(p > 0)) return res.status(400).json({ error: 'Bad request' });
  b.pages = p; b.read = Math.min(b.read, p);
  save(s); res.json(b);
});

// drop a book you no longer want to read; pages and points it already gave you are kept
app.delete('/api/books/:id', (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id);
  if (!b || b.done) return res.status(400).json({ error: 'Bad request' });
  s.books = s.books.filter(x => x !== b);
  save(s); res.json({ ok: true });
});

app.post('/api/books/:id/notes', (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id);
  if (!b || !req.body.text?.trim()) return res.status(400).json({ error: 'Bad request' });
  b.notes.push({ t: req.body.text.trim(), p: req.body.page || '', d: new Date().toLocaleString() });
  save(s); res.json(b);
});

app.delete('/api/books/:id/notes/:i', (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id);
  if (!b?.notes[req.params.i]) return res.status(400).json({ error: 'Bad request' });
  b.notes.splice(req.params.i, 1);
  save(s); res.json(b);
});

app.post('/api/books/:id/finish', async (req, res) => {
  const s = load(), b = s.books.find(x => x.id == req.params.id);
  if (!b || b.done) return res.status(400).json({ error: 'Bad request' });
  if (!b.w) await scoreBook(b);
  const gained = award(s, b, b.pages - b.read); // pages not logged yet
  b.read = b.pages; b.done = true; b.doneAt = today();
  b.rec = await aiRecommend(b, s.books.map(x => x.title));
  save(s); res.json({ ...b, gained });
});

// ---------- website (built client) ----------
app.use(express.static(fileURLToPath(new URL('../client/dist', import.meta.url))));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Reading Quest running on http://localhost:${PORT}`);
  // addresses a phone on the same Wi-Fi can open
  for (const n of Object.values(os.networkInterfaces()).flat()) if (n.family === 'IPv4' && !n.internal) console.log(`On your phone (same Wi-Fi): http://${n.address}:${PORT}`);
});
