import { $, ask, store, lines, keepAwake, initMenu, initAbout, createRounds } from '../shared/common.js';
import { hostRoom, viewRoom, roundState, savedRoom } from '../shared/rooms.js';

// Word Generator: words for Charades, Pictionary, Password and the like.
// The lists are lists/<id>.txt (one word per line), described by lists.json.
// "Just words" hands out one word at a time; timed rounds use the shared round engine.
// Like Mad Gab, a device is either the moderator (every control; works on its own too)
// or a read-only viewer of the moderator's word, synced through a room (shared/rooms.js).
const VERSION = '1.13', RELEASED = '2026-11-21';

const sections = ['home', 'setup', 'free', 'ready', 'play', 'over', 'join', 'viewer'];
let at = 'home', room = null, role = null;
const show = name => {
  at = name; sections.forEach(s => $(s).classList.toggle('hidden', s !== name));
  if (room) room.send();
};
const st = store('wg');

// How to play
const howto = $('howto');
const openHow = () => { howto.classList.remove('hidden'); $('btnHowClose').focus(); };
const closeHow = () => howto.classList.add('hidden');
$('btnHowClose').onclick = closeHow;
howto.addEventListener('click', e => { if (e.target === howto) closeHow(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHow(); });

let G = null, lists = [], cards = [];
const byId = new Map();
// Load lists.json and every list once, for the moderator or the About box. A list that fails to
// load is left out (the others still work); if lists.json itself fails, the next try loads again.
let loading = null, missing = [];
const loadLists = () => loading || (loading = (async () => {
  const all = await fetch('lists.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const words = await Promise.allSettled(all.map(l => lines(`lists/${l.id}.txt`)));
  lists = all.filter((l, i) => words[i].status === 'fulfilled');
  missing = all.filter((l, i) => words[i].status !== 'fulfilled').map(l => l.name);
  if (!lists.length) throw new Error('no lists');
  lists.forEach(l => byId.set(l.id, l));
  all.forEach((l, i) => { if (words[i].status === 'fulfilled') words[i].value.forEach(word => cards.push({ word, list: l.id })); });
})().catch(e => { loading = null; throw e; }));
const loadError = () => location.protocol === 'file:'
  ? 'Could not load the word lists — open this page from a web server, not as a local file.'
  : "Could not load the word lists. Check the internet connection and reload the page.";
// What to do with a word: the start of its list's tip ("Draw it", "Act it out").
const howTo = id => byId.get(id).tip.split(/[.—]/)[0].trim();
// Single words only (optSingle): leave out phrases and multi-word titles.
const single = () => $('optSingle').checked;
const isSingle = w => !/\s/.test(w);

// The list picker: a tick box per list, grouped under its family (Pictionary, Charades) or its group (Topics).
// Each heading has an "All" toggle; Everything and Clear pick every list or none.
let picked = new Set();
const groupOf = l => l.family || l.group;
function buildPicker() {
  const saved = st.get('lists', null) || (st.get('list', '') ? st.get('list', '').split(',') : ['pictionary-easy']);
  picked = new Set(saved.filter(id => byId.has(id)));
  const box = $('optLists'); box.innerHTML = '';
  for (const g of [...new Set(lists.map(groupOf))]) {
    const members = lists.filter(l => groupOf(l) === g);
    const sec = document.createElement('div'); sec.className = 'pick-group';
    sec.innerHTML = `<div class="pick-head"><b>${g}</b><button type="button" class="chip-btn"></button></div><div class="chips"></div>`;
    for (const l of members) {
      const chip = document.createElement('label'); chip.className = 'chip';
      const n = cards.filter(c => c.list === l.id).length;
      chip.innerHTML = `<input type="checkbox" value="${l.id}"> ${l.name.replace(`${g}: `, '')} <small>${n}</small>`;
      sec.querySelector('.chips').append(chip);
    }
    sec.querySelector('.chip-btn').onclick = () => {
      const all = members.every(l => picked.has(l.id));
      members.forEach(l => all ? picked.delete(l.id) : picked.add(l.id));
      onListChange();
    };
    box.append(sec);
  }
  box.onchange = e => { if (e.target.checked) picked.add(e.target.value); else picked.delete(e.target.value); onListChange(); };
  $('btnPickAll').onclick = () => { lists.forEach(l => picked.add(l.id)); onListChange(); };
  $('btnPickNone').onclick = () => { picked.clear(); onListChange(); };
}
const chosen = () => picked;
// A short name for the chosen lists: one list, "All Pictionary", "Everything", or a few names joined.
function chosenName() {
  if (!picked.size) return 'No lists';
  if (picked.size === lists.length) return 'Everything';
  const groups = [...new Set(lists.map(groupOf))], parts = [];
  for (const g of groups) {
    const members = lists.filter(l => groupOf(l) === g), on = members.filter(l => picked.has(l.id));
    if (on.length === members.length && members.length > 1) parts.push(`All ${g}`);
    else on.forEach(l => parts.push(l.name));
  }
  return parts.length <= 3 ? parts.join(' + ') : `${picked.size} lists`;
}
// The tip for the chosen lists: shared if they all agree, otherwise a general one.
function chosenTip() {
  if (!picked.size) return 'Tick at least one list.';
  const tips = [...new Set([...picked].map(id => byId.get(id).tip))];
  return tips.length === 1 ? tips[0] : 'Each word shows what to do with it.';
}
function onListChange() {
  st.set('lists', [...picked]);
  document.querySelectorAll('#optLists input').forEach(i => { i.checked = picked.has(i.value); });
  document.querySelectorAll('#optLists .pick-group').forEach(sec => {
    const ids = [...sec.querySelectorAll('input')].map(i => i.value);
    sec.querySelector('.chip-btn').textContent = ids.every(id => picked.has(id)) ? 'None' : 'All';
  });
  const n = cards.filter(c => picked.has(c.list) && (!single() || isSingle(c.word))).length;
  $('listTip').textContent = picked.size ? `${n.toLocaleString()} word${n === 1 ? '' : 's'} · ${chosenTip()}` : chosenTip();
  $('btnStart').disabled = $('btnFree').disabled = !picked.size;
  if (G) G.updateDeckInfo();
}

// ───────────── Just words ─────────────
let covered = false, freeCard = null;
// A second Next word within half a second is a double-tap, and is ignored (it would skip a word unseen).
let freeAt = 0;
function freeWord() {
  if (Date.now() - freeAt < 500) return;
  freeAt = Date.now();
  const c = freeCard = G.draw();
  $('fWord').textContent = c.word;
  // With a mix, say which list the word came from, so the player knows to draw it or act it.
  $('fTip').textContent = chosen().size > 1 ? `${byId.get(c.list).name} · ${byId.get(c.list).tip}` : chosenTip();
  setCovered($('optCover').checked);
  const left = G.left();
  $('fLeft').textContent = `${left} word${left === 1 ? '' : 's'} left before the list starts over`;
  if (room) room.send();
}
function setCovered(on) {
  covered = on;
  $('fWord').style.visibility = on ? 'hidden' : '';
  $('fHint').textContent = on ? 'Tap to see your word' : 'Tap to hide';
}
function startFree() {
  if (!G) return;
  st.set('cover', $('optCover').checked);
  $('fList').textContent = chosenName();
  freeWord(); show('free'); keepAwake();
}
$('fCard').onclick = () => setCovered(!covered);
$('fCard').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCovered(!covered); } };
$('btnFreeNext').onclick = freeWord;
$('btnFreeBack').onclick = () => show('setup');
$('btnFree').onclick = startFree;

