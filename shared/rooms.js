import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getDatabase, ref, set, get, update, onValue, onDisconnect, runTransaction } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { $, esc, fmt, keepAwake } from './common.js';

// Rooms: one moderator device runs a game, any number of viewer devices show a read-only copy.
// (Or, with shareRoom below, a room of equal devices that all show and change the same state.)
// They sync through Firebase Realtime Database: rooms/<CODE>/{owner,state,viewers}
// (rules in database.rules.json). `game` ('mg', 'wg') keeps each game's rooms apart.
//
// The state a moderator sends (built by roundState, or by the game for its own phases):
//   game, phase   'setup' | 'playing' | 'paused' | 'over' | 'closed' | 'free'
//   teams, current           scores and whose turn it is (optional: no teams, no scorebar)
//   card, note               the card text the viewer shows, and a label above it
//   endsAt / left            the clock: server time the round ends, or ms left while stopped
//   results                  [{ main, sub, got }] once the round is over
//   banner                   optional: overrides the viewer's message for this phase
//   away                     set by the database when the moderator's device drops off

const db = getDatabase(initializeApp({
  apiKey: 'AIzaSyDbzdtJUIyNIsZ1CnxArgwa8G7mfqb1sKQ',
  authDomain: 'madgab-b4a1e.firebaseapp.com',
  databaseURL: 'https://madgab-b4a1e-default-rtdb.firebaseio.com',
  projectId: 'madgab-b4a1e',
  appId: '1:168797707932:web:4cff56d10c1d38319bd759',
}));

// Server clock offset, so a viewer's countdown matches the moderator's even if device clocks differ.
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
const now = () => Date.now() + offset;
// For a game's own clocks: a local time as server time (moderator), and the server's now (viewer).
export const toServer = t => t + offset;
export const serverNow = () => now();

const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  remove(k) { try { sessionStorage.removeItem(k); } catch {} },
};
// A per-tab id: the moderator's claim on its room code, or a viewer's presence entry.
function tabId(game) {
  let id = session.get(game + '.me');
  if (!id) { id = Math.random().toString(36).slice(2, 12); session.set(game + '.me', id); }
  return id;
}
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const setStatus = (text, on) => { $('status').innerHTML = `<span class="dot ${on ? 'on' : ''}"></span>${esc(text)}`; };

// The room this tab is hosting, if it has one (a moderator reloading keeps its room).
export const savedRoom = game => session.get(game + '.code');
// The room this device hosted last, kept for 6 hours even if the tab is closed (or a phone throws
// it away): a moderator who comes back opens the same code again, so the viewers and the TV pick
// up where they were instead of waiting on a code nobody uses any more.
const HOSTED_FOR = 6 * 3600e3;
const hosted = {
  get(game) { try { const h = JSON.parse(localStorage.getItem(game + '.hosted')); return h && Date.now() - h.at < HOSTED_FOR ? h : null; } catch { return null; } },
  set(game, h) { try { localStorage.setItem(game + '.hosted', JSON.stringify(h)); } catch {} },
  remove(game) { try { localStorage.removeItem(game + '.hosted'); } catch {} },
};

// The viewer state for a createRounds engine. card(c) is what viewers see of a card
// (never the answer); result(r) gives [main, sub] for the results list.
export function roundState(G, { card, note, result }) {
  const s = { phase: G.phase, teams: G.teams, current: G.current };
  if (G.phase === 'playing') { s.card = card(G.card); s.note = note ? note(G.card) : ''; s.endsAt = G.endsAt + offset; }
  if (G.phase === 'paused') s.left = G.pausedLeft;
  if (G.phase === 'setup') s.left = G.roundMs;
  if (G.phase === 'over') s.results = G.results.map(r => { const [main, sub] = result(r); return { main, sub: sub || '', got: r.got }; });
  if (G.phase === 'over') s.banner = G.overText;   // this round's points, or who won the game
  return s;
}

