import { $, ask, esc, shuffle, lines, keepAwake, initMenu, initAbout } from '../shared/common.js';

// Codenames: a board for the shared screen and a key card for the spymasters, kept in step
// through a room (see ROOM below). The board knows the key, so tapping a card turns it to its colour.
// Words come from the lists in lists/ (named in lists.json), picked on the start screen;
// ?addon=WORD,WORD adds more. The revealed-card pictures are in img/,
// listed in images.json. ?demo turns a random card every second, for showing the board off.
const VERSION = '2.30', RELEASED = '2026-11-21';

const params = new URLSearchParams(location.search);
const views = ['choose', 'board', 'key'];
const show = name => { views.forEach(s => $(s).classList.toggle('hidden', s !== name)); $('btnRoom').classList.toggle('hidden', name === 'choose'); placeStatus(); };
// While the board shows, its status line (cards left, who goes first) sits in the header beside
// the title, to leave more room for the cards. On other screens it goes back into the board.
function placeStatus() {
  const el = $('boardStatus'), up = !$('board').classList.contains('hidden');
  if (up && el.parentElement.tagName !== 'HEADER') document.querySelector('header').insertBefore(el, $('btnRoom'));
  if (!up && el.parentElement.tagName === 'HEADER') $('board').prepend(el);
  el.classList.toggle('in-head', up);
}

