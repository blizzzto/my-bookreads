import { useEffect, useRef, useState } from 'react';

const api = async (url, method = 'GET', body) => {
  const r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    .catch(() => { throw new Error('Cannot reach the server. Is it running?'); });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
};

const day = d => d.toLocaleDateString('sv'); // YYYY-MM-DD in local time
const today = () => day(new Date());
const num = n => +(+n || 0).toFixed(2);
// "+0.26 🗣️ Charisma, +0.17 🦉 Wisdom"
const gainsText = (g, meta) => Object.entries(g || {}).filter(([, v]) => num(v))
  .map(([k, v]) => `${v > 0 ? '+' : ''}${num(v)} ${meta.STATS[k] || k}`).join(', ');
// reading list split into one block per category: [['Science', [book]], ['Philosophy', [book, book]]]
const blocks = books => Object.entries(books.reduce((m, b) => ({ ...m, [b.cat]: [...(m[b.cat] || []), b] }), {}));

export default function App() {
  const [S, setS] = useState(null);
  const [view, setView] = useState('home');
  const [openId, setOpenId] = useState(null);
  const [toast, setToast] = useState('');

  const timer = useRef();
  const refresh = () => api('/state').then(setS);
  const say = m => { setToast(m); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(''), 5000); };
  useEffect(() => {
    refresh();
    // any failed request ends up here and is shown as a toast
    const onFail = e => { e.preventDefault(); say('⚠️ ' + (e.reason?.message || 'Something went wrong')); };
    window.addEventListener('unhandledrejection', onFail);
    return () => window.removeEventListener('unhandledrejection', onFail);
  }, []);
  const go = (v, id = null) => { setView(v); setOpenId(id); };

  if (!S) return <main><p>{toast || 'Loading…'}</p></main>;
  const { meta } = S;
  const props = { S, meta, go, refresh, say };

  if (!S.goal) return <Shell view="setup" go={go}><Setup {...props} /></Shell>;

  const pages = { home: Home, archive: Archive, stats: Stats, settings: Settings, book: Book };
  const Page = pages[view] || Home;
  return (
    <Shell view={view} go={go}>
      <Page {...props} openId={openId} />
      {toast && <div className="toast">{toast}</div>}
    </Shell>
  );
}

function Shell({ view, go, children }) {
  const items = [['home', 'Reading'], ['archive', 'Archive'], ['stats', 'Stats'], ['settings', 'Settings']];
  return (
    <>
      <header><h1>📚 Reading Quest</h1><div className="mute">Read. Level up. Repeat.</div></header>
      <nav>{items.map(([v, l]) => <button key={v} className={view === v ? 'on' : 'alt'} onClick={() => go(v)}>{l}</button>)}</nav>
      <main>{children}</main>
    </>
  );
}

function Setup({ meta, refresh }) {
  const [custom, setCustom] = useState('');
  const set = async (level, goal) => { await api('/settings', 'PUT', { level, goal }); refresh(); };
  return (
    <div className="card">
      <h2>Choose your difficulty</h2>
      <p className="mute">How many pages will you read each day?</p>
      <div className="row">
        {Object.entries(meta.LEVELS).map(([n, p]) => <button key={n} onClick={() => set(n, p)}>{n}<br />{p} pages/day</button>)}
      </div>
      <p>Custom: <input type="number" min="1" value={custom} onChange={e => setCustom(e.target.value)} placeholder="pages per day" />
        <button onClick={() => +custom > 0 && set('Custom', +custom)}>Set</button></p>
    </div>
  );
}

