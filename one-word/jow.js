import { $, ask, esc, store, lines, shuffle, keepAwake, initMenu, initAbout, beep } from '../shared/common.js';

// Just One Word: one player guesses a secret word; everyone else on their team writes a one-word
// clue on their own phone, all at once. Matching clues cancel out (the same word or the same
// root), and so does the secret word itself. The guesser then sees the clues that are left and
// gets one guess.
//
// Devices: one Host screen (a TV or tablet: the room, the players, the clues for the guesser)
// and a phone per player. They share a room (shared/rooms.js shareRoom), whose state is:
//   step      'lobby' | 'clues' | 'review' | 'guess' | 'result' | 'over'
//   settings  { mode: 'coop' | 'teams', labels: 'rb' | 'ab', count, level }
//   players   { <pid>: { name, team: 'a' | 'b' | '', at } }   each phone writes its own
//   round, word, guesser, team                                  the word in play (the host deals)
//   clues     { <round>: { <pid>: text } }                      each clue-giver writes its own
//   cancel    { <round>: { <pid>: true | false } }              a clue-giver's cancel / keep taps
//   results   { <round>: { res: 'right'|'wrong'|'pass', team, word, guesser } }
//   want      { next: <round> }                                 a phone asking the host for the next word
// The host deals each word and ends the game; the phones write clues, cancel taps, "show the
// clues" and the verdict, and the host follows along. Scores come from the results.
const VERSION = '1.0', RELEASED = '2026-11-21';

const sections = ['home', 'join', 'lobby', 'stage', 'play'];
const show = name => sections.forEach(s => $(s).classList.toggle('hidden', s !== name));
const st = store('jow');
const params = new URLSearchParams(location.search);

// This device's player id, kept across reloads (and the presence id in the room).
let ME = st.get('pid', '');
if (!/^[a-z0-9]{6,16}$/.test(ME)) { ME = Math.random().toString(36).slice(2, 12).replace(/[^a-z0-9]/g, '') || 'p' + Date.now().toString(36); st.set('pid', ME); }

let role = null, room = null, S = null, online = new Set();
const send = part => room && room.code() ? room.send(part).catch(() => {}) : Promise.resolve();