const BOARD_STORE = 'cn.board', KEY_STORE = 'cn.key', ROOM_STORE = 'cn.room';
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// A game is the board and the key:
//   board = { words, turned, gid }  the 25 words in order, 1 for each card that's been turned over,
//                                   and an id for this deal (see ROOM)
//   key   = { first, cells }   who goes first, and what each of the 25 places is:
//                              'red' | 'blue' | 'bystander' | 'assassin' (9 / 8 / 7 / 1)
// Place i on the key is card i on the board. Both are shared through the room.
let words = [], board = null, key = null;   // words: the pool to deal from, [{ w, tags }]
// Which parts this screen brings to a room. A board screen brings both (it needs the key to know
// each card's colour); a spymaster screen brings the key. A room missing a part gets it from the
// first screen that has it.
const mine = { board: false, key: false };
// Anything from a room is checked before use: anyone can write to a room, and the key's cells end
// up in class names. A key must be 9 + 8 + 7 + 1 of the right kinds, the team going first having 9.
const validWords = w => Array.isArray(w) && w.length === 25 && w.every(x => typeof x === 'string' && x.length <= 40);
const validBoard = b => b && validWords(b.words) && Array.isArray(b.turned) && b.turned.length === 25;
function validKey(k) {
  if (!k || (k.first !== 'red' && k.first !== 'blue') || !Array.isArray(k.cells) || k.cells.length !== 25) return false;
  const n = c => k.cells.filter(x => x === c).length, second = k.first === 'red' ? 'blue' : 'red';
  return n(k.first) === 9 && n(second) === 8 && n('bystander') === 7 && n('assassin') === 1;
}
const newGid = () => Math.random().toString(36).slice(2, 10);
const sameKey = (a, b) => a && b && a.first === b.first && a.cells.join() === b.cells.join();
// A word in a list may have tags ("LONDON #city", "WITCH #person #creature"): a board never gets
// two words that share a tag, so a spymaster can't link two of them with a clue like "cities".
// The start screen's "One word per category" box turns this off, for a board dealt at random.
// Always, whatever the box says: no two cards share a word, so ICE and ICE CREAM, or SPIDER and
// SPIDER-MAN, are never on one board (entries are split into words at spaces and hyphens); and
// no card's word starts or ends another's, so no SNOW with SNOWMAN, STRIP with STRIPPER or BAT
// with BATMAN (words of 3 letters or more; spaces, hyphens and apostrophes are ignored). A word
// in the middle of another is fine: AIR and FAIRY, ANT and PANTS.
const ONE_TAG_STORE = 'cn.oneTag';
const oneTag = () => local.get(ONE_TAG_STORE) !== false;
const partsOf = w => w.split(/[\s-]+/).filter(Boolean);
const squash = w => w.replace(/[\s\-'.]/g, '');
const inside = (a, b) => { const [s, l] = a.length <= b.length ? [a, b] : [b, a]; return s.length >= 3 && (l.startsWith(s) || l.endsWith(s)); };
// spec: which lists to deal from ({ list, mix, oneTag }); this screen's own picks by default,
// the room's for New game (see WORD LISTS).
function dealBoard(spec = localSpec()) {
  const pool = poolFor(spec);
  const out = [], used = new Set(), usedParts = new Set(), squashed = [], check = spec.oneTag;
  for (const { w, tags } of shuffle(pool.length >= 25 ? pool : [...words])) {
    const parts = partsOf(w), sq = squash(w);
    if (parts.some(x => usedParts.has(x))) continue;
    if (squashed.some(o => inside(o, sq))) continue;
    if (check && tags.some(t => used.has(t))) continue;
    parts.forEach(x => usedParts.add(x)); squashed.push(sq);
    tags.forEach(t => used.add(t));
    out.push(w);
    if (out.length === 25) break;
  }
  return { words: out, turned: Array(25).fill(0), gid: newGid(), side: null, spec };
}
function dealKey() {
  const first = Math.random() < .5 ? 'red' : 'blue', second = first === 'red' ? 'blue' : 'red';
  return { first, cells: shuffle([...Array(9).fill(first), ...Array(8).fill(second), ...Array(7).fill('bystander'), 'assassin']) };
}
// A screen picks up where it left off (its game and its room) only if it was used in the last
// 6 hours; after that it starts fresh, so tomorrow's game isn't yesterday's room.
const ACTIVE_STORE = 'cn.active', FRESH_AFTER = 6 * 3600e3;
const stale = Date.now() - (local.get(ACTIVE_STORE) || 0) > FRESH_AFTER;
const touch = () => local.set(ACTIVE_STORE, Date.now());
function ensureGame() {
  if (stale && !key && !board) { key = dealKey(); board = dealBoard(); save(); }
  if (!key) { const k = local.get(KEY_STORE); key = validKey(k) ? { first: k.first, cells: k.cells } : dealKey(); local.set(KEY_STORE, key); }
  if (!board) { const b = local.get(BOARD_STORE); board = validBoard(b) ? { words: b.words, turned: b.turned, gid: b.gid || newGid(), side: b.side || null, spec: b.spec || null } : dealBoard(); local.set(BOARD_STORE, board); }
}
// A game changed while this screen had no room (offline) is pushed to the room when it joins,
// instead of the room's older game replacing it.
let dirtyOffline = false;
const save = () => {
  local.set(BOARD_STORE, board); local.set(KEY_STORE, key); touch();
  if (!(room && room.code && room.code())) dirtyOffline = true;
};

// ───────────────────────── BOARD ─────────────────────────
// A face-down card is tan. Tap it when a team picks it and it turns to its colour from the key
// (grey bystander, red, blue, black assassin); 4 seconds later it shows a picture.
// Turning takes two taps, so a stray one does nothing: the first tap picks the card (it grows and
// gets a border), the second turns it. Moving the mouse off it, or a tap anywhere else, lets it go.
// The same two taps turn a turned card face down again, for a mistake.
const REVEAL_MS = 4000;
const COLOR = { bystander: 1, red: 2, blue: 3, assassin: 4 };
let built = '', demo = null;
const pics = { agent: [], agentbg: [], bystander: [], bystanderbg: [], black: [] };
const next = { agent: 0, agentbg: 0, bystander: 0, bystanderbg: 0 };
const pick = type => { const list = pics[type]; if (!list.length) return null; const url = list[next[type] % list.length]; next[type]++; return url; };
const colorOf = i => board.turned[i] && key ? COLOR[key.cells[i]] : 0;

async function loadImages() {
  let images = {};
  try { images = await (await fetch('images.json', { cache: 'no-cache' })).json(); } catch {}
  for (const type of Object.keys(pics)) pics[type] = shuffle((images[type] || []).map(f => 'img/' + f));
  // Fetch the pictures this board can show (at most 17 agents and 7 bystanders), so they're ready
  // when a card turns and saved for offline play.
  const want = [...pics.agent.slice(0, 17), ...pics.agentbg, ...pics.bystander.slice(0, 7), ...pics.bystanderbg, ...pics.black];
  for (const url of want) new Image().src = url;
}

// Sounds when a card turns over (board screens only): a rising chime for a red or blue agent,
// a soft bonk for a bystander, a falling buzz for the assassin. Board menu: Sound on/off.
const SOUND_STORE = 'cn.sound';
const soundOn = () => local.get(SOUND_STORE) !== false;
let actx = null;
// A browser only lets a page play sound after a tap on it. The board's first tap anywhere (the
// Board button, Full screen, the room code) unlocks it, so a board whose cards are turned from a
// phone still plays the sounds.
function unlockAudio() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {}
}
document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('keydown', unlockAudio, { capture: true });
function tone(freq, start, dur, { type = 'sine', vol = .18, to } = {}) {
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + start;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + .02);
}
function cardSound(color) {
  if (!soundOn() || !color || $('board').classList.contains('hidden')) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    if (color === 2 || color === 3) [784, 988, 1319].forEach((f, i) => tone(f, i * .08, .35, { vol: .16 }));   // agent: G5 B5 E6
    else if (color === 1) tone(330, 0, .22, { type: 'triangle', vol: .22, to: 220 });                         // bystander
    else if (color === 4) { tone(220, 0, 1.1, { type: 'sawtooth', vol: .14, to: 55 }); tone(110, 0, 1.2, { vol: .2, to: 40 }); }  // assassin
  } catch {}
}

// Show a card in a colour: with the flip, or at once (instant) when the board is first drawn.
// card.want is the colour it's heading for, so a change that arrives mid-flip isn't lost.
function paint(card, color, instant = false) {
  card.want = color;
  if (!instant && card.classList.contains('flipping')) { setTimeout(() => { if (card.want === color) paint(card, color); }, 650); return; }
  clearTimeout(card.revealTimer);
  const apply = () => {
    card.className = card.className.replace(/\bcolor-\d\b/, `color-${color}`);
    card.setAttribute('aria-pressed', color ? 'true' : 'false');
    const bg = card.querySelector('.bg'), fg = card.querySelector('.fg');
    bg.style.backgroundImage = fg.style.backgroundImage = '';
    if (color === 0) return;
    const reveal = () => {
      const [b, f] = color === 1 ? [pick('bystanderbg'), pick('bystander')]
        : color === 4 ? [null, pics.black[0]]
        : [pick('agentbg'), pick('agent')];
      if (b) bg.style.backgroundImage = `url('${b}')`;
      if (f) fg.style.backgroundImage = `url('${f}')`;
      card.classList.add('revealed');
    };
    if (instant) reveal(); else card.revealTimer = setTimeout(reveal, REVEAL_MS);
  };
  card.classList.remove('revealed');
  if (instant) return apply();
  card.classList.add('flipping');
  setTimeout(() => { apply(); cardSound(color); }, 300);
  setTimeout(() => card.classList.remove('flipping'), 600);
}

