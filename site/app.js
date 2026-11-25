import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

/* ------------------------------------------------------------------ */
/*  Utilitaires                                                        */
/* ------------------------------------------------------------------ */
const $root = document.getElementById("app");
const $top = document.getElementById("topbar-right");
const $toasts = document.getElementById("toasts");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const normWord = (w) => String(w ?? "").trim().toLowerCase();
const WORD_RE = /^[a-zàâäçéèêëîïôöùûüÿœæ]+$/;

/** Nombre de lettres différentes (-1 si longueurs différentes). */
function diffCount(a, b) {
  const A = Array.from(a), B = Array.from(b);
  if (A.length !== B.length) return -1;
  return A.reduce((n, ch, i) => n + (ch !== B[i] ? 1 : 0), 0);
}

function tiles(word, { target = null, prev = null, size = "" } = {}) {
  const W = Array.from(word), T = target ? Array.from(target) : null, P = prev ? Array.from(prev) : null;
  return `<span class="tiles ${size}">${W.map((ch, i) => {
    let cls = "tile";
    if (P && P[i] !== ch) cls += " changed";
    else if (T && T[i] === ch) cls += " ok";
    return `<span class="${cls}">${esc(ch)}</span>`;
  }).join("")}</span>`;
}

function toast(msg, kind = "info", ms = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $toasts.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.36);
  } catch { /* son non disponible */ }
}

/* ------------------------------------------------------------------ */
/*  Supabase                                                           */
/* ------------------------------------------------------------------ */
if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  $root.innerHTML = `<div class="card"><h2>Configuration requise</h2>
    <p>Renseigne <code>SUPABASE_URL</code> et <code>SUPABASE_ANON_KEY</code> dans <code>site/config.js</code>,
    puis exécute <code>supabase/schema.sql</code> dans ton projet Supabase (voir le README).</p></div>`;
  throw new Error("Supabase non configuré");
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const GAME_SEL =
  "*, creator:profiles!games_creator_id_fkey(username), opponent:profiles!games_opponent_id_fkey(username)";

let session = null;
let me = null;               // { id, username }
let channel = null;
let currentUserId; // undefined tant que la session n’est pas résolue
let currentGameId = null;    // partie affichée
let myTurnCount = 0;
const nameCache = new Map();

async function getName(id) {
  if (!id) return "?";
  if (nameCache.has(id)) return nameCache.get(id);
  const { data } = await sb.from("profiles").select("username").eq("id", id).maybeSingle();
  const n = data?.username ?? "?";
  nameCache.set(id, n);
  return n;
}

/* ------------------------------------------------------------------ */
/*  Notifications                                                      */
/* ------------------------------------------------------------------ */
let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => { swReg = r; }).catch(() => {});
}

function notifSupported() { return "Notification" in window; }

async function systemNotify(title, body, hash, tag) {
  if (!notifSupported() || Notification.permission !== "granted") return;
  const url = new URL(location.href); url.hash = hash;
  const opts = { body, icon: "icon.svg", tag, renotify: true, data: { url: url.href } };
  try {
    const reg = swReg || (await navigator.serviceWorker?.getRegistration());
    if (reg) { await reg.showNotification(title, opts); return; }
  } catch { /* repli ci-dessous */ }
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { window.focus(); location.hash = hash; n.close(); };
  } catch { /* ignoré */ }
}

/** Alerte complète : toast + son + notification système si l'onglet n'est pas au premier plan. */
function alertUser(title, body, gameId, kind = "turn") {
  toast(`${title} — ${body}`, kind, 7000);
  const viewing = currentGameId === gameId && document.visibilityState === "visible";
  if (!viewing) beep();
  if (document.visibilityState !== "visible" || !viewing) systemNotify(title, body, `#/g/${gameId}`, `game-${gameId}`);
}

function renderTopbar() {
  if (!me) { $top.innerHTML = ""; return; }
  let notifBtn = "";
  if (notifSupported() && Notification.permission === "default")
    notifBtn = `<button class="small" id="btn-notif">🔔 Activer les notifications</button>`;
  else if (notifSupported() && Notification.permission === "denied")
    notifBtn = `<span class="muted" title="Autorise les notifications dans les réglages du navigateur">🔕 bloquées</span>`;
  $top.innerHTML = `${notifBtn}<span class="muted">👤 ${esc(me.username)}</span><button class="small" id="btn-logout">Déconnexion</button>`;
  document.getElementById("btn-logout").onclick = () => sb.auth.signOut();
  const nb = document.getElementById("btn-notif");
  if (nb) nb.onclick = async () => {
    const res = await Notification.requestPermission();
    if (res === "granted") { toast("Notifications activées 🔔", "ok"); systemNotify("Mot à Mot", "Les notifications fonctionnent !", location.hash || "#/", "test"); }
    renderTopbar();
  };
}

