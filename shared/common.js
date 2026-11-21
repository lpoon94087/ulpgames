// Shared by every game: small helpers, the menu, the About box, and the round engine
// (teams, scores, a persistent shuffled deck, the clock, Got It / Skip, results).
// A game page supplies its cards and a few hooks; see createRounds() below.

export const $ = id => document.getElementById(id);
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// localStorage under a per-game prefix ("mg.time", "wym.deck", …), tolerant of blocked storage.
export function store(prefix) {
  return {
    get(k, d) { try { const v = localStorage.getItem(prefix + '.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(prefix + '.' + k, JSON.stringify(v)); } catch {} },
  };
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Fetch a text file and return its non-empty lines.
export async function lines(file) {
  const r = await fetch(file, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return (await r.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// Keep the screen awake while a game is running.
let wakeLock = null, wantAwake = false;
export async function keepAwake() {
  wantAwake = true;
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantAwake) keepAwake(); });

// Short beeps for the last seconds and the buzzer.
let audio = null;
export function beep(freq = 880, dur = 0.12, vol = 0.2) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch {}
}

// ───────────────────────── ASK ─────────────────────────
// A yes/no question shown in the page, used instead of the browser's confirm() everywhere: a
// browser dialog can hide behind a full-screen page, and it looks different on every device.
// Resolves true for OK, false for Cancel, and null for Escape or a tap outside the box (also
// falsy, so `if (!await ask(…))` treats it as Cancel; a caller can tell it apart when Cancel does something).
//   ask('Every team goes back to 0.', { title: 'Start a new game?', ok: 'New game' })
let askBox = null;
export function ask(text, { title = 'Are you sure?', ok = 'OK', cancel = 'Cancel' } = {}) {
  if (!askBox) {
    askBox = document.createElement('div');
    askBox.className = 'overlay hidden'; askBox.style.zIndex = 40;
    askBox.setAttribute('role', 'dialog'); askBox.setAttribute('aria-modal', 'true');
    askBox.innerHTML = `<div class="panel"><h2 class="ask-title"></h2><p class="muted ask-text" style="font-size:15px"></p>
      <div class="row"><button class="ask-cancel"></button><button class="primary ask-ok"></button></div></div>`;
    document.body.appendChild(askBox);
  }
  const q = sel => askBox.querySelector(sel);
  q('.ask-title').textContent = title; q('.ask-text').textContent = text || '';
  q('.ask-text').classList.toggle('hidden', !text);
  q('.ask-ok').textContent = ok; q('.ask-cancel').textContent = cancel;
  return new Promise(done => {
    const finish = v => { askBox.classList.add('hidden'); document.removeEventListener('keydown', key, true); done(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    q('.ask-ok').onclick = () => finish(true);
    q('.ask-cancel').onclick = () => finish(false);
    askBox.onclick = e => { if (e.target === askBox) finish(null); };
    document.addEventListener('keydown', key, true);
    askBox.classList.remove('hidden'); q('.ask-ok').focus();
  });
}

// ───────────────────────── RELOAD ─────────────────────────
// A web app saved to a phone's home screen has no refresh button, and GitHub Pages lets the
// phone keep each file for 10 minutes. Reload asks the server for fresh copies of the page and
// every file it loaded, then reloads, so the latest version shows straight away.
export async function reloadLatest() {
  if (!await ask('Fetches the newest copy of every game.', { title: 'Reload ULP Games?', ok: 'Reload' })) return;
  // Check for a new offline copy too (sw.js), then refresh this page's files past every cache.
  try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch {}
  const urls = new Set([location.href.split('#')[0]]);
  for (const r of performance.getEntriesByType('resource'))
    if (r.name.startsWith(location.origin)) urls.add(r.name);
  await Promise.all([...urls].map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload();
}

// Offline: sw.js keeps a copy of the whole site, so every game works on one device with no internet.
// Pages come from that copy at once and are refreshed in the background for the next visit.
if ('serviceWorker' in navigator && location.protocol.startsWith('http'))
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});

// ───────────────────────── MENU ─────────────────────────
// Tapping the game's name (#btnMenu) opens #menu. items() returns [label, fn, className?][]
// and is called each time, so the menu can depend on what the page is doing.
// Every game's menu also gets Home (the site's start page), just above About or at the end.
// Options: home: false leaves it out (the start page itself); leaving() returns a question to
// confirm before going Home, or '' to go straight there (e.g. ask only while a game is running).
const HOME = new URL('../', import.meta.url).href;
export function initMenu(items, { home = true, leaving } = {}) {
  const goHome = async () => { const q = leaving && leaving(); if (q && !await ask('', { title: q, ok: 'Go home' })) return; location.href = HOME; };
  const btn = $('btnMenu'), m = $('menu');
  const close = () => { m.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = e => {
    e.stopPropagation();
    if (!m.classList.contains('hidden')) return close();
    m.innerHTML = '';
    const list = items(), at = list.findIndex(([label]) => label === 'About');
    if (home) list.splice(at < 0 ? list.length : at, 0, ['Home', goHome]);
    for (const [label, fn, cls] of list) {
      const b = document.createElement('button');
      b.textContent = label; b.setAttribute('role', 'menuitem'); if (cls) b.className = cls;
      b.onclick = () => { close(); fn(); };
      m.appendChild(b);
    }
    m.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true');
  };
  document.addEventListener('click', e => { if (!m.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}

// ───────────────────────── ABOUT ─────────────────────────
// The #about overlay. cardsText() may be async; it fills #aboutCards.
export function initAbout({ version, released, cardsText }) {
  const box = $('about');
  const close = () => box.classList.add('hidden');
  $('btnAboutClose').onclick = close;
  box.addEventListener('click', e => { if (e.target === box) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return async function open() {
    $('aboutVersion').textContent = `Version ${version} · ${released}`;
    box.classList.remove('hidden'); $('btnAboutClose').focus();
    try { $('aboutCards').textContent = cardsText ? await cardsText() : ''; } catch { $('aboutCards').textContent = ''; }
  };
}

// ───────────────────────── ROUNDS ─────────────────────────
// The moderator's side of a timed, team-based card game. The page must contain these ids:
//   setup:  optTime, optTeams, deckInfo, btnStart
//   ready:  rScores, rBanner, rInfo, btnStartNext
//   play:   pScores, pClock, btnSkip, btnGot, btnPause, btnEnd   (+ elements with class "hide-on-pause")
//   over:   oScores, oBanner, oResults, btnNext
// Options:
//   prefix      storage prefix ('mg', 'wym')
//   cards       array of card objects
//   show(name)  switch the page to section 'setup' | 'ready' | 'play' | 'over'
//   renderCard(card)  put the current card on the play screen
//   result(r)   [main, sub] text for a card in the results list (r is the card plus .got)
//   fits(i)     optional: whether card i can be drawn under the current settings
//   deckName()  optional: word before "cards" in the deck count ('easy', …)
//   noun        optional: what the deck count calls a card ('words'); default 'cards'
//   info()      optional: extra item for the line under "you're up"
//   readyText(team)  optional: banner between rounds
//   onChange(G) optional: called after every change (Mad Gab syncs its viewers here)
//   tapToStart  optional: id of the card element on the play screen. Start game then opens the
//               play screen with the clock stopped and the card showing START; tapping the card
//               starts the round. The page's startCue(on) shows or hides the START card.
//   startCue(on) required with tapToStart
//   readyFirst  optional: Start game opens the "you're up" screen first, as between rounds
export function createRounds(o) {
  const st = store(o.prefix);
  const cards = o.cards, fits = o.fits || (() => true);
  const G = { teams: [], current: 0, roundMs: 120000, phase: 'setup', endsAt: 0, pausedLeft: 0, card: null, results: [], deck: [] };
  let tick = null, lastBeep = -1, armed = false;
  const changed = () => { if (o.onChange) o.onChange(G); };

  // Teams and scores
  function parseTeams() {
    const names = $('optTeams').value.split(',').map(s => s.trim()).filter(Boolean);
    return (names.length ? names : ['Team A']).map(name => ({ name, score: 0 }));
  }
  function syncTeams() {
    const old = new Map(G.teams.map(t => [t.name, t.score]));
    G.teams = parseTeams().map(t => ({ name: t.name, score: old.get(t.name) || 0 }));
    if (G.current >= G.teams.length) G.current = 0;
    st.set('teamsText', $('optTeams').value);
    saveScores();
  }
  function saveScores() { st.set('teams', G.teams); st.set('current', G.current); }
  function renderScores() {
    const html = G.teams.map((t, i) =>
      `<div class="team ${i === G.current ? 'current' : ''}">${esc(t.name)}<b>${t.score}</b></div>`).join('');
    ['pScores', 'oScores', 'rScores'].forEach(id => $(id).innerHTML = html);
  }

  // Deck: a shuffled order of card indexes; it holds every card not yet drawn, and fits() picks
  // which ones get drawn. What's saved is the cards already drawn, by their text, so cards don't
  // repeat across sessions, and editing the card file keeps that history (new cards go straight
  // into the deck; removed ones are forgotten).
  const keyOf = c => JSON.stringify(c);
  function loadDeck() {
    const saved = st.get('deck', null);
    if (saved && Array.isArray(saved.drawn)) {
      const drawn = new Set(saved.drawn);
      G.deck = shuffle(cards.map((_, i) => i).filter(i => !drawn.has(keyOf(cards[i]))));
    } else if (saved && saved.n === cards.length && Array.isArray(saved.order)) {
      G.deck = saved.order; saveDeck();   // the old index-based save, from before 2026-11-21
    } else reshuffle();
  }
  function reshuffle() { G.deck = shuffle(cards.map((_, i) => i)); saveDeck(); updateDeckInfo(); }
  function saveDeck() {
    const inDeck = new Set(G.deck);
    st.set('deck', { drawn: cards.filter((_, i) => !inDeck.has(i)).map(keyOf) });
  }
  function drawCard() {
    let at = G.deck.findIndex(fits);
    if (at < 0) {   // this selection is used up: put its cards back, shuffled, without touching the others
      G.deck = G.deck.concat(shuffle(cards.map((_, i) => i).filter(fits)));
      at = G.deck.findIndex(fits);
    }
    const card = cards[G.deck.splice(at, 1)[0]]; saveDeck(); return card;
  }
  // The card on screen when a round ends has been seen, so it never goes back in the deck
  // (the next team would start with it). endRound lists it as missed; stop() just drops it.
  function discard() { G.card = null; }
  function updateDeckInfo() {
    const left = G.deck.filter(fits).length, total = cards.filter((_, i) => fits(i)).length;
    const name = o.deckName ? o.deckName() : '';
    $('deckInfo').textContent = `${left} of ${total} ${name ? name + ' ' : ''}${o.noun || 'cards'} left in the deck.`;
    $('rInfo').textContent = [`${fmt(Number($('optTime').value) * 1000)} round`, o.info && o.info(), `${left} left`].filter(Boolean).join(' · ');
  }

  // Rounds
  function setPaused(p) { document.querySelectorAll('.hide-on-pause').forEach(el => el.style.visibility = p ? 'hidden' : ''); }
  // The play buttons do nothing until the round is running.
  function setControls(on) { ['btnGot', 'btnSkip', 'btnPause', 'btnEnd'].forEach(id => $(id).disabled = !on); }
  // Open the play screen with the clock full and a START card; the round begins when it's tapped.
  function armRound() {
    syncTeams(); renderScores();
    G.roundMs = Number($('optTime').value) * 1000;
    G.results = []; G.card = null; armed = true; setPaused(false);
    $('pClock').textContent = fmt(G.roundMs); $('pClock').classList.remove('low');
    $('btnPause').textContent = 'Pause'; setControls(false);
    o.startCue(true); o.show('play'); keepAwake(); changed();
  }
  // readyFirst: Start game shows the "you're up" screen first, like between rounds, so the first
  // team can get ready before the clock runs.
  function toReady() {
    syncTeams(); updateDeckInfo(); renderScores();
    const team = G.teams[G.current].name;
    $('rBanner').textContent = o.readyText ? o.readyText(team) : `${team}, you're up`;
    o.show('ready'); changed();
  }
  function startRound() {
    if (armed) { armed = false; o.startCue(false); }
    setControls(true);
    syncTeams();
    G.roundMs = Number($('optTime').value) * 1000;
    st.set('time', G.roundMs / 1000);
    G.results = []; G.card = drawCard(); G.phase = 'playing'; shownAt = Date.now();
    G.endsAt = Date.now() + G.roundMs; lastBeep = -1;
    $('pClock').textContent = fmt(G.roundMs); $('pClock').classList.remove('low');
    $('btnPause').textContent = 'Pause'; setPaused(false);
    o.show('play'); renderScores(); o.renderCard(G.card); keepAwake(); beep(660, .15);
    clearInterval(tick); tick = setInterval(onTick, 250);
    changed();
  }
  function onTick() {
    if (G.phase !== 'playing') return;
    const left = G.endsAt - Date.now();
    $('pClock').textContent = fmt(left);
    $('pClock').classList.toggle('low', left <= 10000);
    const sec = Math.ceil(left / 1000);
    if (sec <= 5 && sec > 0 && sec !== lastBeep) { lastBeep = sec; beep(880, .08, .12); }
    if (left <= 0) endRound();
  }
  // A second tap within ANSWER_GAP of a new card showing is a double-tap: ignored, so it can't
  // score a card nobody saw.
  const ANSWER_GAP = 500;
  let shownAt = 0;
  function answer(got) {
    if (G.phase !== 'playing' || Date.now() - shownAt < ANSWER_GAP) return;
    G.results.push({ ...G.card, got });
    if (got) { G.teams[G.current].score++; saveScores(); renderScores(); beep(1046, .1); }
    G.card = drawCard(); o.renderCard(G.card); shownAt = Date.now(); updateDeckInfo(); changed();
  }
  function togglePause() {
    if (G.phase === 'playing') {
      G.pausedLeft = G.endsAt - Date.now(); G.phase = 'paused';
      $('btnPause').textContent = 'Resume'; setPaused(true);
    } else if (G.phase === 'paused') {
      G.endsAt = Date.now() + G.pausedLeft; G.phase = 'playing';
      $('btnPause').textContent = 'Pause'; setPaused(false);
    }
    changed();
  }
  function endRound() {
    if (G.phase !== 'playing' && G.phase !== 'paused') return;   // already over (the clock ran out while End round was asking)
    clearInterval(tick);
    if (G.card) G.results.push({ ...G.card, got: false });
    discard(); G.phase = 'over'; setPaused(false);
    beep(220, .6, .3);
    const got = G.results.filter(r => r.got).length;
    $('oBanner').textContent = `${G.teams[G.current].name}: ${got} point${got === 1 ? '' : 's'} this round`;
    $('oResults').innerHTML = G.results.length ? G.results.map(r => {
      const [main, sub] = o.result(r);
      return `<li class="${r.got ? 'got' : 'skip'}"><span class="mark">${r.got ? '✓' : '✗'}</span>
        <span><div>${esc(main)}</div>${sub ? `<div class="p">${esc(sub)}</div>` : ''}</span></li>`;
    }).join('') : '<li class="muted">No cards this round.</li>';
    renderScores(); o.show('over'); changed();
  }
  function nextRound() {
    G.current = (G.current + 1) % G.teams.length; saveScores();
    G.phase = 'setup'; updateDeckInfo(); renderScores();
    const team = G.teams[G.current].name;
    $('rBanner').textContent = o.readyText ? o.readyText(team) : `${team}, you're up`;
    o.show('ready'); changed();
  }
  // New game: stop any round, every score back to 0, first team up, back to setup.
  // The deck carries on; reshuffle puts every card back.
  async function newGame() {
    if (!await ask('Any round in progress stops, and every team goes back to 0.', { title: 'Start a new game?', ok: 'New game' })) return;
    stop(); syncTeams(); G.teams.forEach(t => t.score = 0); G.current = 0; saveScores();
    G.phase = 'setup'; G.results = []; updateDeckInfo(); renderScores(); o.show('setup'); changed();
  }
  function stop() { clearInterval(tick); discard(); setPaused(false); if (armed) { armed = false; o.startCue(false); setControls(true); } }

  // Wire up the shared controls.
  $('optTime').value = String(st.get('time', 120));
  $('optTeams').value = st.get('teamsText', 'Team A, Team B');
  G.teams = st.get('teams', null) || parseTeams();
  G.current = st.get('current', 0) % G.teams.length;
  // Start game from the setup screen. If the last game's scores are still there (saved on this
  // phone, maybe from last week), ask whether to carry on with them or start from 0.
  const begin = o.tapToStart ? armRound : o.readyFirst ? toReady : startRound;
  $('btnStart').onclick = async () => {
    if (G.teams.some(t => t.score)) {
      const scores = G.teams.map(t => `${t.name} ${t.score}`).join(' · ');
      const go = await ask(`The last game's scores are still here: ${scores}.`, { title: 'Carry on the last game?', ok: 'Carry on', cancel: 'Start from 0' });
      if (go === null) return;
      if (!go) { G.teams.forEach(t => t.score = 0); G.current = 0; saveScores(); renderScores(); }
    }
    begin();
  };
  if (o.tapToStart) {
    const card = $(o.tapToStart), go = () => { if (armed) startRound(); };
    card.addEventListener('click', go);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  $('btnStartNext').onclick = startRound;
  $('btnGot').onclick = () => answer(true);
  $('btnSkip').onclick = () => answer(false);
  $('btnPause').onclick = togglePause;
  $('btnEnd').onclick = async () => { if (await ask('', { title: 'End this round now?', ok: 'End round' })) endRound(); };
  $('btnNext').onclick = nextRound;
  $('optTeams').onchange = () => { syncTeams(); renderScores(); changed(); };
  $('optTime').onchange = updateDeckInfo;
  loadDeck(); updateDeckInfo(); renderScores();

  return Object.assign(G, {
    newGame, stop, updateDeckInfo,
    // Draw outside a timed round (the word generator's free play). Uses the same saved deck.
    draw: () => { const c = drawCard(); updateDeckInfo(); return c; },
    left: () => G.deck.filter(fits).length,
    reshuffle: async () => { if (await ask('Every card goes back into the deck.', { title: 'Reshuffle the deck?', ok: 'Reshuffle' })) reshuffle(); },
  });
}