// ───────────── Clue checking ─────────────
// Two clues match if they're the same word or share a root: SNOW / SNOWS / SNOWY, RUN / RUNNING,
// CITY / CITIES, PRINCE / PRINCESS (but not SNOW / SNOWMAN or STAR / START: a root plus an ending).
// A clue that is the secret word, contains it, or is part of it is out too.
const norm = w => String(w || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');
const SUFFIXES = [['iest', 'y'], ['ies', 'y'], ['ied', 'y'], ['ying', 'y'], ['ing', ''], ['ers', ''], ['est', ''], ['ed', ''], ['er', ''], ['es', ''], ['ly', ''], ['s', '']];
function stem(w) {
  w = norm(w);
  for (const [suf, put] of SUFFIXES) if (w.length - suf.length >= 3 && w.endsWith(suf)) { w = w.slice(0, -suf.length) + put; break; }
  if (w.length > 3 && /[ye]$/.test(w)) w = w.slice(0, -1);                     // city / cities → cit, bake / baking → bak
  if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);   // running → runn → run
  return w;
}
function sameRoot(a, b) {
  const x = stem(a), y = stem(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 4 && l.startsWith(s) && ['s', 'es', 'y', 'er', 'ess', 'ie', 'ly'].includes(l.slice(s.length));
}
function badForWord(clue, word) {
  const c = norm(clue), w = norm(word);
  if (!c) return true;
  return sameRoot(c, w) || (w.length >= 3 && c.includes(w)) || (c.length >= 3 && w.includes(c));
}
// The clues for a round, each with whether it's cancelled and why. A cancel / keep tap overrides.
function clueList(s = S, r = s && s.round) {
  const got = (s && s.clues && s.clues[r]) || {}, taps = (s && s.cancel && s.cancel[r]) || {};
  const list = Object.entries(got).filter(([, t]) => typeof t === 'string' && t).map(([pid, text]) => ({ pid, text, name: nameOf(pid, s) }));
  for (const c of list) {
    c.auto = badForWord(c.text, s.word) ? 'the secret word' : list.some(d => d !== c && sameRoot(c.text, d.text)) ? 'a match' : '';
    c.out = c.pid in taps ? taps[c.pid] === true : !!c.auto;
  }
  return list.sort((a, b) => a.text.localeCompare(b.text));
}

// ───────────── Players and teams ─────────────
const playersOf = (s = S) => Object.entries((s && s.players) || {})
  .filter(([, p]) => p && typeof p.name === 'string')
  .map(([pid, p]) => ({ pid, name: p.name.slice(0, 16), team: p.team === 'a' || p.team === 'b' ? p.team : '', at: Number(p.at) || 0 }))
  .sort((a, b) => a.at - b.at);
const nameOf = (pid, s = S) => { const p = s && s.players && s.players[pid]; return p && p.name ? p.name : 'Someone'; };
const teamName = (t, s = S) => {
  const ab = s && s.settings && s.settings.labels === 'ab';
  return t === 'a' ? (ab ? 'Team A' : 'Red') : t === 'b' ? (ab ? 'Team B' : 'Blue') : 'Everyone';
};
const teamsMode = (s = S) => s && s.settings && s.settings.mode === 'teams';
// Who writes clues this round: the playing team (everyone, together), less the guesser.
const giversOf = (s = S) => playersOf(s).filter(p => p.pid !== s.guesser && (!teamsMode(s) || p.team === s.team));
const isOnline = pid => online.has(pid);

// ───────────── Scores ─────────────
const resultsOf = (s = S) => Object.entries((s && s.results) || {}).map(([r, x]) => ({ r: Number(r), ...x })).filter(x => x.res).sort((a, b) => a.r - b.r);
function scores(s = S) {
  const res = resultsOf(s), right = t => res.filter(x => x.res === 'right' && (!t || x.team === t)).length;
  const played = t => res.filter(x => x.team === t).length;
  const used = res.reduce((n, x) => n + (x.res === 'wrong' ? 2 : 1), 0);   // together: a wrong guess loses the next word too
  return { right, played, used };
}
function scoresHtml(s = S) {
  if (!s || !s.settings) return '';
  const sc = scores(s), cur = ['clues', 'review', 'guess', 'result'].includes(s.step) ? s.team : null;
  if (teamsMode(s)) return ['a', 'b'].map(t => `<div class="team jw-${t} ${t === cur ? 'current' : ''}">${esc(teamName(t, s))}<b>${sc.right(t)}</b></div>`).join('');
  const count = s.settings.count, left = Math.max(0, count - sc.used);
  return `<div class="team">Right<b>${sc.right()}</b></div><div class="team">Words left<b>${left}</b></div>`;
}
// Together: what a final score out of the pile means.
function rating(n, of) {
  const f = n / of;
  return f >= 1 ? 'Perfect! Every single word.' : f >= .85 ? 'Amazing! Hard to beat that.' : f >= .65 ? 'Great teamwork!' : f >= .45 ? 'Not bad at all.' : f >= .25 ? 'A good start. Try again?' : 'Everyone has off days.';
}
function overText(s = S) {
  const sc = scores(s);
  if (!teamsMode(s)) return { head: `${sc.right()} of ${s.settings.count}`, sub: rating(sc.right(), s.settings.count) };
  const a = sc.right('a'), b = sc.right('b');
  return { head: a === b ? `It's a tie, ${a} each!` : `${teamName(a > b ? 'a' : 'b', s)} wins, ${Math.max(a, b)} to ${Math.min(a, b)}!`, sub: '' };
}

// ───────────── Words ─────────────
// From Password's list, with its levels (password/levels.txt: easy, hard; the rest medium).
let words = [], levels = new Map();
async function loadWords() {
  if (words.length) return;
  words = [...new Set((await lines('../password/words.txt')).map(w => w.toUpperCase()))];
  try { levels = new Map((await lines('../password/levels.txt')).filter(l => !l.startsWith('#')).map(l => l.split('\t')).map(([w, lv]) => [w.toUpperCase(), lv])); } catch {}
}
const fitsLevel = (w, level) => { const lv = levels.get(w) || 'medium'; return level === 'easy' ? lv === 'easy' : level === 'hard' ? lv !== 'easy' : true; };
// The host's deck: words not dealt yet, saved so they don't repeat across games.
function draw(level) {
  let d = st.get('deck', null);
  if (!d || !Array.isArray(d.left)) d = { left: shuffle([...words]) };
  let at = d.left.findLastIndex(w => fitsLevel(w, level));
  if (at < 0) { d.left = shuffle(words.filter(w => fitsLevel(w, level))).concat(d.left); at = d.left.findLastIndex(w => fitsLevel(w, level)); }
  const w = d.left.splice(at, 1)[0]; st.set('deck', d); return w;
}

// ───────────── Room ─────────────
async function connect(onState) {
  const { shareRoom } = await import('../shared/rooms.js');
  return shareRoom({
    game: 'jow', id: ME,
    onState,
    onStatus: x => {
      $('status').innerHTML = `<span class="dot ${x.on && x.code ? 'on' : ''}"></span>${esc(x.code ? 'Room ' + x.code : x.text || 'Connecting…')}`;
    },
    onViewers: ids => { online = new Set(ids); if (role === 'host') hostRender(); else if (role === 'player') playerRender(); },
  });
}

// ═════════════ HOST ═════════════
const HOST_STORE = 'host', HOST_FOR = 6 * 3600e3;
async function startHost() {
  role = 'host'; show('lobby'); keepAwake();
  history.replaceState(null, '', '#host');
  await loadWords().catch(() => { $('lobbyMsg').textContent = "Couldn't load the word list. Check the connection and reload."; });
  room = await connect(s => { S = s; hostFollow(); hostRender(); });
  const saved = st.get(HOST_STORE, null);
  let code = null;
  if (saved && Date.now() - saved.at < HOST_FOR && await room.join(saved.code) === 'ok') code = saved.code;
  if (!code) code = await room.create({ step: 'lobby', settings: settingsFromForm(), players: {}, round: 0 });
  st.set(HOST_STORE, { code, at: Date.now() });
  const url = `${location.origin}${location.pathname}?join=${code}`;
  $('roomCode').textContent = code; $('joinUrl').textContent = url.replace(/^https?:\/\//, '');
  $('qr').innerHTML = ''; if (window.QRCode) new QRCode($('qr'), { text: url, width: 180, height: 180 });
}
function settingsFromForm() {
  return { mode: $('optMode').value, labels: $('optLabels').value, count: Number($('optCount').value) || 13, level: $('optLevel').value };
}
// The Words choice depends on the mode: a pile for playing together, words a team for two teams.
function fillCount(mode, value) {
  const opts = mode === 'teams' ? [[3, '3 words a team'], [5, '5 words a team'], [8, '8 words a team'], [10, '10 words a team']]
    : [[8, '8 words'], [13, '13 words'], [20, '20 words']];
  const want = value || (mode === 'teams' ? 5 : 13);
  $('optCount').innerHTML = opts.map(([v, t]) => `<option value="${v}"${v === want ? ' selected' : ''}>${t}</option>`).join('');
  $('lblCount').textContent = mode === 'teams' ? 'Words per team' : 'Words in the pile';
}
fillCount('coop');
['optMode', 'optLabels', 'optCount', 'optLevel'].forEach(id => $(id).onchange = () => {
  if (id === 'optMode') fillCount($('optMode').value);
  st.set('settings', settingsFromForm());
  if (role === 'host' && S && S.step === 'lobby') send({ settings: settingsFromForm() });
});
const savedSettings = st.get('settings', null);
if (savedSettings) {
  $('optMode').value = savedSettings.mode || 'coop'; $('optLabels').value = savedSettings.labels || 'rb'; $('optLevel').value = savedSettings.level || 'all';
  fillCount($('optMode').value, savedSettings.count);
}

// Why the game can't start yet ('' when it can).
function notReady(s = S) {
  const ps = playersOf(s).filter(p => isOnline(p.pid));
  if (teamsMode(s)) {
    const a = ps.filter(p => p.team === 'a').length, b = ps.filter(p => p.team === 'b').length;
    if (ps.some(p => !p.team)) return 'Everyone needs a team: tap a name to move it, or Shuffle teams.';
    if (a < 2 || b < 2) return `Each team needs at least 2 players (${teamName('a', s)} has ${a}, ${teamName('b', s)} has ${b}). With 3 or more a team, clues can cancel out.`;
    return '';
  }
  return ps.length < 2 ? 'Waiting for players: at least 2 (3 or more is better).' : '';
}

// The host deals the next word: the next team (two teams take turns) and its next guesser.
function deal(s = S, { same = false } = {}) {
  const ps = playersOf(s).filter(p => isOnline(p.pid) || p.pid === s.guesser);
  const r = (s.round || 0) + (same ? 0 : 1);
  let team = '', pool = ps;
  if (teamsMode(s)) {
    team = same ? s.team : r % 2 ? 'a' : 'b';
    pool = ps.filter(p => p.team === team);
  }
  if (pool.length < 2) { $('hSub').textContent = `${teamName(team, s)} needs at least 2 players online.`; return; }
  // Guessers take turns in join order: count this team's words so far.
  const turn = resultsOf(s).filter(x => !teamsMode(s) || x.team === team).length;
  const guesser = same ? s.guesser : pool[turn % pool.length].pid;
  const word = draw(s.settings.level);
  const part = { step: 'clues', round: r, word, guesser, team, want: null };
  part[`clues/${r}`] = null; part[`cancel/${r}`] = null;
  if (!same) part[`results/${r}`] = null;
  send(part);
  beep(660, .12);
}
function isOver(s = S) {
  const sc = scores(s), n = s.settings.count;
  return teamsMode(s) ? sc.played('a') >= n && sc.played('b') >= n : sc.used >= n;
}
function next() {
  if (!S || S.step !== 'result') return;
  if (isOver()) { send({ step: 'over' }); beep(1046, .2); return; }
  deal();
}
// The host follows the phones: every clue in → check them; a phone asked for the next word → deal.
let lastStep = '';
function hostFollow() {
  if (!S) return;
  if (S.step === 'clues') {
    const givers = giversOf().filter(p => isOnline(p.pid)), got = (S.clues && S.clues[S.round]) || {};
    if (givers.length && givers.every(p => got[p.pid])) send({ step: 'review' });
  }
  if (S.step === 'result' && S.want && S.want.next === S.round) next();
  if (S.step !== lastStep) {
    if (S.step === 'result') { const res = S.results && S.results[S.round]; beep(res && res.res === 'right' ? 1046 : 220, .3, .2); }
    lastStep = S.step;
  }
}

function hostRender() {
  if (role !== 'host' || !S) return;
  const s = S;
  if (s.step === 'lobby') { show('lobby'); return lobbyRender(); }
  show('stage');
  $('hScores').innerHTML = scoresHtml();
  const g = nameOf(s.guesser), team = teamsMode() ? ` (${teamName(s.team)})` : '';
  const list = clueList(), keep = list.filter(c => !c.out), out = list.filter(c => c.out);
  const res = s.results && s.results[s.round];
  $('hWord').classList.add('hidden'); $('hClues').innerHTML = ''; $('hActions').innerHTML = '';
  const act = (label, fn, cls = '') => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; $('hActions').append(b); };
  if (s.step === 'clues') {
    const givers = giversOf(), got = (s.clues && s.clues[s.round]) || {};
    $('hBanner').textContent = `${g} is guessing${team}`;
    $('hSub').textContent = `Clues in: ${givers.filter(p => got[p.pid]).length} of ${givers.length}. ${g}, don't look at the phones!`;
    $('hClues').innerHTML = givers.map(p => `<span class="jw-who ${got[p.pid] ? 'done' : ''} ${isOnline(p.pid) ? '' : 'off'}">${got[p.pid] ? '✓ ' : ''}${esc(p.name)}</span>`).join('');
    act('Stop waiting', () => send({ step: 'review' }));
    act('Skip this word', () => deal(S, { same: true }));
  } else if (s.step === 'review') {
    $('hBanner').textContent = 'Checking the clues…';
    $('hSub').textContent = `The clue-givers are crossing out matching clues. ${g}, eyes closed!`;
    act('Show the clues now', () => send({ step: 'guess' }), 'primary');
  } else if (s.step === 'guess') {
    $('hBanner').textContent = `${g}, your clues:`;
    $('hSub').textContent = out.length ? `${out.length} clue${out.length === 1 ? '' : 's'} cancelled out.` : 'Every clue was different.';
    $('hClues').innerHTML = keep.length ? keep.map(c => `<span class="jw-clue">${esc(c.text)}</span>`).join('') : '<span class="muted">No clues left. Guess anyway, or pass.</span>';
    act('Right', () => verdict('right'), 'good'); act('Wrong', () => verdict('wrong'), 'bad'); act('Pass', () => verdict('pass'));
  } else if (s.step === 'result') {
    const r = res ? res.res : '';
    $('hBanner').textContent = r === 'right' ? `Right! ${g} got it.` : r === 'wrong' ? `Wrong!${teamsMode() ? '' : ' That costs the next word too.'}` : 'Passed.';
    $('hBanner').className = `banner jw-res-${r}`;
    $('hSub').textContent = '';
    $('hWord').textContent = s.word; $('hWord').classList.remove('hidden');
    $('hClues').innerHTML = list.map(c => `<span class="jw-clue small ${c.out ? 'out' : ''}" title="${esc(c.name)}">${esc(c.text)}</span>`).join('');
    act(isOver() ? 'See the final score' : 'Next word', next, 'primary');
  } else if (s.step === 'over') {
    const o = overText();
    $('hBanner').textContent = o.head; $('hBanner').className = 'banner win';
    $('hSub').textContent = o.sub;
    act('Play again', newGame, 'primary');
  }
  if (s.step !== 'result' && s.step !== 'over') $('hBanner').className = 'banner';
}
function lobbyRender() {
  const s = S, ps = playersOf(), teams = teamsMode();
  $('boxLabels').classList.toggle('hidden', !teams); $('teamTools').classList.toggle('hidden', !teams);
  const chip = p => `<button class="jw-player jw-${p.team || 'none'} ${isOnline(p.pid) ? '' : 'off'}" data-pid="${p.pid}" title="${teams ? 'Tap to change team' : ''}">${esc(p.name)}${isOnline(p.pid) ? '' : ' (offline)'}<span class="x" data-x="${p.pid}" title="Remove">✕</span></button>`;
  $('players').innerHTML = !ps.length ? '<p class="muted">No players yet. Scan the QR code to join.</p>'
    : teams ? ['a', 'b', ''].map(t => {
      const m = ps.filter(p => p.team === t);
      if (!t && !m.length) return '';
      return `<div class="jw-team"><b>${t ? esc(teamName(t)) : 'No team yet'}</b> <span class="muted">${m.length}</span><div class="chips">${m.map(chip).join('')}</div></div>`;
    }).join('')
    : `<div class="jw-team"><b>Players</b> <span class="muted">${ps.length}</span><div class="chips">${ps.map(chip).join('')}</div></div>`;
  const why = notReady();
  $('lobbyMsg').textContent = why || (teams && ps.length < 6 ? 'Ready. (Teams of 3 or more play best: with only 2, the one clue never cancels.)' : 'Ready when you are.');
  $('btnStartGame').disabled = !!why;
}
$('players').addEventListener('click', e => {
  const x = e.target.closest('[data-x]');
  if (x) { e.stopPropagation(); send({ [`players/${x.dataset.x}`]: null }); return; }
  const b = e.target.closest('[data-pid]');
  if (!b || !teamsMode()) return;
  const p = S.players[b.dataset.pid]; if (!p) return;
  send({ [`players/${b.dataset.pid}/team`]: p.team === 'a' ? 'b' : 'a' });
});
$('btnShuffleTeams').onclick = () => {
  const ps = shuffle(playersOf().filter(p => isOnline(p.pid))), part = {};
  ps.forEach((p, i) => { part[`players/${p.pid}/team`] = i % 2 ? 'b' : 'a'; });
  send(part);
};
$('btnStartGame').onclick = () => {
  if (notReady()) return;
  const s = { ...S, settings: settingsFromForm(), results: {}, round: 0 };
  send({ settings: s.settings, results: null, clues: null, cancel: null, round: 0 });
  deal(s);
};
async function newGame() {
  if (S && !['lobby', 'over'].includes(S.step) && !await ask('Back to the lobby, with the same players. The scores go back to 0.', { title: 'Start a new game?', ok: 'New game' })) return;
  send({ step: 'lobby', results: null, clues: null, cancel: null, round: 0, word: null, guesser: null, want: null });
}

// The verdict, from the host or a phone.
function verdict(res) {
  if (!S || S.step !== 'guess') return;
  send({ step: 'result', [`results/${S.round}`]: { res, team: S.team || '', word: S.word, guesser: S.guesser } });
}

// ═════════════ PLAYER ═════════════
const PLAY_STORE = 'play';
async function startJoin(code) {
  role = 'player'; show('join');
  $('joinName').value = st.get('name', '');
  if (code) $('joinCode').value = code;
  (code && $('joinName').value ? $('btnJoin') : code ? $('joinName') : $('joinCode')).focus();
}
async function join() {
  const name = $('joinName').value.trim().slice(0, 16), code = $('joinCode').value.trim().toUpperCase();
  if (!name) { $('joinMsg').textContent = 'Type your name first.'; $('joinName').focus(); return; }
  if (!/^[A-Z2-9]{4}$/.test(code)) { $('joinMsg').textContent = 'The room code is 4 letters and numbers, on the host screen.'; return; }
  st.set('name', name);
  $('joinMsg').textContent = 'Joining…'; $('btnJoin').disabled = true;
  try {
    room = room || await connect(s => { S = s; playerRender(); });
    const res = await room.join(code);
    if (res !== 'ok') { $('joinMsg').textContent = res === 'other' ? `Room ${code} is another game's room.` : `There's no Just One Word game in room ${code}. Check the code on the host screen.`; return; }
    const mine = S && S.players && S.players[ME];
    await send({ [`players/${ME}`]: { name, team: mine && mine.team || '', at: mine && mine.at || Date.now() } });
    st.set(PLAY_STORE, { code, at: Date.now() });
    history.replaceState(null, '', `?join=${code}#play`);
    show('play'); keepAwake(); playerRender();
  } catch (e) {
    $('joinMsg').textContent = 'Could not reach the game database: ' + (e.message || e);
  } finally { $('btnJoin').disabled = false; }
}
$('btnJoin').onclick = join;
['joinName', 'joinCode'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') join(); }));

// What this phone is in the current word: the guesser, a clue-giver, or watching (the other team).
function myPart(s = S) {
  if (!s || !s.guesser) return 'none';
  if (s.guesser === ME) return 'guesser';
  if (giversOf(s).some(p => p.pid === ME)) return 'giver';
  return 'watch';
}
let sentFor = -1;
function playerRender() {
  if (role !== 'player') return;
  const s = S;
  if (!s) { show('join'); $('joinMsg').textContent = 'This game has ended. Join another room.'; return; }
  const me = s.players && s.players[ME];
  if (!me) {   // removed by the host (or not added yet)
    show('play'); $('mBanner').textContent = "You're not in this game"; $('mSub').textContent = 'Join again to play.';
    $('mScores').innerHTML = ''; hideAll(); act('Join again', () => { show('join'); });
    return;
  }
  show('play');
  $('mScores').innerHTML = s.step === 'lobby' ? '' : scoresHtml();
  hideAll();
  const part = myPart(), g = nameOf(s.guesser), list = clueList(), keep = list.filter(c => !c.out);
  const res = s.results && s.results[s.round];
  $('mBanner').className = 'banner';
  if (s.step === 'lobby') {
    $('mBanner').textContent = `Hi, ${me.name}!`;
    $('mSub').textContent = teamsMode() ? (me.team ? `You're on ${teamName(me.team)}. Waiting for the host to start.` : 'Pick a team:') : 'Waiting for the host to start.';
    if (teamsMode()) {
      $('mTeamPick').classList.remove('hidden');
      $('mTeamPick').innerHTML = ['a', 'b'].map(t => `<button class="jw-pick jw-${t} ${me.team === t ? 'on' : ''}" data-team="${t}">${esc(teamName(t))}</button>`).join('');
    }
    return;
  }
  if (s.step === 'over') {
    const o = overText();
    $('mBanner').textContent = o.head; $('mBanner').className = 'banner win'; $('mSub').textContent = o.sub;
    return;
  }
  // Joined mid-game with no team yet: pick one (and watch until then).
  if (teamsMode() && !me.team) {
    $('mTeamPick').classList.remove('hidden');
    $('mTeamPick').innerHTML = ['a', 'b'].map(t => `<button class="jw-pick jw-${t}" data-team="${t}">Join ${esc(teamName(t))}</button>`).join('');
  }
  const yourTeam = teamsMode() ? ` (${teamName(s.team)})` : '';
  if (s.step === 'result') {
    const r = res ? res.res : '';
    $('mBanner').textContent = r === 'right' ? `Right! ${part === 'guesser' ? 'You' : g} got it.` : r === 'wrong' ? 'Wrong!' : 'Passed.';
    $('mBanner').className = `banner jw-res-${r}`;
    $('mWord').textContent = s.word; $('mWord').classList.remove('hidden');
    showClues(list, true);
    act(isLast() ? 'See the final score' : 'Next word', () => send({ want: { next: s.round } }), 'primary');
    return;
  }
  if (part === 'guesser') {
    if (s.step === 'guess') {
      $('mBanner').textContent = 'Your clues:';
      $('mSub').textContent = 'Say your guess out loud: one guess.';
      showClues(keep, false, true);
      act('Pass', () => verdict('pass'));
    } else {
      $('mBanner').textContent = "You're guessing!";
      $('mSub').textContent = s.step === 'clues' ? `Your team is writing clues${yourTeam}. Don't peek at their phones.` : 'They\'re checking the clues…';
    }
    return;
  }
  // Clue-givers, and the other team watching.
  $('mWord').textContent = s.word; $('mWord').classList.remove('hidden');
  if (part === 'watch') {
    $('mBanner').textContent = `${teamName(s.team)}'s turn`;
    $('mSub').textContent = `${g} is guessing. Watch quietly!`;
    if (s.step === 'guess' || s.step === 'review') showClues(list, true);
    return;
  }
  const mine = s.clues && s.clues[s.round] && s.clues[s.round][ME];
  if (s.step === 'clues') {
    $('mBanner').textContent = `Give ${g} a clue`;
    $('mSub').textContent = 'One word. Matching clues cancel out, so be original!';
    $('mWrite').classList.remove('hidden');
    if (sentFor !== s.round) { $('clueInput').value = mine || ''; $('clueMsg').textContent = ''; }
    if (mine) $('clueMsg').textContent = `Sent: ${mine}. You can change it until everyone's in.`;
    sentFor = s.round;
  } else if (s.step === 'review') {
    $('mBanner').textContent = 'Check the clues';
    $('mSub').textContent = 'Crossed-out clues are cancelled. Tap one to cancel or keep it (same root, a spelling of the word…), then show them.';
    showClues(list, true, false, true);
    act(`Show the clues to ${g}`, () => send({ step: 'guess' }), 'primary');
  } else if (s.step === 'guess') {
    $('mBanner').textContent = `${g} is guessing…`;
    $('mSub').textContent = 'Did they say the word?';
    showClues(keep);
    act('Right', () => verdict('right'), 'good'); act('Wrong', () => verdict('wrong'), 'bad');
  }
}
const isLast = () => { const s = { ...S }; return isOver(s); };
function hideAll() {
  ['mWord', 'mWrite', 'mHint', 'mTeamPick'].forEach(id => $(id).classList.add('hidden'));
  $('mClues').innerHTML = ''; $('mActions').innerHTML = ''; $('mSub').textContent = '';
}
function act(label, fn, cls = '') { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; $('mActions').append(b); }
// The clue list on a phone: all = with the cancelled ones crossed out; big = for the guesser;
// taps = a clue-giver can tap a clue to cancel or keep it.
function showClues(list, all = false, big = false, taps = false) {
  $('mClues').innerHTML = !list.length ? '<span class="muted">No clues.</span>' : list.map(c =>
    `<${taps ? 'button' : 'span'} class="jw-clue ${big ? '' : 'small'} ${all && c.out ? 'out' : ''}" data-pid="${c.pid}">${esc(c.text)}${all ? `<small>${esc(c.name)}${c.out && c.auto && !(S.cancel && S.cancel[S.round] && c.pid in S.cancel[S.round]) ? ` · ${c.auto}` : ''}</small>` : ''}</${taps ? 'button' : 'span'}>`).join('');
}
$('mClues').addEventListener('click', e => {
  const b = e.target.closest('button.jw-clue'); if (!b || !S || S.step !== 'review') return;
  const c = clueList().find(x => x.pid === b.dataset.pid); if (!c) return;
  send({ [`cancel/${S.round}/${c.pid}`]: !c.out });
});
$('mTeamPick').addEventListener('click', e => {
  const b = e.target.closest('[data-team]'); if (!b) return;
  send({ [`players/${ME}/team`]: b.dataset.team });
});
function sendClue() {
  if (!S || S.step !== 'clues' || myPart() !== 'giver') return;
  const raw = $('clueInput').value.trim();
  if (!raw) { $('clueMsg').textContent = 'Type a clue first.'; return; }
  if (/\s/.test(raw)) { $('clueMsg').textContent = 'Just one word: no spaces.'; return; }
  const text = raw.toUpperCase().slice(0, 24);
  if (badForWord(text, S.word)) { $('clueMsg').textContent = "That's (part of) the secret word. Try another."; return; }
  send({ [`clues/${S.round}/${ME}`]: text });
  $('clueMsg').textContent = `Sent: ${text}.`;
  $('clueInput').blur();
}
$('btnSendClue').onclick = sendClue;
$('clueInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendClue(); });

// ═════════════ PAGE ═════════════
const howto = $('howto');
const openHow = () => { howto.classList.remove('hidden'); $('btnHowClose').focus(); };
const closeHow = () => howto.classList.add('hidden');
$('btnHowClose').onclick = closeHow;
howto.addEventListener('click', e => { if (e.target === howto) closeHow(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHow(); });

const showAbout = initAbout({ version: VERSION, released: RELEASED, cardsText: async () => { await loadWords(); return `${words.length.toLocaleString()} words, from Password's list.`; } });
initMenu(() => [
  ...(role === 'host' && S ? [['New game', newGame]] : []),
  ...(role === 'host' && S && ['clues', 'review'].includes(S.step) ? [['Skip this word', () => deal(S, { same: true })]] : []),
  ...(role === 'host' && S && !['lobby', 'over'].includes(S.step) ? [['End game now', () => send({ step: 'over' })]] : []),
  ...(role === 'host' ? [['Close room', async () => { if (await ask('Players will need a new code next time.', { title: 'Close this room?', ok: 'Close room' })) { st.set(HOST_STORE, null); location.href = location.pathname; } }, 'danger']] : []),
  ...(role === 'player' ? [['Leave game', async () => { if (await ask('', { title: 'Leave this game?', ok: 'Leave' })) { await send({ [`players/${ME}`]: null }); st.set(PLAY_STORE, null); location.href = location.pathname; } }, 'danger']] : []),
  ['How to play', openHow],
  ['About', showAbout],
], { leaving: () => role && S && !['lobby', 'over'].includes(S.step) ? 'Leave this game and go to the home page?' : '' });

$('btnHost').onclick = startHost;
$('btnJoinHome').onclick = () => startJoin('');

// Start: a QR link joins as a player; a reload carries on as host or player.
const joinCode = (params.get('join') || '').toUpperCase();
const playing = st.get(PLAY_STORE, null), hosting = st.get(HOST_STORE, null);
if (location.hash === '#host' && hosting && Date.now() - hosting.at < HOST_FOR) startHost();
else if (joinCode) {
  await startJoin(joinCode);
  if (playing && playing.code === joinCode && st.get('name', '')) join();   // a reload: straight back in
} else show('home');