// ───────────────────────── MODERATOR ─────────────────────────
// Opens a room and fills the page's #roomCode, #qr, #viewerCount and #status.
// state() returns what viewers should see; call send() whenever it changes.
export function hostRoom({ game, state }) {
  const last = !savedRoom(game) && hosted.get(game);
  if (last) session.set(game + '.me', last.id);   // claim it again as the same moderator
  const ME = tabId(game);
  let code = null;

  // With no internet there is no room, but the game still works on this device.
  const ALONE = 'This device works on its own; viewers need internet.';
  function start() {
    if (navigator.onLine) return open(savedRoom(game) || (last && last.code) || newCode());
    setStatus('Offline', false);
    $('viewerCount').textContent = `You're offline. ${ALONE}`;
    addEventListener('online', start, { once: true });
  }
  async function open(c) {
    setStatus('Opening room…', false);
    const slow = setTimeout(() => { $('viewerCount').textContent = `Can't reach the game database yet. ${ALONE}`; }, 8000);
    let res;
    try {
      // Claim the code unless another moderator is using it (claims go stale after 12 hours).
      res = await runTransaction(ref(db, `rooms/${c}/owner`), cur => {
        if (!cur || cur.id === ME || now() - cur.at > 12 * 3600e3) return { id: ME, at: now() };
        return undefined;
      });
    } catch (e) {
      setStatus('Sync error', false);
      $('viewerCount').textContent = 'Could not reach the game database: ' + (e.message || e);
      return;
    } finally { clearTimeout(slow); }
    if (!res.committed) return open(newCode());
    code = c; session.set(game + '.code', c); hosted.set(game, { code: c, id: ME, at: Date.now() });
    $('roomCode').textContent = c;
    const url = location.origin + location.pathname + '?join=' + c;
    $('qr').innerHTML = '';
    if (window.QRCode) new QRCode($('qr'), { text: url, width: 160, height: 160 });
    onValue(ref(db, `rooms/${c}/viewers`), snap => {
      const n = snap.size;
      $('viewerCount').textContent = n ? `${n} viewer${n > 1 ? 's' : ''} connected ✓` : 'Waiting for a viewer…';
    });
    // If this device drops off (tab closed, phone asleep, no signal), the database marks the state
    // `away` so the viewers can say so; the next send (on reconnect) clears it.
    onValue(ref(db, '.info/connected'), x => {
      if (x.val()) { onDisconnect(ref(db, `rooms/${c}/state/away`)).set(true).catch(() => {}); send(); }
      setStatus(x.val() ? 'Room ' + c : 'Reconnecting…', !!x.val());
    });
    send();
  }
  function send() {
    if (!code) return;
    hosted.set(game, { code, id: ME, at: Date.now() });
    set(ref(db, `rooms/${code}/state`), { ...state(), game })
      .catch(e => setStatus('Sync error: ' + (e.code || e.message), false));
  }
  // Tell the viewers the game is over and give up the code.
  async function close() {
    if (code) { try { await set(ref(db, `rooms/${code}/state`), { phase: 'closed', game }); } catch {} }
    session.remove(game + '.code'); hosted.remove(game);
  }

  start();
  return { send, close };
}