// The card picked by a first tap (-1: none). Only this screen sees it.
// The second tap must come at least PICK_GAP after the first: a nervous double-tap only picks.
const PICK_GAP = 250;
let picked = -1, pickedAt = 0;
function pickCard(i) {
  picked = i; pickedAt = Date.now();
  [...$('wordBoard').children].forEach((cell, j) => cell.firstChild.classList.toggle('picked', j === i));
}
document.addEventListener('click', e => { if (picked >= 0 && !e.target.closest('.cn-card')) pickCard(-1); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && picked >= 0) pickCard(-1); });

// Draw the board's cards when its words change; after that, repaint() turns the cards that changed.
function buildBoard() {
  const el = $('wordBoard');
  el.innerHTML = ''; picked = -1;
  board.words.forEach((word, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'cn-cell';
    const card = document.createElement('button');
    card.className = 'cn-card color-0';
    card.innerHTML = '<div class="bg"></div><div class="fg"></div><div class="tint"></div><span class="word"></span>';
    card.querySelector('.word').textContent = word;
    card.onclick = () => { if (demo) return; if (picked === i) { if (Date.now() - pickedAt >= PICK_GAP) { pickCard(-1); tap(i); } } else pickCard(i); };
    card.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && picked === i) pickCard(-1); });
    wrap.appendChild(card);
    el.appendChild(wrap);
    paint(card, colorOf(i), true);
  });
  built = board.words.join('|');
}
const cardAt = i => $('wordBoard').children[i]?.firstChild;
function repaint() {
  if (!mine.board) return;
  if (built !== board.words.join('|')) return buildBoard();
  board.words.forEach((_, i) => { const c = cardAt(i), want = colorOf(i); if (c && c.want !== want) paint(c, want); });
}
function renderLeft() {
  if (!key || !board) return;
  const left = team => key.cells.filter((c, i) => c === team && !board.turned[i]).length;
  const order = key.first === 'red' ? ['red', 'blue'] : ['blue', 'red'], turn = sideNow(), ended = !!endOf(left);
  $('boardLeft').innerHTML = order.map(t => `<span class="cn-left ${t}${t === turn && !ended ? ' turn' : ''}"${t === turn && !ended ? ' title="Their turn"' : ''}>${t === 'red' ? 'Red' : 'Blue'} <b>${left(t)}</b></span>`).join('')
    + (ended ? '' : '<button class="cn-endturn" id="btnEndTurn" type="button">End turn</button>');
  if (!ended) $('btnEndTurn').onclick = e => { e.stopPropagation(); endTurn(); };
  renderTurnOnKey(ended);
  // Hidden for now: the note beside the counts ("Red goes first", or "The assassin has been found!").
  // To bring it back, uncomment these two lines.
  // const hit = key.cells.findIndex((c, i) => c === 'assassin' && board.turned[i]);
  // $('boardNote').textContent = hit >= 0 ? 'The assassin has been found!' : `${key.first === 'red' ? 'Red' : 'Blue'} goes first`;
  checkFinale(left);
}

