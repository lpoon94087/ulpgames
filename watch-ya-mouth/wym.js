import { $, lines, store, initMenu, initAbout, createRounds } from '../shared/common.js';

// Watch Ya Mouth: one device, held by the reader. Phrases come from phrases.txt, one per line.
const VERSION = '1.10', RELEASED = '2026-11-21';

const sections = ['setup', 'ready', 'play', 'over', 'join', 'viewer'];
const show = name => sections.forEach(s => $(s).classList.toggle('hidden', s !== name));
const st = store('wym');
const params = new URLSearchParams(location.search);

const howto = $('howto');
const openHow = () => { howto.classList.remove('hidden'); $('btnHowClose').focus(); };
const closeHow = () => howto.classList.add('hidden');
$('btnHowClose').onclick = closeHow;
howto.addEventListener('click', e => { if (e.target === howto) closeHow(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHow(); });
$('lnkHow').onclick = e => { e.preventDefault(); openHow(); };

let G = null;
const showAbout = initAbout({
  version: VERSION, released: RELEASED,
  cardsText: async () => `${(await lines('phrases.txt')).length} phrases${mine().length ? `, plus ${mine().length} of your own` : ''}.`,
});
initMenu(() => [
  ...(G ? [['New game', G.newGame], ['Reshuffle deck', G.reshuffle]] : []),
  ['How to play', openHow],
  ['About', showAbout],
], { leaving: () => G && ['playing', 'paused'].includes(G.phase) ? 'Stop this round and go to the home page?' : '' });

// Your phrases: extra phrases typed on this phone (wym.mine), mixed into the deck.
const mine = () => (st.get('mine', '') || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const mineBox = $('mine');
$('btnMine').onclick = () => { $('mineText').value = mine().join('\n'); mineBox.classList.remove('hidden'); $('mineText').focus(); };
$('btnMineCancel').onclick = () => mineBox.classList.add('hidden');
mineBox.addEventListener('click', e => { if (e.target === mineBox) mineBox.classList.add('hidden'); });
$('btnMineSave').onclick = () => { st.set('mine', $('mineText').value); location.reload(); };   // the deck is built at load

// Scores on a TV (optional): a room, like Mad Gab's, whose viewer is always a scoreboard: the
// clock, the scores and each round's results, never the phrase. Opened only when asked for.
let room = null, rooms = null;
const viewState = () => rooms.roundState(G, { card: () => '', result: r => [r.phrase] });
async function startTv() {
  if (room || !G) return;
  $('tvBox').classList.remove('hidden'); $('btnTv').classList.add('hidden');
  rooms = rooms || await import('../shared/rooms.js');
  room = rooms.hostRoom({ game: 'wym', state: viewState });
}
$('btnTv').onclick = startTv;

const viewing = params.get('board') || params.get('join');
if (viewing !== null) {
  // A scoreboard screen.
  rooms = await import('../shared/rooms.js');
  const viewer = rooms.viewRoom({ game: 'wym', show });
  viewer.open(viewing.toUpperCase(), true);
} else {
  show('setup');
  try {
    const base = await lines('phrases.txt');
    const phrases = [...new Set([...base, ...mine()])].map(phrase => ({ phrase }));
    G = createRounds({
      prefix: 'wym', cards: phrases, show, readyFirst: true,
      renderCard: c => { $('pPhrase').textContent = c.phrase; },
      result: r => [r.phrase],
      readyText: team => `${team}, you're up`,
      onChange: () => room && room.send(),
    });
    if (mine().length) $('deckInfo').textContent += ` ${mine().length} of them are your own.`;
    let tvOn = false; try { tvOn = !!sessionStorage.getItem('wym.code'); } catch {}
    if (tvOn) startTv();   // a reload keeps the TV's room (without loading the database otherwise)
  } catch {
    $('deckInfo').textContent = 'Could not load phrases.txt — open this page from a web server, not as a local file.';
    $('btnStart').disabled = true;
  }
}