// ───────────── Viewers ─────────────
// Viewers always see the word, even when it's covered here: they're the screen it's shown on.
function viewState() {
  if (at === 'free') return { phase: 'free', card: freeCard.word, note: byId.get(freeCard.list).name };
  if (at === 'setup') return { phase: 'waiting', banner: 'Waiting for the moderator…' };
  return roundState(G, {
    card: c => c.word, note: c => byId.get(c.list).name,
    result: r => [r.word, chosen().size > 1 ? byId.get(r.list).name : ''],
  });
}
async function leaveGame() {
  if (!await ask('Viewers will see that it has ended.', { title: 'Leave this game?', ok: 'Leave' })) return;
  if (G) G.stop();
  if (room) await room.close();
  location.href = location.pathname;
}
const viewer = viewRoom({ game: 'wg', show });
function startViewer(code, board = false) { role = 'viewer'; viewer.open(code, board); }
$('btnViewer').onclick = () => startViewer('');
$('btnBoard').onclick = () => startViewer('', true);
$('btnModerator').onclick = () => startModerator();

// ───────────── Menu / About ─────────────
const showAbout = initAbout({
  version: VERSION, released: RELEASED,
  cardsText: async () => { await loadLists(); return `${cards.length.toLocaleString()} words in ${lists.length} lists.`; },
});
initMenu(() => {
  const items = [];
  if (role === 'moderator') items.push(
    ...(G ? [['New game', G.newGame], ['Reshuffle all words', G.reshuffle]] : []),
    ['Leave game', leaveGame, 'danger'],
  );
  else if (role === 'viewer') items.push(['Leave room', () => { location.href = location.pathname; }, 'danger']);
  items.push(['How to play', openHow]);
  return [...items, ['About', showAbout]];
}, { leaving: () => role === 'viewer' || (role === 'moderator' && at !== 'setup') ? 'Leave this game and go to the home page?' : '' });