// ───────────────────────── FINALE ─────────────────────────
// When a game ends, every board screen in the room (not the spymaster phones) shows a big overlay: "RED WINS!" (that team's last
// card turned; confetti and a fanfare) or "ASSASSIN!" (a red glow and a shake). It shows only at
// the moment the game ends, not when a screen opens or reloads an ended game; turning the last
// card back face down (a mis-tap) just carries on.
let finaleSeen = null;   // { game, end } as last rendered
function endOf(left) {
  if (key.cells.some((c, i) => c === 'assassin' && board.turned[i])) return 'assassin';
  return ['red', 'blue'].find(t => left(t) === 0) || '';
}
function checkFinale(left) {
  const game = board.words.join('|') + key.cells.join(), end = endOf(left);
  const was = finaleSeen;
  finaleSeen = { game, end };
  // The series score: wins/<gid> is who won each game in this room. Set when a game ends, taken
  // off again if a card is turned back and the game carries on.
  // (Sent after this change has finished drawing: a write's echo replaces the board.)
  const gid = board.gid;
  if (was && was.game === game && was.end && !end) setTimeout(() => send({ [`wins/${gid}`]: null }));
  if (end && was && was.game === game && !was.end) { const w = winnerOf(end); setTimeout(() => send({ [`wins/${gid}`]: w })); }
  if (!end) { if (was && was.game !== game) closeFinale(); return; }
  // First look, or nothing new, or the game had already ended (cards turned after a win, to
  // see them, never bring up a second finale, not even for the assassin).
  if (!was || was.game !== game || was.end) return;
  setTimeout(() => showFinale(end), 700);                     // after the card has flipped
}
function winnerOf(end) {
  if (end !== 'assassin') return end;
  const i = key.cells.indexOf('assassin'), t = board.turned[i];
  return other(t && t.by ? t.by : sideNow());   // whoever turned the assassin loses
}
function seriesText() {
  const w = last && last.wins && typeof last.wins === 'object' ? Object.values(last.wins) : [];
  const n = t => w.filter(x => x === t).length;
  return w.length ? `Series: Red ${n('red')} · Blue ${n('blue')}` : '';
}
function showFinale(end) {
  if ($('board').classList.contains('hidden')) return;   // board screens only
  const box = $('finale'), win = end !== 'assassin';
  box.className = `overlay cn-finale ${end}`;
  $('finaleText').textContent = win ? `${end === 'red' ? 'Red' : 'Blue'} wins!` : 'Assassin!';
  const series = () => seriesText();
  $('finaleSub').textContent = win ? 'Every agent found.' : `Game over: ${winnerOf(end) === 'red' ? 'Red' : 'Blue'} wins.`;
  setTimeout(() => { const t = series(); if (t) $('finaleSub').textContent += ` ${t}.`; }, 900);   // once the room has counted this win
  $('confetti').innerHTML = win ? Array.from({ length: 60 }, () => {
    const c = end === 'red' ? ['#d44d4d', '#ff8a80', '#fff'] : ['#4d7bd4', '#90b4ff', '#fff'];
    return `<i style="left:${Math.random() * 100}%;background:${c[Math.floor(Math.random() * 3)]};animation-delay:${(Math.random() * 1.5).toFixed(2)}s;animation-duration:${(2.5 + Math.random() * 2).toFixed(2)}s;transform:rotate(${Math.floor(Math.random() * 360)}deg)"></i>`;
  }).join('') : '';
  if (win && soundOn()) fanfare();
  $('btnFinaleNew').focus();
}
function closeFinale() { $('finale').classList.add('hidden'); $('confetti').innerHTML = ''; }
function fanfare() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * .14, i === 3 ? .9 : .25, { type: 'triangle', vol: .2 }));
  } catch {}
}
$('btnFinaleClose').onclick = closeFinale;
$('btnFinaleNew').onclick = () => { closeFinale(); newGame({ askFirst: false }); };
$('finale').addEventListener('click', e => { if (e.target === $('finale')) closeFinale(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFinale(); });

// Whose turn it is (board.side; the team that goes first until a card changes it). Turning a card
// that isn't the guessing team's own (a bystander, the other team's) ends their turn; End turn
// passes it by hand. Each turned card remembers who turned it ({ at, by }), so turning it back
// face down, or Undo last card, gives the turn back to that team.
const other = t => t === 'red' ? 'blue' : 'red';
const sideNow = () => board && (board.side === 'red' || board.side === 'blue') ? board.side : key ? key.first : 'red';
function setSide(t) { board.side = t; send({ [`side/${board.gid}`]: t }); }
function endTurn() { setSide(other(sideNow())); save(); renderLeft(); }
// A card turned on this screen (or turned back face down): save it and tell the room.
// The card and any change of turn go to the room in one write, before anything else is drawn:
// the room's echo of a write replaces this screen's board, so the card has to be in it.
function tap(i) {
  const was = board.turned[i], part = {};
  if (was) {
    board.turned[i] = 0;
    if (was.by === 'red' || was.by === 'blue') board.side = was.by;
  } else {
    const by = sideNow();
    board.turned[i] = { at: Date.now(), by };
    if (key.cells[i] !== by && key.cells[i] !== 'assassin') board.side = other(by);
  }
  part[`turns/${board.gid}/${i}`] = board.turned[i];
  if (board.side) part[`side/${board.gid}`] = board.side;
  send(part);
  save(); repaint(); renderMarks(); renderLeft();
}
// Undo last card (menu): the most recently turned card goes face down again.
function undoLast() {
  let last = -1, at = -1;
  board.turned.forEach((t, i) => { const when = t && typeof t === 'object' ? t.at : t ? 0 : -1; if (when > at) { at = when; last = i; } });
  if (last >= 0) tap(last);
}

// Demo: every second a random face-down card turns.
function startDemo() {
  demo = setInterval(() => {
    const down = board.turned.map((t, i) => t ? null : i).filter(i => i !== null);
    if (down.length) tap(down[Math.floor(Math.random() * down.length)]);
  }, 1000);
}

let imagesLoading = false;
function openBoard() {
  ensureGame(); freshFromPicker();
  mine.board = mine.key = true;
  if (!imagesLoading) { imagesLoading = true; loadImages(); }   // board screens only: phones never show the pictures
  repaint(); renderLeft();
  if (params.has('demo') && !demo) startDemo();
  history.replaceState(null, '', '#board');
  document.body.classList.add('cn-wide');
  show('board'); keepAwake(); startRoom(); fillRoom();
}

// New game, from either screen: new words, a new key, every card face down, for the whole room.
// It asks first, except from the finale (that game is over anyway).
async function newGame({ askFirst = true } = {}) {
  if (askFirst && !await ask(others() ? `Every screen in room ${roomState.code} gets new words and a new key.` : 'New words and a new key.', { title: 'Start a new game?', ok: 'New game' })) return;
  next.agent = next.agentbg = next.bystander = next.bystanderbg = 0;
  for (const type of Object.keys(pics)) shuffle(pics[type]);
  board = dealBoard(roomSpec() || localSpec()); key = dealKey(); save();
  repaint(); renderKey(); renderLeft();
  sendGame();
}
const sendGame = () => send({ ...boardParts(), first: key.first, cells: key.cells });

// ───────────────────────── SPYMASTER KEY ─────────────────────────
// 9 places for the team that goes first, 8 for the other, 7 bystanders, 1 assassin. The frame's
// colour says who goes first. A white dot marks each place whose card is turned on the board.
// Each place can also show its board word, sized to fit. Which words show is picked under the
// key (cn.keyWords: a list of 'red', 'blue', 'other'; all by default) and remembered per phone.
// 'other' is the neutral (tan) cards and the assassin (black).
const KEY_WORDS_STORE = 'cn.keyWords', KEY_PICKS = ['red', 'blue', 'other'];
function keyWords() {
  const saved = local.get(KEY_WORDS_STORE);
  const picked = saved === false ? [] : Array.isArray(saved) ? saved.map(c => c === 'bystander' ? 'other' : c).filter(c => KEY_PICKS.includes(c)) : KEY_PICKS;
  return picked.flatMap(c => c === 'other' ? ['bystander', 'assassin'] : [c]);
}
// Above the key: who goes first, and once cards are turning, whose turn it is.
function renderTurnOnKey(ended) {
  if (!key) return;
  const first = `${key.first === 'red' ? 'Red' : 'Blue'} goes first`, t = sideNow();
  const started = board && board.turned.some(Boolean);
  $('keyFirst').textContent = !started || ended ? first : `${t === 'red' ? 'Red' : 'Blue'}'s turn`;
  $('keyFirst').className = `cn-first first-${started && !ended ? t : key.first}`;
}
function renderKey() {
  if (!key) return;
  $('keyCard').className = `cn-key first-${key.first} words`;
  $('keyCard').innerHTML = key.cells.map((c, i) => `<div class="cn-spot ${c}" data-i="${i}"><span></span></div>`).join('');
  $('keyCard').classList.toggle('remote', keyRemote()); keyPicked = -1;
  $('optKeyRemote').checked = keyRemote();
  renderTurnOnKey();
  document.querySelectorAll('#keyWordChips input').forEach(box => box.checked = keyWords().includes(box.value === 'other' ? 'bystander' : box.value));
  renderMarks();
}
// A spymaster in a room with no board yet has only its own made-up words, which are on no TV:
// it shows none until a board joins.
const wordsKnown = () => mine.board || !(roomState.code && last) || validWords(last.words);
// The dots for turned cards, and the words (which change when the room deals a new board).
function renderMarks() {
  $('keyNote').classList.toggle('hidden', wordsKnown());
  const turned = board ? board.turned : [], withWords = keyWords();
  let changed = false;
  [...$('keyCard').children].forEach((spot, i) => {
    spot.classList.toggle('turned', !!turned[i]);
    const c = key.cells[i];
    const text = withWords.includes(c) && board && wordsKnown() ? board.words[i] : '';
    const span = spot.firstChild;
    // A two-word entry like SCUBA DIVER goes on two lines, so it can be bigger.
    if (span.dataset.word !== text) { span.dataset.word = text; span.innerHTML = text.split(' ').map(esc).join('<br>'); changed = true; }
  });
  if (changed) fitKeyWords();
}
// Shrink each word until it fits across (and, on two lines, down) its place: long words get
// smaller type than short ones.
function fitKeyWords() {
  const card = $('keyCard');
  if (!card.classList.contains('words') || !card.offsetWidth) return;
  for (const spot of card.children) {
    const span = spot.firstChild, room = spot.clientWidth * 0.9, high = spot.clientHeight * 0.9;
    let size = Math.min(spot.clientHeight * 0.36, 26);
    span.style.fontSize = size + 'px';
    while (size > 6 && (span.scrollWidth > room || span.offsetHeight > high)) { size *= 0.92; span.style.fontSize = size + 'px'; }
  }
}
addEventListener('resize', () => { if (!$('key').classList.contains('hidden')) fitKeyWords(); });
// The key as the board's remote (cn.keyRemote, off by default): with it on, tapping a place on the
// key picks it, and tapping it again turns that card on every board in the room (or turns it back
// face down), the same two taps as on the board. Handy when the TV has no touchscreen.
const KEY_REMOTE_STORE = 'cn.keyRemote';
const keyRemote = () => local.get(KEY_REMOTE_STORE) === true;
let keyPicked = -1, spotAt = 0;
function pickSpot(i) {
  keyPicked = i; spotAt = Date.now();
  [...$('keyCard').children].forEach((spot, j) => spot.classList.toggle('picked', j === i));
}
$('keyCard').addEventListener('click', e => {
  const spot = e.target.closest('.cn-spot');
  if (!spot || !keyRemote()) return;
  e.stopPropagation();
  const i = Number(spot.dataset.i);
  if (keyPicked === i) { if (Date.now() - spotAt >= PICK_GAP) { pickSpot(-1); tap(i); } } else pickSpot(i);
});
document.addEventListener('click', e => { if (keyPicked >= 0 && !e.target.closest('#keyCard')) pickSpot(-1); });
$('optKeyRemote').addEventListener('change', e => {
  local.set(KEY_REMOTE_STORE, e.target.checked);
  $('keyCard').classList.toggle('remote', e.target.checked); pickSpot(-1);
});
$('keyWordChips').addEventListener('change', () => {
  local.set(KEY_WORDS_STORE, [...document.querySelectorAll('#keyWordChips input:checked')].map(box => box.value));
  renderKey(); fitKeyWords();
});

function openKey() {
  ensureGame(); freshFromPicker();
  mine.key = true;
  renderKey();
  history.replaceState(null, '', '#spymaster');
  document.body.classList.remove('cn-wide');
  show('key'); fitKeyWords(); keepAwake(); startRoom(); fillRoom();
}

// ───────────────────────── ROOM ─────────────────────────
// Every screen, board or spymaster, is in a room (shared/rooms.js shareRoom), shown as a code in
// the top right. A screen starts in a random room of its own, so a game can start straight away.
// Tap the code and type another screen's code to join its game: the room's board and key then
// show on this screen too, and whatever the room lacks (a board, a key) this screen fills in.
// The room holds: words, gid, turns (the board) and first, cells (the key). Each deal has its own
// gid, and its turned cards are turns/<gid>/<i>, written one card at a time: two screens turning
// cards at once don't undo each other, and a turn that arrives late (a screen that was offline)
// lands in its own game's turns, never on a newer deal. A new deal replaces the whole turns.
// With no internet each screen works on its own.
let room = null, last = null, pushOnJoin = false, roomState = { text: 'Connecting…', on: false, count: 0, code: '' };
const others = () => roomState.code && roomState.count > 1;
const send = part => { if (room && room.code && room.code()) room.send(part).catch(() => {}); };
const boardParts = () => ({ words: board.words, gid: board.gid, turns: { [board.gid]: board.turned }, side: board.side ? { [board.gid]: board.side } : null, deck: board.spec || localSpec(), turned: null });
// The room's board, if it has one. A room written by an older version has a turned list and no gid.
function roomBoard(s) {
  if (!validWords(s.words)) return null;
  const t = typeof s.gid === 'string' ? s.turns && s.turns[s.gid] : s.turned;
  if (typeof s.gid !== 'string' && !Array.isArray(t)) return null;
  const gid = typeof s.gid === 'string' ? s.gid : null;
  const cell = v => v && typeof v === 'object' ? { at: Number(v.at) || 0, by: v.by === 'red' || v.by === 'blue' ? v.by : null } : v ? 1 : 0;
  const side = gid && s.side && (s.side[gid] === 'red' || s.side[gid] === 'blue') ? s.side[gid] : null;
  return { words: [...s.words], gid, side, spec: validSpec(s.deck) ? s.deck : null, turned: Array.from({ length: 25 }, (_, i) => cell(t && t[i])) };
}
const ownParts = () => ({
  ...(mine.board ? boardParts() : {}),
  ...(mine.key ? { first: key.first, cells: key.cells } : {}),
});
// Give the room the parts it doesn't have yet.
function fillRoom() {
  if (!last || !room || !room.code) return;
  const part = {};
  if (mine.board && !roomBoard(last)) Object.assign(part, boardParts());
  if (mine.key && !validKey(last)) Object.assign(part, { first: key.first, cells: key.cells });
  if (Object.keys(part).length) send(part);
}

function onRoomState(s) {
  last = s;
  if (!s) return;
  // A game dealt from the start screen before the room connected: it replaces the room's game.
  if (pushOnJoin) { pushOnJoin = false; sendGame(); return; }
  if (!validSpec(s.deck) && board && board.spec && mine.board && validWords(s.words)) send({ deck: board.spec });
  const newKey = validKey(s) && !sameKey(key, s);
  if (newKey) key = { first: s.first, cells: [...s.cells] };
  const rb = roomBoard(s);
  if (rb) {
    board = rb;
    // An older version's room: give the deal a gid so turns can go card by card from here on.
    if (!rb.gid) { board.gid = newGid(); if (mine.board) send(boardParts()); }
  }
  // A room with a key but no board: a board screen joining it starts face down (its turned cards
  // belonged to a different key), and a spymaster screen shows no dots.
  else if (board && (newKey || !mine.board)) board.turned = Array(25).fill(0);
  save();
  if (newKey) renderKey();
  repaint(); renderMarks(); renderLeft();
  fillRoom();
}

// A QR code for joining this screen's room, in the room dialog: a phone that scans it opens the
// spymaster key in this room (?room=CODE#spymaster).
let qrFor = null;
function renderQr(code) {
  if (code === qrFor) return;
  qrFor = code;
  const url = code ? `${location.origin}${location.pathname}?room=${code}#spymaster` : '';
  $('roomQr').innerHTML = ''; $('roomQr').classList.toggle('hidden', !code || !window.QRCode);
  if (code && window.QRCode) new QRCode($('roomQr'), { text: url, width: 180, height: 180 });
  $('roomLink').textContent = code ? url.replace(/^https?:\/\//, '') : '';
}

// The room button in the top right: the code, a dot for the connection and how many screens share it.
function renderRoom() {
  const r = roomState, b = $('btnRoom');
  const label = r.code ? `Room ${r.code}` : r.text;
  const extra = r.code && r.on && r.count > 1 ? ` · ${r.count} screens` : r.code && !r.on ? ` · ${r.text || 'Offline'}` : '';
  b.innerHTML = `<span class="dot ${r.on && r.code ? 'on' : ''}"></span>${esc(label)}<small>${esc(extra)}</small>`;
  $('roomMine').textContent = $('landRoom').textContent = r.code || '—';
  renderQr(r.code);
  $('landRoomInfo').textContent = r.code && r.on
    ? (r.count > 1 ? `${r.count} screens in this room.` : 'Only this screen is in this room so far.')
    : r.text || "You're offline.";
  $('roomCount').textContent = (r.code && r.on
    ? (r.count > 1 ? `${r.count} screens are in this room.` : 'Only this screen is in the room so far.')
    : r.text || "You're offline.") + (roomSpec() ? ` Words: ${specName(roomSpec())}.` : '') + (seriesText() ? ` ${seriesText()}.` : '');
}

let linked = /^[A-Z2-9]{4}$/.test((params.get('room') || '').toUpperCase()) ? params.get('room').toUpperCase() : '', linkMsg = '';
async function startRoom() {
  if (room) return;
  room = 'starting';
  if (!navigator.onLine) {
    room = null;
    roomState = { text: 'Offline', on: false, count: 0, code: '' }; renderRoom();
    addEventListener('online', startRoom, { once: true });
    return;
  }
  roomState = { text: 'Connecting…', on: false, count: 0, code: '' }; renderRoom();
  try {
    const { shareRoom } = await import('../shared/rooms.js');
    const r = shareRoom({
      game: 'cn',
      onState: onRoomState,
      onStatus: st => { roomState = st; if (st.code) { local.set(ROOM_STORE, st.code); touch(); } renderRoom(); },
    });
    room = r;
    // A room link (?room=CODE, from another screen's QR code) joins that room. Otherwise back to
    // the room this screen was in, if it's still there; otherwise a new one.
    if (linked) {
      const res = await r.join(linked);
      history.replaceState(null, '', location.pathname + location.hash);
      if (res === 'ok') { linked = ''; return; }
      linkMsg = `Room ${linked} has no Codenames game any more, so this screen is in a room of its own.`;
      linked = '';
    }
    const saved = stale ? null : local.get(ROOM_STORE);
    if (dirtyOffline && saved) pushOnJoin = true;
    if (!saved || await r.join(saved) !== 'ok') { pushOnJoin = false; await r.create(ownParts()); }
    dirtyOffline = false;
    if (linkMsg) { openRoomDlg(); $('roomMsg').textContent = linkMsg; linkMsg = ''; }
  } catch (e) {
    // The database couldn't be reached (or a hiccup): try again shortly, or when back online.
    room = null;
    roomState = { text: 'No room · retrying', on: false, count: 0, code: '' }; renderRoom();
    clearTimeout(retryTimer); retryTimer = setTimeout(startRoom, 8000);
    addEventListener('online', startRoom, { once: true });
  }
}
let retryTimer = null;

// The room dialog: this screen's code, and a box to type another screen's code.
const dlg = $('roomDlg');
function openRoomDlg() {
  $('roomInput').value = ''; $('roomMsg').textContent = '';
  dlg.classList.remove('hidden'); renderRoom(); $('roomInput').focus();
}
const closeRoomDlg = () => dlg.classList.add('hidden');
async function joinRoom() {
  const code = $('roomInput').value.trim().toUpperCase();
  if (!room || room === 'starting') { $('roomMsg').textContent = "You're offline. Joining a room needs internet."; return; }
  if (code === roomState.code) { closeRoomDlg(); return; }
  $('roomMsg').textContent = 'Joining…'; $('btnRoomJoin').disabled = true;
  try {
    const res = await room.join(code);
    const msg = {
      bad: 'Room codes are 4 letters and numbers.',
      empty: `There's no Codenames game in room ${code}. Check the code on the other screen.`,
      other: `Room ${code} is another game's room. Check the code on the other screen.`,
    }[res];
    if (msg) $('roomMsg').textContent = msg; else closeRoomDlg();
  } catch (e) {
    $('roomMsg').textContent = 'Could not reach the game database: ' + (e.message || e);
  } finally { $('btnRoomJoin').disabled = false; }
}
$('btnRoom').onclick = openRoomDlg;
$('btnRoomJoin').onclick = joinRoom;
// New room (landing page, or the room dialog): leave this room for a fresh random code, taking
// this screen's game along. say(text) shows progress next to the button that was tapped.
async function newRoom(btn, say) {
  if (!room || room === 'starting') { say("You're offline. A new room needs internet."); return; }
  say('Opening a new room…'); btn.disabled = true;
  try {
    ensureGame();
    const code = await room.create({ ...boardParts(), first: key.first, cells: key.cells });
    say(`New room ${code}. Other screens can join it with that code.`);
  } catch (e) { say('Could not open a new room: ' + (e.message || e)); }
  finally { btn.disabled = false; }
}
$('btnRoomNew').onclick = () => { $('roomInput').value = ''; newRoom($('btnRoomNew'), t => $('roomMsg').textContent = t); };
$('btnLandNew').onclick = () => newRoom($('btnLandNew'), t => $('landRoomMsg').textContent = t);
$('btnRoomCancel').onclick = closeRoomDlg;
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
dlg.addEventListener('click', e => { if (e.target === dlg) closeRoomDlg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRoomDlg(); });

function openChoose() {
  history.replaceState(null, '', location.pathname + location.search);
  document.body.classList.remove('cn-wide');
  show('choose'); startRoom();
}

// ───────────────────────── PAGE ─────────────────────────
const howto = $('howto');
const openHow = () => { howto.classList.remove('hidden'); $('btnHowClose').focus(); };
const closeHow = () => howto.classList.add('hidden');
$('btnHowClose').onclick = closeHow;
howto.addEventListener('click', e => { if (e.target === howto) closeHow(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeHow(); });
const showAbout = initAbout({ version: VERSION, released: RELEASED, cardsText: async () => lists.map(l => `${l.name}: ${l.words.length} words`).join(' · ') });
const fullScreen = () => { try { document.documentElement.requestFullscreen(); } catch {} };
initMenu(() => {
  const view = views.find(v => !$(v).classList.contains('hidden'));
  return [
    ...(view !== 'choose' ? [['New game', newGame]] : []),
    ...(view !== 'choose' && board && board.turned.some(Boolean) ? [['Undo last card', undoLast]] : []),
    ...(view === 'board' ? [...(document.fullscreenEnabled ? [['Full screen', fullScreen]] : []),
      [`Sound: ${soundOn() ? 'on' : 'off'}`, () => local.set(SOUND_STORE, !soundOn())], ['Spymaster key', openKey]] : []),
    ...(view === 'key' ? [['Board', openBoard]] : []),
    ...(view !== 'choose' ? [['Room', openRoomDlg]] : []),
    ...(view !== 'choose' ? [['Change screen', openChoose]] : []),
    ['How to play', openHow],
    ['About', showAbout],
  ];
});

// ───────────────────────── WORD LISTS ─────────────────────────
// On the start screen: pick one main list (lists.json entries without "mix"), and tick any
// mix-ins ("mix": true) to add their words to it. Changing either means the next screen opened
// starts a new game with the new words (for its whole room).
const LIST_STORE = 'cn.list', MIX_STORE = 'cn.mix';
let lists = [], listsChanged = false;
const parse = line => { const [w, ...tags] = line.split('#'); return { w: w.trim().toUpperCase(), tags: tags.map(t => t.trim()).filter(Boolean) }; };
const mains = () => lists.filter(l => !l.mix), mixes = () => lists.filter(l => l.mix);
function chosenId() {
  const saved = local.get(LIST_STORE);
  return mains().some(l => l.id === saved) ? saved : mains()[0] && mains()[0].id;
}
function chosenMix() {
  const saved = local.get(MIX_STORE);
  return Array.isArray(saved) ? saved.filter(id => mixes().some(l => l.id === id)) : [];
}
// A deal's lists, as stored in the room (deck) so New game on any screen deals from the same ones.
const localSpec = () => ({ list: chosenId() || 'original', mix: chosenMix(), oneTag: oneTag() });
const validSpec = d => d && typeof d.list === 'string' && (!d.mix || Array.isArray(d.mix));
const roomSpec = () => last && validSpec(last.deck) ? last.deck : board && board.spec;
function poolFor(spec) {
  const seen = new Map();
  for (const id of [spec.list, ...(spec.mix || [])]) for (const e of (lists.find(l => l.id === id) || { words: [] }).words) if (!seen.has(e.w)) seen.set(e.w, e);
  for (const e of words) if (!seen.has(e.w) && !lists.some(l => l.words.some(x => x.w === e.w))) seen.set(e.w, e);   // ?addon words
  return [...seen.values()];
}
const specName = spec => !spec ? '' : [spec.list, ...(spec.mix || [])].map(id => (lists.find(l => l.id === id) || { name: id }).name).join(' + ');
function buildPool() {
  const seen = new Map(), use = [chosenId(), ...chosenMix()];
  for (const id of use) for (const e of (lists.find(l => l.id === id) || { words: [] }).words) if (!seen.has(e.w)) seen.set(e.w, e);
  const addon = params.get('addon');
  if (addon) for (const w of addon.split(',').map(x => x.trim().toUpperCase()).filter(Boolean)) if (!seen.has(w)) seen.set(w, { w, tags: [] });
  words = [...seen.values()];
  $('listInfo').textContent = words.length >= 25
    ? `${words.length} words to deal from.`
    : 'Could not load this list.';
  $('mixNote').textContent = mixes().filter(l => chosenMix().includes(l.id) && l.note).map(l => `${l.name}: ${l.note}`).join(' ');
  $('btnBoard').disabled = $('btnKey').disabled = words.length < 25;
}
function chip(l, type, checked, onchange) {
  const el = document.createElement('label'); el.className = 'chip'; el.title = l.note || '';
  el.innerHTML = `<input type="${type}" name="cn-${type}" value="${esc(l.id)}"${checked ? ' checked' : ''}> ${esc(l.name)} <small>${l.words.length}</small>`;
  el.querySelector('input').onchange = onchange;
  return el;
}
function renderLists() {
  $('optOneTag').checked = oneTag();
  $('optOneTag').onchange = () => { local.set(ONE_TAG_STORE, $('optOneTag').checked); listsChanged = true; };
  const id = chosenId(), mix = chosenMix();
  $('listChips').replaceChildren(...mains().map(l => chip(l, 'radio', l.id === id, () => { local.set(LIST_STORE, l.id); listsChanged = true; buildPool(); })));
  $('mixChips').replaceChildren(...mixes().map(l => chip(l, 'checkbox', mix.includes(l.id), () => {
    local.set(MIX_STORE, [...$('mixChips').querySelectorAll('input:checked')].map(i => i.value)); listsChanged = true; buildPool();
  })));
  $('mixRow').classList.toggle('hidden', !mixes().length);
}
// After the lists change, the next board or key opened starts a new game from them (asking
// first when other screens share the room, since it changes their game too).
async function freshFromPicker() {
  if (!listsChanged) return;
  listsChanged = false;
  if (others() && !await ask(`Every screen in room ${roomState.code} gets a new game from ${specName(localSpec())}.`, { title: 'New game with these word lists?', ok: 'New game', cancel: 'Keep this game' })) return;
  board = dealBoard(); key = dealKey(); save();
  repaint(); renderKey(); renderLeft();
  if (room && room.code && room.code()) sendGame(); else pushOnJoin = true;
}

$('btnBoard').onclick = openBoard;
$('btnKey').onclick = openKey;

try {
  lists = await (await fetch('lists.json', { cache: 'no-cache' })).json();
  // A list that fails to load is left out; the others still work.
  const got = await Promise.allSettled(lists.map(async l => { l.words = (await lines(`lists/${l.id}.txt`)).map(parse); }));
  lists = lists.filter((l, i) => got[i].status === 'fulfilled');
} catch {
  lists = [];
  $('status').textContent = 'Could not load the word lists — open this page from a web server.';
}
renderLists(); buildPool();

if (location.hash === '#board' && words.length >= 25) openBoard();
else if (location.hash === '#spymaster' && words.length >= 25) openKey();
else openChoose();
