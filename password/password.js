import { $, ask, esc, store, lines, shuffle, keepAwake, initMenu, initAbout, beep } from '../shared/common.js';
import { hostRoom, viewRoom, savedRoom, toServer, serverNow } from '../shared/rooms.js';

// Password: two teams, each a clue-giver and a guesser. The team that's guessing gets a
// one-word clue and one guess; wrong passes the next clue to the other team, and after
// MAX_CLUES clues nobody scores the word. Two ways to score:
//   classic  a word is worth 10, less one per clue; first to the target score wins
//   simple   a word is worth 1; play a set number of rounds, each team starting one word a round
// The moderator runs it; viewers are a clue-giver screen (with the word) or a scoreboard
// (without it), synced through a room (shared/rooms.js).
const VERSION = '1.5', RELEASED = '2026-11-21';
const START_VALUE = 10, MAX_CLUES = 10;

const sections = ['home', 'join', 'viewer', 'setup', 'play', 'done', 'over'];
let at = 'home', role = null, room = null;
const show = name => { at = name; sections.forEach(s => $(s).classList.toggle('hidden', s !== name)); };
const st = store('pw');

// How to play
const howto = $('howto');
const openHow = () => { howto.classList.remove('hidden'); $('btnHowClose').focus(); };
const closeHow = () => howto.classList.add('hidden');
$('btnHowClose').onclick = closeHow;
howto.addEventListener('click', e => { if (e.target === howto) closeHow(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHow(); });

// ───────────── Shared drawing ─────────────
// Scores, with the guessing team's box lit in its colour and marked "guessing".
function scoresHtml(teams, guessing) {
  return teams.map((t, i) => {
    const on = i === guessing;
    return `<div class="team ${on ? 'g' + i : ''}">${on ? '<div class="who">Guessing</div>' : ''}${esc(t.name)}<b>${t.score}</b></div>`;
  }).join('');
}
function turnHtml(teams, guessing) {
  return `${esc(teams[guessing].name)} guessing<small>Their clue-giver gives a one-word clue</small>`;
}
// The big number: what the word is worth (classic) or which clue this is (simple).
const worthHtml = s => s.mode === 'simple'
  ? `<span class="clue">Clue ${s.clue}</span><small>of ${MAX_CLUES} · 1 point if right</small>`
  : `${s.value}<small>point${s.value === 1 ? '' : 's'}</small>`;
const points = s => s.mode === 'simple' ? 1 : s.value;
const roundOf = s => Math.floor(s.played / 2) + 1;
// The line under the turn banner: the goal (classic) or how far through the rounds (simple).
const progressText = s => s.mode === 'simple'
  ? `Round ${Math.min(roundOf(s), s.rounds)} of ${s.rounds}`
  : `Play to ${s.target}`;
const subLine = html => `<div class="muted" style="font-size:18px;font-weight:400">${html}</div>`;
// Under the winner: the last word and who got it.
const lastWordHtml = (L, teams) => subLine(`The last word was <b>${esc(L.word)}</b>${L.team === null ? ', and nobody got it' : `, for ${esc(teams[L.team].name)} +${L.points}`}`);
// Who won, or a tie (simple scoring can end level).
function resultText(s) {
  const [a, b] = s.teams;
  if (a.score === b.score) return "It's a tie! 🤝";
  return `${(a.score > b.score ? a : b).name} wins! 🎉`;
}

// ───────────── Moderator ─────────────
let words = [];
// G is the whole game; it's saved after every change so a reload carries on.
// phase: setup | word | scored | dead | over. played counts finished words (skips don't count).
let G = null, history = [];
const fresh = () => ({
  phase: 'setup', mode: 'classic', teams: [{ name: 'Team A', score: 0 }, { name: 'Team B', score: 0 }],
  target: 25, rounds: 10, played: 0, level: 'all', clueSecs: 0,
  starter: 0, guessing: 0, value: START_VALUE, clue: 1, word: '', last: null, clueEnds: 0,
});

// Word levels (levels.txt: "word<TAB>easy" or "hard"; the rest are medium). The setup screen's
// Words choice: all, easy only, or harder (medium and hard).
let levels = new Map();
const levelOf = w => levels.get(w.toLowerCase()) || 'medium';
const fitsLevel = (w, level = G ? G.level : 'all') => level === 'easy' ? levelOf(w) === 'easy' : level === 'hard' ? levelOf(w) !== 'easy' : true;
// Deck: a shuffled order of the words, saved so words don't repeat until it runs out. A draw
// takes the next word that fits the chosen level; when none is left, those words go back in.
function draw() {
  let d = st.get('deck', null);
  if (!d || d.n !== words.length || !Array.isArray(d.order)) d = { n: words.length, order: shuffle(words.map((_, i) => i)) };
  let at = d.order.findLastIndex(i => fitsLevel(words[i]));
  if (at < 0) {
    const back = shuffle(words.map((_, i) => i).filter(i => fitsLevel(words[i]) && !d.order.includes(i)));
    d.order = back.concat(d.order); at = d.order.findLastIndex(i => fitsLevel(words[i]));
  }
  const w = words[d.order.splice(at, 1)[0]]; st.set('deck', d); return w;
}
const deckLeft = () => {
  const d = st.get('deck', null), level = $('optLevel').value;
  return (d && d.n === words.length ? d.order.map(i => words[i]) : words).filter(w => fitsLevel(w, level)).length;
};

// The game and its undo history are saved after every change, with the time, so a reload (or a
// tab the phone threw away) carries on, Undo included.
function save() { st.set('game', G); st.set('history', history); st.set('savedAt', Date.now()); if (room) room.send(); render(); }
// A second tap within TAP_GAP of the last one is a double-tap, and is ignored: one Wrong would
// otherwise cost 2 points and hand the clue straight back.
const TAP_GAP = 500;
let lastAct = 0;
function act(fn, { guard = false } = {}) {
  if (guard && Date.now() - lastAct < TAP_GAP) return;
  lastAct = Date.now();
  history.push(JSON.stringify(G)); if (history.length > 50) history.shift(); fn(); save();
}
function undo() { if (!history.length) return; G = JSON.parse(history.pop()); lastAct = 0; if (G.phase === 'word') startClue(); save(); }

// A fresh word: worth the full value, first clue to the team that starts it. skip() swaps the
// word for another the same way, without counting it.
function newWord() { G.word = draw(); G.value = START_VALUE; G.clue = 1; G.guessing = G.starter; G.phase = 'word'; G.last = null; startClue(); }
// The optional clue timer (G.clueSecs, 0 for none): each clue gets that long, shown as a countdown
// on every screen, with a buzz when it runs out. The moderator still taps Wrong.
function startClue() { G.clueEnds = G.clueSecs ? Date.now() + G.clueSecs * 1000 : 0; }
// A word is finished (scored or not): count it, give the next word's first clue to the other
// team, and end the game if someone reached the target (classic) or the rounds are done (simple).
function finishWord(phase) {
  G.played++; G.starter = 1 - G.starter;
  const over = G.mode === 'simple' ? G.played >= G.rounds * 2 : G.teams.some(t => t.score >= G.target);
  G.phase = over ? 'over' : phase;
}
function got() {
  act(() => {
    const p = points(G); G.teams[G.guessing].score += p;
    G.last = { team: G.guessing, points: p, word: G.word };
    finishWord('scored'); beep(1046, .12);
  }, { guard: true });
}
function wrong() {
  act(() => {
    G.value--; G.clue++; startClue();
    if (G.clue > MAX_CLUES) { G.last = { team: null, points: 0, word: G.word }; finishWord('dead'); beep(220, .4, .25); }
    else G.guessing = 1 - G.guessing;
  }, { guard: true });
}
function skip() { act(newWord, { guard: true }); }

function startGame() {
  act(() => {
    const a = $('optTeamA').value.trim() || 'Team A', b = $('optTeamB').value.trim() || 'Team B';
    G.teams = [{ name: a, score: 0 }, { name: b, score: 0 }];
    G.mode = $('optMode').value; G.target = Number($('optTarget').value); G.rounds = Number($('optRounds').value);
    G.level = $('optLevel').value; G.clueSecs = Number($('optClueTime').value);
    G.starter = 0; G.played = 0;
    st.set('setup', { a, b, mode: G.mode, target: G.target, rounds: G.rounds, level: G.level, clueSecs: G.clueSecs });
    newWord();
  });
  keepAwake();
}
function playAgain() { act(() => { G.teams.forEach(t => t.score = 0); G.starter = 0; G.played = 0; newWord(); }); }
async function newGame() {
  if (!await ask('Both teams go back to 0.', { title: 'Start a new game?', ok: 'New game' })) return;
  act(() => {
    const k = G; G = fresh();
    G.teams = k.teams.map(t => ({ name: t.name, score: 0 })); G.mode = k.mode; G.target = k.target; G.rounds = k.rounds;
  });
}

// Change names or target (menu, mid-game): the setup screen with the game's settings, and Save
// changes instead of Start game. Scores carry on; the scoring mode can't change mid-game.
let editing = false;
function startEdit() {
  editing = true;
  $('optTeamA').value = G.teams[0].name; $('optTeamB').value = G.teams[1].name;
  $('optMode').value = G.mode; $('optTarget').value = String(G.target); $('optRounds').value = String(G.rounds);
  $('optLevel').value = G.level || 'all'; $('optClueTime').value = String(G.clueSecs || 0);
  render();
}
function saveEdit() {
  editing = false;
  act(() => {
    G.teams[0].name = $('optTeamA').value.trim() || 'Team A'; G.teams[1].name = $('optTeamB').value.trim() || 'Team B';
    G.target = Number($('optTarget').value); G.rounds = Number($('optRounds').value);
    G.level = $('optLevel').value; G.clueSecs = Number($('optClueTime').value);
    if (G.phase === 'word') startClue();
    // A lower target (or fewer rounds) can end the game at once.
    const over = G.mode === 'simple' ? G.played >= G.rounds * 2 : G.teams.some(t => t.score >= G.target);
    if (over && G.phase !== 'word') G.phase = 'over';
  });
}
$('btnSaveEdit').onclick = saveEdit;
$('btnCancelEdit').onclick = () => { editing = false; render(); };

function render() {
  if (role !== 'moderator') return;
  const { teams, guessing } = G;
  ['pScores', 'dScores', 'oScores'].forEach(id => $(id).innerHTML = scoresHtml(teams, G.phase === 'word' ? guessing : -1));
  const simple = $('optMode').value === 'simple';
  $('boxTarget').classList.toggle('hidden', simple); $('boxRounds').classList.toggle('hidden', !simple);
  $('deckInfo').textContent = (simple
    ? `Each right answer scores 1. In every round both teams start one word, so ${$('optRounds').value} rounds is ${$('optRounds').value * 2} words.`
    : `Each word starts at ${START_VALUE} points and loses one with every wrong guess.`)
    + ` ${words.length.toLocaleString()} words; ${deckLeft().toLocaleString()} left before they repeat.`;
  for (const id of ['btnUndo', 'btnUndo2', 'btnUndo3', 'btnUndo0']) $(id).disabled = !history.length;
  $('btnUndo0').classList.toggle('hidden', editing || !history.length);   // undo a New game from the menu
  $('btnStart').classList.toggle('hidden', editing);
  $('editRow').classList.toggle('hidden', !editing);
  $('optMode').disabled = editing;
  if (editing) return show('setup');
  if (G.phase === 'setup') return show('setup');
  if (G.phase === 'word') {
    $('pTurn').className = 'turn t' + guessing; $('pTurn').innerHTML = turnHtml(teams, guessing);
    $('pWorth').innerHTML = worthHtml(G);
    $('pProgress').textContent = progressText(G);
    $('pWord').textContent = G.word;
    $('btnGot').innerHTML = `Got it<small>${esc(teams[guessing].name)} +${points(G)}</small>`;
    $('btnWrong').innerHTML = `Wrong<small>${G.clue < MAX_CLUES ? (G.mode === 'simple' ? 'no points lost · ' : '−1 · ') + 'pass to ' + esc(teams[1 - guessing].name) : 'nobody scores'}</small>`;
    clueTick();
    return show('play');
  }
  if (G.phase === 'over') {
    $('oBanner').innerHTML = esc(resultText(G)) + (G.last ? lastWordHtml(G.last, teams) : '');
    return show('over');
  }
  const L = G.last;
  $('dBanner').textContent = L.team === null ? 'Nobody got it' : `${teams[L.team].name} +${L.points}`;
  $('dWord').innerHTML = `The word was <b>${esc(L.word)}</b> · ${esc(teams[G.starter].name)} gives the first clue next`
    + (G.mode === 'simple' ? `<br>${esc(progressText(G))}` : '');
  show('done');
}

// What viewers get. Every screen in the room gets the same state; the scoreboard just doesn't show the word.
function viewState() {
  const s = { phase: G.phase, mode: G.mode, teams: G.teams, guessing: G.guessing, value: G.value, clue: G.clue,
    target: G.target, rounds: G.rounds, played: G.played };
  if (G.phase === 'word') { s.word = G.word; if (G.clueEnds) s.clueEnds = toServer(G.clueEnds); }
  if (G.last) s.last = G.last;
  if (G.phase !== 'setup') s.starter = G.starter;
  return s;
}

async function leaveGame() {
  if (!await ask('Viewers will see that it has ended.', { title: 'Leave this game?', ok: 'Leave' })) return;
  if (room) await room.close();
  st.set('game', null);
  location.href = location.pathname;
}

let resuming = false;   // a reload of this tab's own game: carry on without asking
async function startModerator() {
  if (role) return;
  role = 'moderator'; show('setup');
  const s = st.get('setup', null);
  if (s) {
    $('optTeamA').value = s.a; $('optTeamB').value = s.b; $('optTarget').value = String(s.target);
    $('optMode').value = s.mode || 'classic'; $('optRounds').value = String(s.rounds || 10);
    $('optLevel').value = s.level || 'all'; $('optClueTime').value = String(s.clueSecs || 0);
  }
  try {
    levels = new Map((await lines('levels.txt').catch(() => [])).filter(l => !l.startsWith('#')).map(l => l.split('\t')).map(([w, lv]) => [w.toLowerCase(), lv]));
  } catch {}
  try { words = await lines('words.txt'); } catch {
    $('deckInfo').textContent = 'Could not load words.txt — open this page from a web server, not as a local file.';
    $('btnStart').disabled = true; return;
  }
  // A game saved by version 1.0 has no mode, clue or played: fill them in.
  const saved = st.get('game', null);
  G = saved ? { ...fresh(), clue: START_VALUE - (saved.value ?? START_VALUE) + 1, ...saved } : fresh();
  history = saved ? (st.get('history', []) || []) : [];
  // A game left part-way (not just reloaded in this tab): ask whether to carry on with it.
  if (saved && G.phase !== 'setup' && !resuming) {
    const ago = Math.round((Date.now() - (st.get('savedAt', 0) || 0)) / 60000);
    const when = !st.get('savedAt', 0) ? '' : ago < 1 ? ' just now' : ago < 60 ? ` ${ago} min ago` : ago < 1440 ? ` ${Math.round(ago / 60)} h ago` : ` ${Math.round(ago / 1440)} days ago`;
    const go = await ask(`${G.teams.map(t => `${t.name} ${t.score}`).join(' · ')}, left${when}.`, { title: 'Carry on the last game?', ok: 'Carry on', cancel: 'New game' });
    if (go === false) {
      const k = G; G = fresh(); history = [];
      G.teams = k.teams.map(t => ({ name: t.name, score: 0 })); G.mode = k.mode; G.target = k.target; G.rounds = k.rounds;
    }
  }
  room = hostRoom({ game: 'pw', state: viewState });
  save();
  if (G.phase !== 'setup') keepAwake();
}

$('btnStart').onclick = startGame;
$('optMode').onchange = $('optRounds').onchange = $('optLevel').onchange = () => render();
$('btnGot').onclick = got;
$('btnWrong').onclick = wrong;
$('btnSkip').onclick = skip;
$('btnNext').onclick = () => act(newWord);
$('btnAgain').onclick = playAgain;
['btnUndo', 'btnUndo2', 'btnUndo3', 'btnUndo0'].forEach(id => $(id).onclick = undo);

// ───────────── Viewers ─────────────
// A clue-giver screen shows the word; a scoreboard never shows it.
function renderView(s, board) {
  const teams = s.teams || [];
  const playing = s.phase === 'word';
  $('vScores').innerHTML = teams.length ? scoresHtml(teams, playing ? s.guessing : -1) : '';
  $('vTurn').className = playing ? 'turn t' + s.guessing : 'hidden';
  $('vTurn').innerHTML = playing ? turnHtml(teams, s.guessing) : '';
  $('vWorth').innerHTML = playing ? worthHtml(s) : '';
  $('vProgress').textContent = s.teams && s.phase !== 'closed' && s.phase !== 'setup' && s.phase !== 'over' ? progressText(s) : '';
  $('vWord').textContent = playing && !board ? s.word : '';
  const L = s.last, next = teams[s.starter] ? ` · ${esc(teams[s.starter].name)} gives the first clue next` : '';
  $('vBanner').innerHTML =
    s.phase === 'closed' ? 'The moderator ended this game.' :
    s.phase === 'setup' ? 'Waiting for the moderator…' :
    s.phase === 'over' ? esc(resultText(s)) + (L ? lastWordHtml(L, teams) : '') :
    s.phase === 'scored' ? `${esc(teams[L.team].name)} +${L.points}${subLine(`The word was <b>${esc(L.word)}</b>${next}`)}` :
    s.phase === 'dead' ? `Nobody got it${subLine(`The word was <b>${esc(L.word)}</b>${next}`)}` :
    '';
  viewClue = playing && s.clueEnds ? s.clueEnds : 0; clueTick();
}
// The clue timer's countdown (moderator: G.clueEnds; viewers: the server time from the room).
let viewClue = 0, clueTimer = null, buzzed = 0;
function clueTick() {
  const mod = role === 'moderator', ends = mod ? (G && G.phase === 'word' ? G.clueEnds : 0) : viewClue;
  const el = mod ? $('pClue') : $('vClue');
  clearTimeout(clueTimer);
  if (!ends) { el.textContent = ''; el.classList.add('hidden'); return; }
  const left = ends - (mod ? Date.now() : serverNow()), sec = Math.max(0, Math.ceil(left / 1000));
  el.classList.remove('hidden'); el.classList.toggle('low', sec <= 5);
  el.textContent = sec ? `0:${String(sec).padStart(2, '0')}` : 'Time!';
  if (mod && !sec && buzzed !== ends) { buzzed = ends; beep(220, .4, .25); }
  if (sec) clueTimer = setTimeout(clueTick, 250);
}
const viewer = viewRoom({ game: 'pw', show, render: renderView, params: { view: 'clue', board: 'board' } });
function startViewer(code, board) { role = 'viewer'; viewer.open(code, board); }
// A QR code link (?join=CODE) lands on the home screen so the person picks clue giver or scoreboard.
const params = new URLSearchParams(location.search);
const joining = (params.get('join') || '').toUpperCase();
$('btnClue').onclick = () => startViewer(joining, false);
$('btnBoard').onclick = () => startViewer(joining, true);
$('btnModerator').onclick = startModerator;

// ───────────── Menu / About ─────────────
const showAbout = initAbout({
  version: VERSION, released: RELEASED,
  cardsText: async () => `${(await lines('words.txt')).length.toLocaleString()} words.`,
});
initMenu(() => {
  const items = [];
  if (role === 'moderator') items.push(['New game', newGame], ...(G && G.phase !== 'setup' && !editing ? [['Change names or target', startEdit]] : []), ['Leave game', leaveGame, 'danger']);
  else if (role === 'viewer') items.push(['Leave room', () => { location.href = location.pathname; }, 'danger']);
  items.push(['How to play', openHow]);
  return [...items, ['About', showAbout]];
}, { leaving: () => role === 'viewer' || (role === 'moderator' && G && G.phase !== 'setup') ? 'Leave this game and go to the home page?' : '' });

// ───────────── Start ─────────────
if (params.get('clue')) startViewer(params.get('clue'), false);
else if (params.get('board')) startViewer(params.get('board'), true);
else if (joining) {
  $('btnModerator').classList.add('hidden');
  $('joinNote').classList.remove('hidden'); $('joinNote').textContent = `Joining room ${joining}: pick a screen`;
  show('home');
}
else if (savedRoom('pw')) { resuming = true; startModerator(); }   // a moderator reloading keeps their room and game
else show('home');