async function refreshTurnBadge() {
  if (!me) return;
  const { count } = await sb.from("games").select("id", { count: "exact", head: true })
    .eq("status", "active").eq("current_turn", me.id);
  myTurnCount = count ?? 0;
  document.title = myTurnCount > 0 ? `(${myTurnCount}) 🔔 À toi de jouer — Mot à Mot` : "Mot à Mot";
}

/* ------------------------------------------------------------------ */
/*  Temps réel                                                         */
/* ------------------------------------------------------------------ */
function startRealtime() {
  stopRealtime();
  channel = sb.channel("games-feed")
    .on("postgres_changes", { event: "*", schema: "public", table: "games" }, (p) => onGameChange(p))
    .subscribe();
}
function stopRealtime() {
  if (channel) { sb.removeChannel(channel); channel = null; }
}

async function onGameChange(p) {
  const n = p.new, o = p.old;
  if (me && n && (n.creator_id === me.id || n.opponent_id === me.id)) {
    const oppId = n.creator_id === me.id ? n.opponent_id : n.creator_id;
    const became = (cond) => cond && p.eventType === "UPDATE";
    // C'est à moi de jouer
    if (n.status === "active" && n.current_turn === me.id && became(o?.current_turn !== me.id)) {
      const opp = await getName(oppId);
      const first = n.move_count === 0;
      alertUser(first ? `${opp} a rejoint ta partie` : `À toi de jouer contre ${opp}`,
        `${n.current_word.toUpperCase()} → ${n.target_word.toUpperCase()}`, n.id);
    }
    // Fin de partie
    if (n.status === "finished" && became(o?.status !== "finished")) {
      const opp = await getName(oppId);
      const won = n.winner_id === me.id;
      const msg = n.end_reason === "resign"
        ? (won ? `${opp} a abandonné : tu gagnes !` : "Tu as abandonné la partie.")
        : (won ? "Bravo, tu as gagné ! 🎉" : `${opp} a atteint «${n.target_word.toUpperCase()}» et gagne.`);
      if (!(n.end_reason === "resign" && !won)) alertUser(`Partie terminée contre ${opp}`, msg, n.id, won ? "ok" : "info");
    }
  }
  refreshTurnBadge();
  const gid = n?.id ?? o?.id;
  if (currentGameId && gid === currentGameId) renderRoute();
  else if (!currentGameId) renderRoute();
}

