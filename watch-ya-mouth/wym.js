import { $, lines, initMenu, initAbout, createRounds } from '../shared/common.js';

// Watch Ya Mouth: one device, held by the reader. Phrases come from phrases.txt, one per line.
const VERSION = '1.8', RELEASED = '2026-11-21';

const sections = ['setup', 'ready', 'play', 'over'];
const show = name => sections.forEach(s => $(s).classList.toggle('hidden', s !== name));

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
  cardsText: async () => `${(await lines('phrases.txt')).length} phrases.`,
});
initMenu(() => [
  ...(G ? [['New game', G.newGame], ['Reshuffle deck', G.reshuffle]] : []),
  ['How to play', openHow],
  ['About', showAbout],
], { leaving: () => G && ['playing', 'paused'].includes(G.phase) ? 'Stop this round and go to the home page?' : '' });

show('setup');
try {
  const phrases = [...new Set(await lines('phrases.txt'))].map(phrase => ({ phrase }));
  G = createRounds({
    prefix: 'wym', cards: phrases, show, readyFirst: true,
    renderCard: c => { $('pPhrase').textContent = c.phrase; },
    result: r => [r.phrase],
    readyText: team => `${team}, you're up`,
  });
} catch {
  $('deckInfo').textContent = 'Could not load phrases.txt — open this page from a web server, not as a local file.';
  $('btnStart').disabled = true;
}