function streak(log, goal) {
  let n = 0; const d = new Date();
  if (!((log[today()] || 0) >= goal)) d.setDate(d.getDate() - 1);
  while ((log[day(d)] || 0) >= goal) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function Home(props) {
  const { S, go } = props;
  const [adding, setAdding] = useState(false);
  const done = S.log[today()] || 0;
  return (
    <>
      <div className="card">
        <h2>Today · {S.level} ({S.goal} pages)</h2>
        <div className="bar"><i style={{ width: Math.min(100, done / S.goal * 100) + '%' }} /></div>
        <p>{done} / {S.goal} pages {done >= S.goal && '✅ Goal reached!'} · 🔥 Streak: {streak(S.log, S.goal)} day(s)</p>
      </div>
      <Library S={S} go={go} />
      <button className="wide" onClick={() => setAdding(true)}>+ Add a book</button>
      {adding && <Add {...props} close={() => setAdding(false)} />}
    </>
  );
}

// full-screen pop-up
function Add({ meta, go, refresh, say, close }) {
  const [f, setF] = useState({ title: '', author: '', pages: '', read: '', cat: '', sub: '' });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const up = (k, v) => setF(x => ({ ...x, [k]: v, ...(k === 'cat' ? { sub: '' } : {}) }));

  const lookup = async () => {
    if (!f.title) return;
    setMsg('Searching…');
    const d = await api(`/lookup?title=${encodeURIComponent(f.title)}&author=${encodeURIComponent(f.author)}`);
    if (!d.title) return setMsg('Not found.');
    setF(x => ({ ...x, pages: d.number_of_pages_median || x.pages, author: x.author || d.author_name?.[0] || '' }));
    setMsg(`Found: ${d.title}${d.ratings_average ? ' · ★' + d.ratings_average.toFixed(2) : ''}`);
  };
  useEffect(() => {
    const onKey = e => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden'; // the page behind should not scroll
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, []);

  const submit = async () => {
    if (!f.title) return say('Enter a title');
    setBusy(true);
    try {
      const b = await api('/books', 'POST', f);
      refresh();
      close();
      if (b.guessed) { say(`Added, but I could not tell the category of "${b.title}". Please pick it here.`); go('book', b.id); }
      else say(`Added to ${b.cat}${b.sub && ' · ' + b.sub}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="popup">
      <button className="alt close" onClick={close} aria-label="Close">✕</button>
      <h2>Add a book</h2>
      <div className="row">
        <div>Title<TitleInput value={f.title} onChange={v => up('title', v)}
          onPick={s => setF(x => ({ ...x, title: s.title, author: s.author || x.author, pages: s.pages || x.pages }))} /></div>
        <div>Author<input value={f.author} onChange={e => up('author', e.target.value)} /></div>
        <div>Pages<input type="number" placeholder="empty if unknown" value={f.pages} onChange={e => up('pages', e.target.value)} /></div>
        <div>Already read<input type="number" min="0" placeholder="pages, if you started" value={f.read} onChange={e => up('read', e.target.value)} /></div>
      </div>
      <button className="alt" onClick={lookup}>🔎 Look up pages & rating</button> <span className="mute">{msg}</span>
      <div className="row" style={{ marginTop: 12 }}>
        <div>Category
          <select value={f.cat} onChange={e => up('cat', e.target.value)}>
            <option value="">{meta.ai ? '🤖 Let AI decide' : '🔎 Detect automatically'}</option>
            {Object.keys(meta.CATS).map(c => <option key={c}>{c}</option>)}
          </select></div>
        <div>Subcategory
          <select value={f.sub} onChange={e => up('sub', e.target.value)} disabled={!f.cat}>
            <option value="">{f.cat ? 'Choose…' : meta.ai ? '🤖 Let AI decide' : '🔎 Detect automatically'}</option>
            {(meta.CATS[f.cat] || []).map(s => <option key={s}>{s}</option>)}
          </select></div>
      </div>
      <button onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add to my shelf'}</button>
    </div>
  );
}

// Title field that suggests matching books while typing; picking one also fills author and pages
function TitleInput({ value, onChange, onPick }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const typed = useRef(false); // only search after typing, not after picking a suggestion

  useEffect(() => {
    const q = value.trim();
    if (!typed.current || q.length < 2) { setList([]); return; }
    let stale = false;
    const t = setTimeout(() => api('/suggest?q=' + encodeURIComponent(q))
      .then(l => { if (!stale) { setList(l); setHi(-1); setOpen(true); } })
      .catch(() => {}), 250);
    return () => { stale = true; clearTimeout(t); };
  }, [value]);

  const pick = s => { typed.current = false; onPick(s); setOpen(false); setList([]); };
  const onKey = e => {
    if (!open || !list.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % list.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi <= 0 ? list.length : hi) - 1); }
    else if (e.key === 'Enter' && hi >= 0) { e.preventDefault(); pick(list[hi]); }
    else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } // close the list, not the whole pop-up
  };

  return (
    <div className="suggest">
      <input value={value} autoComplete="off" placeholder="Start typing…" onKeyDown={onKey}
        onChange={e => { typed.current = true; onChange(e.target.value); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} />
      {open && list.length > 0 && (
        <ul>
          {list.map((s, i) => (
            // mousedown fires before the input's blur, so the click is not lost
            <li key={s.title + s.author} className={i === hi ? 'on' : ''} onMouseDown={e => { e.preventDefault(); pick(s); }} onMouseEnter={() => setHi(i)}>
              <b>{s.title}</b>
              <div className="mute">{s.author || 'Unknown author'}{s.pages && ` · ~${s.pages} pages`}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BookCard({ b, go }) {
  return (
    <div className="card">
      <b>{b.title}</b> <span className="mute">by {b.author || '?'}</span><br />
      {b.sub && <span className="tag">{b.sub}</span>}
      <div className="bar" style={{ margin: '8px 0' }}><i style={{ width: b.read / b.pages * 100 + '%' }} /></div>
      <span className="mute">{b.read}/{b.pages} pages · {b.notes.length} notes</span>
      <button className="alt" style={{ float: 'right' }} onClick={() => go('book', b.id)}>Open folder</button>
    </div>
  );
}

function Library({ S, go }) {
  const l = S.books.filter(b => !b.done);
  return (
    <>
      <h2>Currently reading</h2>
      {l.length ? blocks(l).map(([cat, books]) => (
        <section className="block" key={cat}>
          <h3>{cat}</h3>
          {books.map(b => <BookCard key={b.id} b={b} go={go} />)}
        </section>
      )) : <p className="mute">Nothing yet. Add your first book below.</p>}
    </>
  );
}

function Archive({ S, go }) {
  const l = S.books.filter(b => b.done).reverse();
  return (
    <>
      <h2>Archive</h2>
      {l.length ? l.map(b => (
        <div className="card" key={b.id}>
          <b>{b.title}</b> <span className="mute">by {b.author} · {b.doneAt} · ★{b.rating?.toFixed(1)}</span>
          <button className="alt" style={{ float: 'right' }} onClick={() => go('book', b.id)}>Open</button>
        </div>
      )) : <p className="mute">No finished books yet.</p>}
    </>
  );
}

function Book({ S, meta, openId, go, refresh, say }) {
  const b = S.books.find(x => x.id == openId);
  const [text, setText] = useState('');
  const [page, setPage] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState('');
  const [total, setTotal] = useState('');
  const [sure, setSure] = useState(false);
  const [delNote, setDelNote] = useState(-1);
  if (!b) return <Home S={S} meta={meta} go={go} refresh={refresh} say={say} />;

  const setProgress = async () => {
    if (at === '' || !(+at >= 0)) return say('Enter the page you are on');
    const r = await api(`/books/${b.id}/progress`, 'PUT', { read: at });
    setAt('');
    say(`Progress saved: ${r.read}/${r.pages} pages` + (gainsText(r.gained, meta) && '\n' + gainsText(r.gained, meta)) + (r.read >= r.pages ? '\nYou reached the last page! Check it off below.' : ''));
    refresh();
  };

  const setPages = async () => {
    if (!(+total > 0)) return say('Enter how many pages your copy has');
    const r = await api(`/books/${b.id}/pages`, 'PUT', { pages: total });
    setTotal(''); say(`This book now has ${r.pages} pages`); refresh();
  };
  const remove = async () => {
    if (!sure) return setSure(true); // first click asks, second click deletes
    await api(`/books/${b.id}`, 'DELETE');
    say(`Deleted "${b.title}"`); refresh(); go('home');
  };
  const removeNote = async i => {
    if (delNote !== i) return setDelNote(i); // first click asks, second click deletes
    await api(`/books/${b.id}/notes/${i}`, 'DELETE');
    setDelNote(-1); refresh();
  };
  const setCat = async (cat, sub) => {
    const r = await api(`/books/${b.id}/category`, 'PUT', { cat, sub });
    say(`Moved to ${r.cat}${r.sub && ' · ' + r.sub}`); refresh();
  };

  const addNote = async () => {
    if (!text.trim()) return;
    await api(`/books/${b.id}/notes`, 'POST', { text, page });
    setText(''); setPage(''); refresh();
  };
  const finish = async () => {
    setBusy(true); say('⏳ Finding your next book…');
    try {
      const r = await api(`/books/${b.id}/finish`, 'POST');
      say(`🎉 Finished! This book gave you ${gainsText(r.gains, meta)}\nNext: ${r.rec.title}`);
      refresh();
    } finally { setBusy(false); }
  };

  return (
    <>
      <button className="alt" onClick={() => go(b.done ? 'archive' : 'home')}>← Back</button>
      <div className="card">
        <h2>{b.title}</h2>
        <div className="mute">{b.author} · {b.pages} pages</div>
        <div className="row" style={{ marginTop: 8 }}>
          <div>Category
            <select value={b.cat} onChange={e => setCat(e.target.value, '')}>
              {Object.keys(meta.CATS).map(c => <option key={c}>{c}</option>)}
            </select></div>
          <div>Subcategory
            <select value={b.sub} onChange={e => setCat(b.cat, e.target.value)}>
              <option value="">Choose…</option>
              {[...new Set([...(meta.CATS[b.cat] || []), b.sub])].filter(Boolean).map(x => <option key={x}>{x}</option>)}
            </select></div>
        </div>
        {b.done ? (
          <>
            <p>✅ Finished {b.doneAt} · ★{b.rating?.toFixed(1)}</p>
            <p>{Object.entries(b.gains || {}).map(([k, v]) => <span className="tag" key={k}>+{num(v)} {meta.STATS[k] || k}</span>)}</p>
            <p className="mute">{b.why}</p>
            {b.rec && <p>📖 Next: <b>{b.rec.title}</b> {b.rec.author} — {b.rec.why}</p>}
          </>
        ) : (
          <>
            <div className="bar"><i style={{ width: b.read / b.pages * 100 + '%' }} /></div>
            <p className="mute">{b.read}/{b.pages} pages</p>
            {b.w && <p className="mute">Every 10 pages: {gainsText(Object.fromEntries(Object.entries(b.w).map(([k, v]) => [k, v * b.total * 10 / b.pages])), meta)}
              {gainsText(b.gains, meta) && <><br />Earned so far: {gainsText(b.gains, meta)}</>}</p>}
            <div className="row">
              <input type="number" min="0" max={b.pages} placeholder="Page you are on now" value={at} onChange={e => setAt(e.target.value)} />
              <button onClick={setProgress}>Update progress</button>
            </div>
            <div className="row">
              <input type="number" min="1" placeholder={`Pages in your copy (now ${b.pages})`} value={total} onChange={e => setTotal(e.target.value)} />
              <button className="alt" onClick={setPages}>Change total pages</button>
            </div>
            <button className="ok" onClick={finish} disabled={busy}>✔ Mark as finished</button>{' '}
            <button className="bad" onClick={remove} onBlur={() => setSure(false)}>{sure ? 'Click again to delete for good' : '🗑 Delete book'}</button>
          </>
        )}
      </div>
      <div className="card">
        <h3>📝 Notes</h3>
        {!b.done && (
          <>
            <textarea rows="3" placeholder="What did you learn or think?" value={text} onChange={e => setText(e.target.value)} />
            <input type="number" placeholder="Page (optional)" value={page} onChange={e => setPage(e.target.value)} />
            <button onClick={addNote}>Save note</button>
          </>
        )}
        {b.notes.length ? b.notes.map((n, i) => (
          <div className="note" key={i}>
            <button className={delNote === i ? 'bad' : 'alt'} style={{ float: 'right' }} onClick={() => removeNote(i)} onBlur={() => setDelNote(-1)}>{delNote === i ? 'Click again to delete' : '🗑'}</button>
            {n.t}<div className="mute">{n.d}{n.p && ` · p.${n.p}`}</div>
          </div>
        )).reverse() : <p className="mute">No notes yet.</p>}
      </div>
    </>
  );
}

function Stats({ S, meta }) {
  const max = Math.max(20, ...Object.values(S.stats));
  return (
    <div className="card">
      <h2>Your stats</h2>
      {Object.entries(meta.STATS).map(([k, l]) => (
        <div className="stat" key={k}><b>{l}</b><div className="bar"><i style={{ width: (S.stats[k] || 0) / max * 100 + '%' }} /></div><span>{num(S.stats[k]).toFixed(2)}</span></div>
      ))}
      <p className="mute">Books finished: {S.books.filter(b => b.done).length}</p>
    </div>
  );
}

function Settings({ S, meta, refresh }) {
  return (
    <div className="card">
      <h2>Settings</h2>
      <p>Difficulty: <b>{S.level} ({S.goal}/day)</b>{' '}
        <button className="alt" onClick={async () => { await api('/settings', 'PUT', { level: null, goal: 0 }); refresh(); }}>Change</button></p>
      <p>AI mode: <b>{meta.ai ? 'ON (Claude API key found on server)' : 'OFF (built-in rules + Open Library)'}</b></p>
      <p className="mute">To enable AI, put ANTHROPIC_API_KEY in server/.env and restart the server.</p>
    </div>
  );
}