/* ------------------------------------------------------------------ */
/*  Authentification                                                   */
/* ------------------------------------------------------------------ */
function authView(mode = "login") {
  const signup = mode === "signup";
  $root.innerHTML = `
    <div class="card">
      <h1>Mot à Mot</h1>
      <p class="muted">Passe d'un mot à un autre en changeant <b>une seule lettre</b> à chaque tour. Un duel à distance, à deux joueurs.</p>
      <div class="tabs">
        <button data-m="login" class="${signup ? "" : "active"}">Connexion</button>
        <button data-m="signup" class="${signup ? "active" : ""}">Créer un compte</button>
      </div>
      <form id="auth-form" autocomplete="on">
        ${signup ? `<label for="username">Pseudo (3–20 caractères : lettres, chiffres, _ -)</label>
          <input id="username" type="text" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_\\-]{3,20}" autocomplete="username">` : ""}
        <label for="email">Email</label>
        <input id="email" type="email" required autocomplete="email">
        <label for="password">Mot de passe${signup ? " (6 caractères minimum)" : ""}</label>
        <input id="password" type="password" required minlength="6" autocomplete="${signup ? "new-password" : "current-password"}">
        <div class="hint" id="auth-hint"></div>
        <button class="primary" type="submit" style="width:100%;margin-top:.4rem">${signup ? "Créer mon compte" : "Se connecter"}</button>
      </form>
    </div>`;
  $root.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => authView(b.dataset.m)));
  const hint = document.getElementById("auth-hint");
  const setHint = (t, cls = "bad") => { hint.textContent = t; hint.className = `hint ${cls}`; };

  document.getElementById("auth-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true; setHint("");
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    try {
      if (signup) {
        const username = document.getElementById("username").value.trim();
        const { data: free, error: e1 } = await sb.rpc("username_available", { p_username: username });
        if (e1) throw e1;
        if (!free) throw new Error("Ce pseudo est déjà pris.");
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { username }, emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) setHint("Compte créé ! Vérifie tes emails pour confirmer ton adresse, puis connecte-toi.", "ok");
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      const m = String(err.message || err);
      setHint(/Invalid login/i.test(m) ? "Email ou mot de passe incorrect." : /already registered/i.test(m) ? "Cet email est déjà utilisé." : m);
    } finally { btn.disabled = false; }
  };
}

async function loadProfile() {
  for (let i = 0; i < 5; i++) {
    const { data } = await sb.from("profiles").select("id, username").eq("id", session.user.id).maybeSingle();
    if (data) { nameCache.set(data.id, data.username); return data; }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function handleSession(newSession) {
  session = newSession;
  const uid = session?.user?.id ?? null;
  if (uid === currentUserId && (uid === null || me)) return;   // rien à faire (refresh de token…)
  currentUserId = uid;
  if (!uid) {
    me = null; stopRealtime(); currentGameId = null;
    document.title = "Mot à Mot";
    renderTopbar(); authView(); return;
  }
  me = await loadProfile();
  if (!me) { toast("Impossible de charger ton profil.", "error"); await sb.auth.signOut(); return; }
  renderTopbar();
  startRealtime();
  refreshTurnBadge();
  renderRoute();
}

sb.auth.onAuthStateChange((_event, s) => {
  // On évite les appels Supabase directement dans le callback.
  setTimeout(() => handleSession(s), 0);
});

/* ------------------------------------------------------------------ */
/*  Routage                                                            */
/* ------------------------------------------------------------------ */
window.addEventListener("hashchange", () => renderRoute());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && me) { refreshTurnBadge(); renderRoute(); } });

let renderToken = 0;
function renderRoute() {
  if (!me) return;
  const m = location.hash.match(/^#\/g\/([0-9a-f-]{36})$/i);
  if (m) { currentGameId = m[1]; gameView(m[1]); }
  else { currentGameId = null; lobbyView(); }
}

/* ------------------------------------------------------------------ */
/*  Lobby                                                              */
/* ------------------------------------------------------------------ */
function gameBadge(g) {
  if (g.status === "waiting") return `<span class="badge">En attente</span>`;
  if (g.status === "finished") return g.winner_id === me.id ? `<span class="badge win">Gagnée</span>` : `<span class="badge lose">Perdue</span>`;
  return g.current_turn === me.id ? `<span class="badge turn">À toi !</span>` : `<span class="badge">Tour adverse</span>`;
}

function gameItem(g, { join = false } = {}) {
  const opp = g.creator_id === me.id ? g.opponent?.username : g.creator?.username;
  const turn = g.status === "active" && g.current_turn === me.id ? " turn" : "";
  const meta = join ? `Créée par ${esc(g.creator?.username)}` : g.status === "waiting" ? "En attente d'un adversaire" : `contre ${esc(opp ?? "?")}`;
  return `<a class="game-item${turn}" href="#/g/${g.id}">
    <div><div class="words">${esc(g.start_word)} → ${esc(g.target_word)}</div>
    <div class="meta">${meta} · ${g.target_word.length} lettres · ${g.move_count} coup${g.move_count > 1 ? "s" : ""}</div></div>
    ${join ? `<span class="badge turn">Rejoindre</span>` : gameBadge(g)}</a>`;
}

async function lobbyView() {
  const token = ++renderToken;
  const { data: games, error } = await sb.from("games").select(GAME_SEL).order("updated_at", { ascending: false }).limit(100);
  if (token !== renderToken || currentGameId) return;
  if (error) { $root.innerHTML = `<p class="hint bad">${esc(error.message)}</p>`; return; }

  const mine = games.filter((g) => g.creator_id === me.id || g.opponent_id === me.id);
  const open = games.filter((g) => g.status === "waiting" && g.creator_id !== me.id);
  const rank = (g) => (g.status === "active" && g.current_turn === me.id ? 0 : g.status === "active" ? 1 : g.status === "waiting" ? 2 : 3);
  mine.sort((a, b) => rank(a) - rank(b));

  // conserver le contenu du formulaire pendant les rafraîchissements
  const keep = { s: document.getElementById("w-start")?.value ?? "", t: document.getElementById("w-target")?.value ?? "" };
  const hadFocus = document.activeElement?.id;

  $root.innerHTML = `
    <div class="card">
      <h2>Nouvelle partie</h2>
      <form id="new-game">
        <div class="row">
          <div><label for="w-start">Mot de départ</label><input id="w-start" type="text" required maxlength="12" autocomplete="off" autocapitalize="off" value="${esc(keep.s)}"></div>
          <div><label for="w-target">Mot d'arrivée</label><input id="w-target" type="text" required maxlength="12" autocomplete="off" autocapitalize="off" value="${esc(keep.t)}"></div>
        </div>
        <div class="hint" id="new-hint"></div>
        <button class="primary" type="submit" id="new-btn" style="width:100%">Lancer la partie</button>
      </form>
    </div>
    <h2>Mes parties</h2>
    ${mine.length ? mine.map((g) => gameItem(g)).join("") : `<p class="muted">Aucune partie pour l'instant.</p>`}
    <h2 style="margin-top:1.4rem">Parties à rejoindre</h2>
    ${open.length ? open.map((g) => gameItem(g, { join: true })).join("") : `<p class="muted">Aucune partie en attente. Crée-en une et partage le lien !</p>`}`;

  const s = document.getElementById("w-start"), t = document.getElementById("w-target");
  const hint = document.getElementById("new-hint"), btn = document.getElementById("new-btn");
  const check = () => {
    const a = normWord(s.value), b = normWord(t.value);
    let msg = "", ok = false;
    if (!a && !b) msg = "";
    else if ((a && !WORD_RE.test(a)) || (b && !WORD_RE.test(b))) msg = "Lettres uniquement (pas d'espace, de chiffre ni de tiret).";
    else if (a.length < 2 || b.length < 2) msg = "2 lettres minimum.";
    else if (Array.from(a).length !== Array.from(b).length) msg = `Les deux mots doivent avoir la même longueur (${Array.from(a).length} ≠ ${Array.from(b).length}).`;
    else if (a === b) msg = "Les deux mots doivent être différents.";
    else { msg = `${Array.from(a).length} lettres — ${diffCount(a, b)} lettre${diffCount(a, b) > 1 ? "s" : ""} à changer au minimum.`; ok = true; }
    hint.textContent = msg; hint.className = `hint ${ok ? "ok" : "bad"}`; btn.disabled = !ok;
  };
  s.oninput = t.oninput = check; check();
  if (hadFocus === "w-start" || hadFocus === "w-target") document.getElementById(hadFocus).focus();

  document.getElementById("new-game").onsubmit = async (e) => {
    e.preventDefault(); btn.disabled = true;
    const { data, error } = await sb.rpc("create_game", { p_start: normWord(s.value), p_target: normWord(t.value) });
    if (error) { toast(error.message, "error"); btn.disabled = false; return; }
    location.hash = `#/g/${data}`;
  };
}