// ───────────── Start ─────────────
const params = new URLSearchParams(location.search);
if (params.get('join')) startViewer(params.get('join'));
else if (params.get('board')) startViewer(params.get('board'), true);
else if (savedRoom('wg')) startModerator();   // a moderator reloading keeps its room
else show('home');

async function startModerator() {
  if (role) return;
  role = 'moderator'; show('setup'); keepAwake();
  $('optCover').checked = st.get('cover', true);
  $('optSingle').checked = st.get('single', false);
  try {
    await loadLists();
    buildPicker();
    G = createRounds({
      prefix: 'wg', cards, show, noun: 'words',
      fits: i => chosen().has(cards[i].list) && (!single() || isSingle(cards[i].word)),
      // Every ticked list comes up as often as the others, and a word in two lists comes up once.
      balanceBy: c => c.list,
      sameAs: c => c.word.toLowerCase(),
      info: chosenName,
      renderCard: c => {
        $('pWord').textContent = c.word;
        $('pList').textContent = chosen().size > 1 ? `${byId.get(c.list).name} · ${howTo(c.list)}` : '';
      },
      result: r => [r.word, chosen().size > 1 ? byId.get(r.list).name : ''],
      onChange: () => room && room.send(),
      // The first round waits on a START card, so the player can get ready before the clock runs.
      tapToStart: 'pCard',
      startCue: on => {
        const card = $('pCard');
        card.classList.toggle('start-card', on);
        if (on) card.setAttribute('role', 'button'); else card.removeAttribute('role');
        card.tabIndex = on ? 0 : -1;
        if (on) { $('pWord').textContent = 'START'; $('pList').textContent = 'Tap when you\'re ready'; card.focus(); }
      },
    });
    onListChange();
  } catch (e) {
    if (G) throw e;   // a bug after loading, not a load failure: let it show in the console
    $('deckInfo').textContent = loadError();
    $('btnStart').disabled = $('btnFree').disabled = true;
    return;
  }
  if (missing.length) $('listTip').textContent = `Couldn't load ${missing.join(', ')}; the other lists work. ` + $('listTip').textContent;
  $('optSingle').onchange = () => { st.set('single', $('optSingle').checked); onListChange(); };
  room = hostRoom({ game: 'wg', state: viewState });
}
