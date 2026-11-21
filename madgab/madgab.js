import { $, ask, lines, store, keepAwake, initMenu, initAbout, createRounds } from '../shared/common.js';
import { hostRoom, viewRoom, roundState, savedRoom } from '../shared/rooms.js';

// Mad Gab: a moderator device runs the game; viewer devices show the team only the puzzle.
// They sync through a room (shared/rooms.js).
const VERSION = '1.13', RELEASED = '2026-11-21';

const sections = ['home', 'demo', 'join', 'viewer', 'setup', 'ready', 'play', 'over'];
const show = name => sections.forEach(s => $(s).classList.toggle('hidden', s !== name));
const st = store('mg');

let role = null;

// ───────────────────────── MODERATOR ─────────────────────────
let G = null;               // the round engine, once the cards are loaded
let room = null;
const level = () => $('optLevel').value;

async function loadCards() {
  // Each line is puzzle,answer[,easy|hard]. Answers may contain commas, so only a
  // trailing easy/hard counts as the level; with no level the card is hard.
  const text = await lines('flashcards.txt');
  const seen = new Set(), cards = [];
  for (let line of text) {
    const m = line.match(/,\s*(easy|hard)\s*$/i);
    if (m) line = line.slice(0, m.index);
    const i = line.indexOf(',');
    if (i < 1) continue;
    const puzzle = line.slice(0, i).trim(), answer = line.slice(i + 1).trim();
    if (!puzzle || !answer || seen.has(puzzle.toLowerCase())) continue;
    seen.add(puzzle.toLowerCase());
    cards.push({ puzzle, answer, hard: !m || m[1].toLowerCase() === 'hard' });
  }
  return cards;
}

// One phone, passed around (optCoverAns): the answer stays blurred until the moderator taps it,
// so the person holding the phone can read the puzzle out without seeing the answer.
function coverAnswer(on) {
  $('pAnswer').classList.toggle('covered', on);
  $('pAnswerHint').classList.toggle('hidden', !on);
}
$('pAnswer').onclick = () => coverAnswer(!$('pAnswer').classList.contains('covered'));
$('pAnswerHint').onclick = () => coverAnswer(false);

async function startModerator() {
  role = 'moderator'; show('setup'); keepAwake();
  $('optLevel').value = st.get('level', 'all');
  $('optCoverAns').checked = st.get('coverAns', false);
  $('optCoverAns').onchange = () => st.set('coverAns', $('optCoverAns').checked);
  let cards;
  try { cards = await loadCards(); } catch {
    $('deckInfo').textContent = 'Could not load flashcards.txt — open this page from a web server, not as a local file.';
    return;
  }
  G = createRounds({
    prefix: 'mg', cards, show,
    fits: i => level() === 'all' || (level() === 'hard') === cards[i].hard,
    deckName: () => ({ easy: 'easy', hard: 'hard', all: '' }[level()]),
    info: () => `${$('optLevel').selectedOptions[0].textContent} cards`,
    renderCard: c => { $('pPuzzle').textContent = c.puzzle; $('pAnswer').textContent = c.answer; coverAnswer($('optCoverAns').checked); },
    result: r => [r.answer, r.puzzle],
    onChange: () => room && room.send(),
  });
  $('optLevel').onchange = () => { st.set('level', level()); G.updateDeckInfo(); };
  // What the viewers see: the puzzle, never the answer, until the round is over.
  room = hostRoom({ game: 'mg', state: () => roundState(G, { card: c => c.puzzle, result: r => [r.answer, r.puzzle] }) });
}

async function leaveGame() {
  if (!await ask('The viewer will see that it has ended.', { title: 'Leave this game?', ok: 'Leave' })) return;
  if (G) G.stop();
  if (room) await room.close();
  location.href = location.pathname;
}

$('btnModerator').onclick = startModerator;

// ───────────────────────── VIEWER ─────────────────────────
const viewer = viewRoom({ game: 'mg', show });
function startViewer(code) { role = 'viewer'; viewer.open(code); }
$('btnViewer').onclick = () => startViewer('');

// ───────────────────────── DEMO ─────────────────────────
// Examples that aren't in the deck: show the puzzle, then the answer.
const DEMO = [{ puzzle: 'Olive Yew', answer: 'I Love You' }];
let demoAt = 0, demoShown = false;
function demoRender() {
  const done = demoAt >= DEMO.length;
  ['dStep', 'dPuzzle', 'dHint', 'btnDemoNext'].forEach(id => $(id).classList.toggle('hidden', done));
  $('dHow').classList.toggle('hidden', !done);
  $('dAnswer').classList.toggle('hidden', done || !demoShown);
  if (done) return;
  const c = DEMO[demoAt];
  $('dStep').textContent = DEMO.length > 1 ? `Example ${demoAt + 1} of ${DEMO.length}` : 'Example';
  $('dPuzzle').textContent = c.puzzle;
  $('dAnswer').textContent = c.answer;
  $('dHint').classList.toggle('hidden', demoShown);
  $('btnDemoNext').textContent = !demoShown ? 'Show the answer' : demoAt + 1 < DEMO.length ? 'Next example' : 'How to play';
}
$('btnDemo').onclick = () => { demoAt = 0; demoShown = false; show('demo'); demoRender(); };
$('btnDemoNext').onclick = () => { if (!demoShown) demoShown = true; else { demoAt++; demoShown = false; } demoRender(); };
$('btnDemoAgain').onclick = () => { demoAt = 0; demoShown = false; demoRender(); };
$('btnDemoDone').onclick = () => show('home');

// ───────────────────────── MENU / ABOUT ─────────────────────────
const showAbout = initAbout({
  version: VERSION, released: RELEASED,
  async cardsText() {
    const cards = await loadCards();
    const h = cards.filter(c => c.hard).length;
    return `${cards.length.toLocaleString()} cards: ${(cards.length - h).toLocaleString()} easy, ${h.toLocaleString()} hard.`;
  },
});
initMenu(() => {
  const items = [];
  if (role === 'moderator') items.push(
    ['New game', () => G && G.newGame()],
    ['Reshuffle deck', () => G && G.reshuffle()],
    ['Leave game', leaveGame, 'danger'],
  );
  else if (role === 'viewer') items.push(['Leave room', () => { location.href = location.pathname; }, 'danger']);
  else {
    items.push(['How to play', () => $('btnDemo').click()]);
    if ($('home').classList.contains('hidden')) items.push(['Start page', () => show('home')]);
  }
  return [...items, ['About', showAbout]];
}, { leaving: () => role ? 'Leave this game and go to the home page?' : '' });

// ───────────────────────── START ─────────────────────────
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) startViewer(joinParam);
else if (savedRoom('mg')) startModerator();   // a moderator reloading keeps its room
else show('home');