// ───────────────────────── VIEWER ─────────────────────────
// A read-only screen. The page needs the #join section (joinCode, btnJoin, joinMsg) and the
// #viewer section (vScores, vClock, vNote, vCard, vBanner, vResultsBox, vResults).
// show(name) switches between them. Call open(code), or open('') to ask for a code.
// open(code, true) makes it a scoreboard: the clock and scores, never the card,
// and the results once a round is over. The scoreboard only hides the card: every screen
// in a room gets the same state.
// Options: render(state, board) draws a game's own viewer screen instead of the standard one;
// params names the URL parameters for a viewer and a scoreboard (default join / board).
export function viewRoom({ game, show, render: custom, params = { view: 'join', board: 'board' } }) {
  const ME = tabId(game);
  let code = '', state = null, unsubs = [], clock = null, board = false;

  function join(raw) {
    code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { $('joinMsg').textContent = 'The code is 4 letters.'; return; }
    show('join'); $('joinCode').value = code;
    if (!navigator.onLine) {
      $('joinMsg').textContent = "You're offline. Joining a room needs internet; this page will join when you're back online.";
      setStatus('Offline', false);
      addEventListener('online', () => join(code), { once: true });
      return;
    }
    $('joinMsg').textContent = 'Connecting…'; setStatus('Connecting…', false);
    unsubs.forEach(u => u()); unsubs = [];
    const me = ref(db, `rooms/${code}/viewers/${ME}`);
    unsubs.push(onValue(ref(db, '.info/connected'), c => {
      if (c.val()) { onDisconnect(me).remove(); set(me, true).catch(() => {}); }
      setStatus(c.val() ? 'Room ' + code : 'Reconnecting…', !!c.val());
    }));
    unsubs.push(onValue(ref(db, `rooms/${code}/state`), snap => {
      const s = snap.val();
      // Rooms from before `game` existed are Mad Gab's.
      if (s && (s.game || 'mg') !== game) {
        show('join'); $('joinMsg').textContent = `Room ${code} is running a different game. Check the code.`;
        return;
      }
      if (!s) {
        show('join');
        $('joinMsg').textContent = `No game in room ${code} yet. Check the code on the moderator's screen — this page will join as soon as it's open.`;
        return;
      }
      history.replaceState(null, '', `?${board ? params.board : params.view}=` + code);
      state = s; show('viewer'); custom ? custom(s, board) : render();
      // The moderator's device has dropped off: say so, instead of a clock stuck at 0:00.
      $('vAway').classList.toggle('hidden', !s.away || s.phase === 'closed');
    }, err => { $('joinMsg').textContent = 'Could not reach the game database: ' + err.message; }));
    clearInterval(clock); clock = setInterval(tick, 250);
  }

  function render() {
    const s = state, teams = s.teams || [], results = s.results || [];
    const team = teams[s.current] ? teams[s.current].name : '';
    $('vScores').innerHTML = teams.map((t, i) =>
      `<div class="team ${i === s.current ? 'current' : ''}">${esc(t.name)}<b>${t.score}</b></div>`).join('');
    $('vScores').classList.toggle('hidden', !teams.length || s.phase === 'free');
    $('vClock').classList.toggle('hidden', !['setup', 'playing', 'paused'].includes(s.phase));
    $('vResultsBox').classList.toggle('hidden', s.phase !== 'over');
    const showCard = !board && (s.phase === 'playing' || s.phase === 'free');
    $('vCard').textContent = showCard ? s.card || '' : '';
    $('vNote').textContent = showCard ? s.note || '' : '';
    const got = results.filter(r => r.got).length;
    const banners = {
      playing: '', paused: 'Paused',
      free: board ? 'Playing words with no clock. Scores show in timed rounds.' : '',
      closed: 'The moderator ended this game.',
      over: `Time! ${team} got ${got}`,
    };
    $('vBanner').textContent = s.banner || (s.phase in banners ? banners[s.phase] : `${team}, get ready…`);
    if (s.phase === 'over') {
      $('vResults').innerHTML = results.length ? results.map(r =>
        `<li class="${r.got ? 'got' : 'skip'}"><span class="mark">${r.got ? '✓' : '✗'}</span>
         <span><div>${esc(r.main)}</div>${r.sub ? `<div class="p">${esc(r.sub)}</div>` : ''}</span></li>`).join('')
        : '<li class="muted">No cards this round.</li>';
    }
    tick();
  }
  function tick() {
    if (!state || custom) return;
    const left = state.phase === 'playing' ? state.endsAt - now() : (state.left || 0);
    $('vClock').textContent = fmt(left);
    $('vClock').classList.toggle('low', state.phase === 'playing' && left <= 10000);
  }

  $('btnJoin').onclick = () => join($('joinCode').value);
  $('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') join($('joinCode').value); });

  return {
    open(c, asBoard = false) {
      board = asBoard; $('viewer').classList.toggle('board', board); keepAwake();
      if (c) join(c); else { show('join'); $('joinCode').focus(); }
    },
  };
}