/* ------------------------------------------------------------------ */
/*  Partie                                                             */
/* ------------------------------------------------------------------ */
async function gameView(id) {
  const token = ++renderToken;
  const [{ data: g, error }, { data: moves }] = await Promise.all([
    sb.from("games").select(GAME_SEL).eq("id", id).maybeSingle(),
    sb.from("moves").select("id, word, player_id, player:profiles(username)").eq("game_id", id).order("id"),
  ]);
  if (token !== renderToken || currentGameId !== id) return;

  if (error || !g) {
    $root.innerHTML = `<div class="card center"><p>Partie introuvable, annulée ou déjà complète.</p><a class="btn" href="#/">← Retour</a></div>`;
    return;
  }

  const isPlayer = g.creator_id === me.id || g.opponent_id === me.id;
  const oppName = g.creator_id === me.id ? g.opponent?.username : g.creator?.username;
  const myTurn = g.status === "active" && g.current_turn === me.id;
  const list = moves ?? [];
  const used = new Set([g.start_word, ...list.map((m) => m.word)]);

  let status = "";
  if (g.status === "waiting") status = isPlayer ? "En attente d'un adversaire…" : `${esc(g.creator?.username)} cherche un adversaire`;
  else if (g.status === "active") status = myTurn ? "🔔 À toi de jouer !" : `Tour de ${esc(oppName)}…`;
  else {
    const won = g.winner_id === me.id;
    const winner = g.winner_id === g.creator_id ? g.creator?.username : g.opponent?.username;
    status = !isPlayer ? `Victoire de ${esc(winner)}`
      : g.end_reason === "resign" ? (won ? "🏆 Ton adversaire a abandonné : tu gagnes !" : "Tu as abandonné la partie.")
      : won ? "🏆 Bravo, tu as gagné !" : `${esc(oppName)} a gagné cette partie.`;
  }

  let prev = g.start_word;
  const chain = [`<li><span>${tiles(g.start_word, { size: "small" })}</span><span class="who">départ</span></li>`]
    .concat(list.map((m) => {
      const html = `<li><span>${tiles(m.word, { prev, size: "small" })}</span><span class="who">${esc(m.player?.username ?? "?")}</span></li>`;
      prev = m.word; return html;
    })).join("");

  let actions = "";
  if (g.status === "waiting" && !isPlayer) actions = `<button class="primary" id="btn-join" style="width:100%">Rejoindre la partie</button>`;
  else if (g.status === "waiting") actions = `<div class="row"><button id="btn-copy">🔗 Copier le lien d'invitation</button><button class="danger" id="btn-cancel">Annuler la partie</button></div>`;
  else if (g.status === "active" && isPlayer) actions = `<button class="danger small" id="btn-resign">Abandonner</button>`;

  const playForm = myTurn ? `
    <form id="play-form" class="card">
      <label for="play-word">Modifie exactement une lettre :</label>
      <input id="play-word" class="play-input" type="text" maxlength="${g.current_word.length}" value="${esc(g.current_word)}" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="hint" id="play-hint"></div>
      <button class="primary" type="submit" id="play-btn" style="width:100%" disabled>Valider</button>
    </form>` : "";

  const typed = document.getElementById("play-word")?.value;   // garder la saisie en cours
  $root.innerHTML = `
    <p><a href="#/">← Mes parties</a></p>
    <div class="card">
      <div class="goal">${tiles(g.start_word, { size: "small" })}<span class="arrow">→</span>${tiles(g.target_word, { size: "small" })}</div>
      <div class="status ${myTurn ? "mine" : ""}">${status}</div>
      ${g.status !== "waiting" ? `<div class="current"><div class="label">Mot actuel</div>${tiles(g.current_word, { target: g.target_word })}</div>` : ""}
      ${actions}
    </div>
    ${playForm}
    <div class="card"><h2>Historique (${list.length} coup${list.length > 1 ? "s" : ""})</h2><ul class="chain">${chain}</ul></div>`;

  // --- actions
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  const rpc = async (fn, args) => { const { error } = await sb.rpc(fn, args); if (error) toast(error.message, "error"); return !error; };
  on("btn-join", async () => { if (await rpc("join_game", { p_game: id })) gameView(id); });
  on("btn-cancel", async () => { if (confirm("Annuler cette partie ?") && (await rpc("resign_game", { p_game: id }))) location.hash = "#/"; });
  on("btn-resign", async () => { if (confirm("Abandonner la partie ? Ton adversaire gagnera.")) await rpc("resign_game", { p_game: id }); });
  on("btn-copy", async () => {
    const url = location.href;
    try { await navigator.clipboard.writeText(url); toast("Lien copié ! Envoie-le à ton adversaire.", "ok"); }
    catch { prompt("Copie ce lien :", url); }
  });

  // --- saisie d'un coup
  if (myTurn) {
    const input = document.getElementById("play-word"), hint = document.getElementById("play-hint"), btn = document.getElementById("play-btn");
    if (typed && Array.from(typed).length === Array.from(g.current_word).length) input.value = typed;
    const check = () => {
      const w = normWord(input.value);
      let msg = "", ok = false;
      if (!WORD_RE.test(w)) msg = "Lettres uniquement.";
      else {
        const d = diffCount(w, g.current_word);
        if (d === 0) msg = "Change une lettre pour jouer.";
        else if (d !== 1) msg = "Tu dois changer exactement une lettre.";
        else if (used.has(w)) msg = "Ce mot a déjà été utilisé.";
        else { ok = true; msg = w === g.target_word ? "🎯 C'est le mot d'arrivée !" : "Coup valide."; }
      }
      hint.textContent = msg; hint.className = `hint ${ok ? "ok" : "bad"}`; btn.disabled = !ok;
    };
    input.oninput = check; check();
    if (document.visibilityState === "visible") { input.focus(); }
    document.getElementById("play-form").onsubmit = async (e) => {
      e.preventDefault(); btn.disabled = true;
      const { error } = await sb.rpc("play_move", { p_game: id, p_word: normWord(input.value) });
      if (error) { toast(error.message, "error"); btn.disabled = false; }
      else gameView(id);
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Démarrage                                                          */
/* ------------------------------------------------------------------ */
sb.auth.getSession().then(({ data }) => { if (!data.session) handleSession(null); });