// ───────────────────────── SHARED ROOM ─────────────────────────
// A room where every device is equal: any of them can change the state and all of them see it
// (Codenames' spymaster key). The page draws its own room button; this only does the syncing.
//   onState(s)   the room's state whenever it changes (null while the room is empty)
//   onStatus({ text, on, count })   connection text, whether it's live, devices in the room
// create(state) opens a new room with a random code; join(code) moves to an existing room
// and resolves to 'ok', 'empty' (no game there), 'other' (another game's room) or 'bad' (not
// 4 letters); send(part) changes the given fields of the state for everyone in the room (the
// other fields are kept, so devices can each look after their own part).
// Options: id, this device's presence id (a-z0-9, up to 16; default one per tab), for a game
// that tracks players across reloads; onViewers(ids) gets the ids of the devices in the room.
export function shareRoom({ game, onState, onStatus, id, onViewers }) {
  const ME = id || tabId(game);
  let code = null, unsubs = [], live = false, count = 0;
  const report = text => onStatus({ text, on: live, count, code });

  function watch(c) {
    unsubs.forEach(u => u()); unsubs = [];
    code = c; live = false; count = 0;
    const me = ref(db, `rooms/${c}/viewers/${ME}`);
    unsubs.push(onValue(ref(db, '.info/connected'), x => {
      live = !!x.val();
      if (live) { onDisconnect(me).remove(); set(me, true).catch(() => {}); }
      report(live ? '' : 'Reconnecting…');
    }));
    unsubs.push(onValue(ref(db, `rooms/${c}/viewers`), snap => {
      count = snap.size; report(live ? '' : 'Reconnecting…');
      if (onViewers) onViewers(Object.keys(snap.val() || {}));
    }));
    unsubs.push(onValue(ref(db, `rooms/${c}/state`), snap => {
      const st = snap.val();
      onState(st && st.game === game ? st : null);
    }));
  }
  // Leave the room this device is in (its presence entry goes with it).
  function leave() {
    if (!code) return;
    set(ref(db, `rooms/${code}/viewers/${ME}`), null).catch(() => {});
    unsubs.forEach(u => u()); unsubs = []; code = null;
  }

  async function create(state) {
    for (let tries = 0; tries < 20; tries++) {
      const c = newCode();
      // Claim a code nobody has used in the last 12 hours.
      const res = await runTransaction(ref(db, `rooms/${c}/owner`), cur => {
        if (!cur || cur.id === ME || now() - cur.at > 12 * 3600e3) return { id: ME, at: now() };
        return undefined;
      });
      if (!res.committed) continue;
      leave();
      await set(ref(db, `rooms/${c}/state`), { phase: 'shared', ...state, game });
      watch(c);
      return c;
    }
    throw new Error('no free room code');
  }
  async function join(raw) {
    const c = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z2-9]{4}$/.test(c)) return 'bad';
    const st = (await get(ref(db, `rooms/${c}/state`))).val();
    if (!st) return 'empty';
    if (st.game !== game) return 'other';
    if (c !== code) { leave(); watch(c); }
    return 'ok';
  }
  // Keep the room's claim fresh while it's in use (at most every 10 minutes), so a game going for
  // more than 12 hours can't have its code claimed by a new room.
  let freshAt = 0;
  function send(state) {
    if (!code) return Promise.resolve();
    if (Date.now() - freshAt > 600e3) { freshAt = Date.now(); update(ref(db, `rooms/${code}/owner`), { at: now() }).catch(() => {}); }
    return update(ref(db, `rooms/${code}/state`), { phase: 'shared', ...state, game });
  }

  return { create, join, send, code: () => code };
}
