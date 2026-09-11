/* Le comportement de l’interface. Chargé en defer depuis index.html : il
   s’exécute une fois tout le balisage lu, sans attendre DOMContentLoaded. */
const $ = (id) => document.getElementById(id);
const NUM = new Intl.NumberFormat("fr-FR");
const BOOLS = ["checkExternal","checkAssets","respectRobots","includeSubdomains","followNofollow","ignoreQuery","collectSeo","useSitemap"];
const NUMS = ["concurrency","delayMs","maxDepth","maxPages","timeoutMs"];
const STRS = ["sitemapUrl"];
const MAX_TABLE_ROWS = 500;
const TITLE = document.title;
const IDLE = '<p class="note"><b>Aucun audit lancé</b>Entrez l’URL d’un site pour explorer ses pages et relever chaque lien cassé avec la page qui le contient.</p>';
const WHEN = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const CHAT_PLACEHOLDER = "https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…";
const SECS = ["sec-presets", "sec-cfg", "sec-scope", "sec-hook"];
const TABS = [["tab-broken", "broken"], ["tab-all", "all"], ["tab-orphans", "orphans"], ["tab-synth", "synth"]];
/* ⌘ sur Mac, Ctrl ailleurs : l'aide nomme la touche que l'utilisateur a sous les doigts. */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘" : "Ctrl";

const rows = new Map();      // url -> wire row {u,s,k,d,m,b,t,n,r?,e?,f?,seo?}
let sessions = [];           // en-têtes d'audits, du plus récent au plus ancien
let presetList = [];
const picked = new Set();    // audits sélectionnés dans l'historique, pour une suppression groupée
const shut = new Set();      // liens cassés dont l'utilisateur a replié les referers
let anchor = null;           // extrémité fixe d'une sélection par plage (Maj)
let cursor = null;           // la seule entrée d'historique que Tab atteint ; les flèches la déplacent
let opening = 0;             // numéro de la dernière ouverture demandée : seule elle s'affiche
let stats = null, id = null, es = null, target = "";
let shown = null;            // en-tête de l'audit affiché, que le titre reprend à la fin du crawl
let view = "broken", filter = null, query = "", sortKey = "s", sortDir = -1;
let smInfo = null;   // fichiers sitemap lus par l'audit affiché, et leurs erreurs
let painting = false, pendingPaint = false, halting = false, starting = false;
let notice = null;   // message d'erreur affiché à la place du panneau vide

/* ---- classement des status ---- */
const klass = (r) => {
  if (r.s >= 500) return "5";
  if (r.s >= 400) return "4";
  if (r.s >= 300) return "3";
  if (r.s >= 200) return "2";
  return "x";
};
const broken = (r) => r.s >= 400 || (r.s === 0 && !!r.e && r.e !== "aborted"); // ni en file, ni annulée
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const linkable = (u) => /^https?:\/\//i.test(u);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return u; } };
const short = (u) => u.replace(/^https?:\/\//, "").replace(/\/$/, "") || u;
const dur = (ms) => (ms < 950 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const bytes = (n) => !n ? "" : n < 1024 ? n + " o" : n < 1048576 ? (n/1024).toFixed(0) + " ko" : (n/1048576).toFixed(1) + " Mo";
const label = (r) =>
  r.s ? r.s
  : !r.e ? "en file"
  : r.e === "robots" ? "robots"
  : r.e === "private-host" ? "privé"
  : r.e === "bad-url" ? "url"
  : r.e === "aborted" ? "arrêté"
  : "échec";

/* ---- lancement ---- */
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (es || starting) return; // un crawl tourne déjà, ou est en train de démarrer
  const opts = readOpts();
  askNotify();

  reset();
  busy(true);
  starting = true;
  try {
    const res = await fetch("/api/crawl", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: $("url").value.trim(), opts }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "démarrage impossible");
    id = data.id;
    target = data.start;
    starting = false;
    tools(true);
    shown = { host: hostOf(target), startedAt: Date.now(), reason: "", stats: { live: true } };
    crumb(shown);
    connect();
    loadSessions();
  } catch (err) {
    starting = false;
    busy(false);
    tools(false);
    crumb(null);
    $("meter").hidden = true;
    notice = '<p class="note"><b class="err">Audit non démarré</b>' + esc(err.message) + "</p>";
    render();
  }
});

/** Les réglages du formulaire, dans la forme attendue par l'API. Partagé par le
    lancement et par l'enregistrement d'un preset, pour qu'ils ne divergent pas. */
function readOpts() {
  const opts = {};
  for (const k of BOOLS) opts[k] = $(k).checked;
  for (const k of NUMS) opts[k] = Number($(k).value);
  for (const k of STRS) opts[k] = $(k).value.trim();
  opts.exclude = $("exclude").value.split("\n").map((t) => t.trim()).filter(Boolean);
  return opts;
}

/** Bascule la ligne de lancement dans son état « crawl en cours ». */
function busy(on) {
  if (on) {
    halting = false;
    $("halt").disabled = false;
    $("halt").classList.remove("pending");
    $("halt").textContent = "Arrêter";
  }
  $("form").classList.toggle("busy", on);
  $("go").hidden = on;
  $("halt").hidden = !on;
  $("bar").classList.toggle("working", on);
  $("del").disabled = on; // un audit en cours ne se supprime pas
}

/* L'arrêt n'est pas instantané : les requêtes en vol doivent se dénouer, le
   bouton porte donc l'attente plutôt que de paraître inerte. */
$("halt").addEventListener("click", () => {
  if (!id || halting) return;
  halting = true;
  $("halt").disabled = true;
  $("halt").classList.add("pending");
  $("halt").textContent = "Arrêt…";
  $("rd-tag").textContent = "arrêt en cours";
  fetch(`/api/crawl/${id}/stop`, { method: "POST" }).catch(() => {});
});
$("dl-pages").addEventListener("click", () => id && (location.href = `/api/crawl/${id}/pages.csv`));
$("dl-broken").addEventListener("click", () => id && (location.href = `/api/crawl/${id}/broken.csv`));
$("del").addEventListener("click", () => id && drop(id));

/* ---- barre d'historique ----
   Une liste à sélection multiple, à la souris comme au clavier. Un clic ouvre
   un audit ; la pastille, ⌘/Ctrl-clic ou Espace le sélectionne ; Maj étend la
   sélection. Ouvrir et sélectionner restent indépendants : on peut consulter
   des audits sans perdre ceux qu'on s'apprête à supprimer. */
const tools = (on) => { $("acts").hidden = !on; $("rail").hidden = !on; };
const live = (m) => !!(m.stats && m.stats.live);
const pickable = (sid) => sessions.some((m) => m.id === sid && !live(m));
const focusCursor = () => $("side-list").querySelector('.ses[tabindex="0"]')?.focus();

function state(m) {
  if (live(m)) return "run";
  if (m.broken > 0) return "bad";
  if (m.reason === "interrompu" || /arrêté/.test(m.reason)) return "stop";
  return "ok";
}

function summary(m) {
  if (live(m)) return `en cours · ${NUM.format(m.stats ? m.stats.done : 0)} URLs`;
  const n = m.stats ? m.stats.total : 0;
  const bad = m.broken
    ? `${NUM.format(m.broken)} ${m.broken === 1 ? "lien cassé" : "liens cassés"}`
    : m.reason === "interrompu" ? "interrompu" : "aucun lien cassé";
  return `${NUM.format(n)} URL${n === 1 ? "" : "s"} · ${bad}`;
}

async function loadSessions() {
  try {
    sessions = await (await fetch("/api/sessions")).json();
  } catch {
    return; // le serveur répondra au prochain rafraîchissement
  }
  renderSide();
}

const entry = (m) =>
  `<div class="ses" role="option" data-id="${esc(m.id)}" tabindex="${m.id === cursor ? 0 : -1}"` +
    ` aria-selected="${picked.has(m.id)}"${m.id === id ? ' aria-current="true"' : ""}` +
    (live(m) ? ' data-live title="Audit en cours : il se supprime une fois arrêté."' : "") + `>` +
    `<span class="ses-mark"${live(m) ? "" : ` title="Sélectionner — ou ${MOD}-clic sur l’audit"`}>` +
      `<i class="dot" data-s="${state(m)}"></i><svg class="i" aria-hidden="true"><use href="#i-check"/></svg></span>` +
    `<span class="ses-main">` +
      `<span class="ses-top"><span class="ses-host">${esc(m.host)}</span>` +
        `<span class="ses-when">${esc(WHEN.format(new Date(m.startedAt)))}</span></span>` +
      `<span class="ses-sub">${m.preset ? `<i class="ses-tag">${esc(m.preset)}</i>` : ""}` +
        `<span class="ses-sum">${esc(summary(m))}</span></span>` +
    `</span>` +
  `</div>`;

function renderSide() {
  const box = $("side-list");
  // Un audit élagué par le serveur, ou repassé en cours, ne reste pas
  // sélectionné : la sélection ne garde que ce qui peut être supprimé.
  for (const sid of picked) if (!pickable(sid)) picked.delete(sid);
  $("side-n").textContent = sessions.length ? NUM.format(sessions.length) : "";
  if (!sessions.some((m) => m.id === cursor)) cursor = sessions.some((m) => m.id === id) ? id : sessions[0]?.id ?? null;
  // Reconstruire la liste lui ôte le focus : on le rend au curseur.
  const refocus = box.contains(document.activeElement);
  box.innerHTML = sessions.length
    ? sessions.map(entry).join("")
    : '<p class="side-empty">Aucun audit enregistré pour l’instant. Le premier apparaîtra ici et y restera après un redémarrage.</p>';
  if (refocus) focusCursor();
  pickBar();
}

/** Reporte la sélection sur la liste sans la reconstruire : le focus reste en place. */
function paintPicks() {
  for (const o of $("side-list").querySelectorAll(".ses")) o.setAttribute("aria-selected", String(picked.has(o.dataset.id)));
  pickBar();
}

function pickBar() {
  const n = picked.size;
  // La classe garde les pastilles en anneau hors survol pendant une sélection.
  $("side-list").classList.toggle("picking", n > 0);
  $("picks").hidden = n === 0;
  $("picks-n").textContent = `${n} audit${n > 1 ? "s" : ""} sélectionné${n > 1 ? "s" : ""}`;
}

function togglePick(sid) {
  if (!pickable(sid)) return;
  if (picked.has(sid)) picked.delete(sid);
  else picked.add(sid);
  anchor = sid;
  paintPicks();
}

/** Ajoute à la sélection les audits compris entre a et b, dans l'ordre affiché. */
function pickRange(a, b) {
  const ids = sessions.map((m) => m.id);
  let i = ids.indexOf(a), j = ids.indexOf(b);
  if (i < 0) i = j;
  if (i > j) [i, j] = [j, i];
  for (const m of sessions.slice(i, j + 1)) if (!live(m)) picked.add(m.id);
  paintPicks();
}

function pickAll() {
  for (const m of sessions) if (!live(m)) picked.add(m.id);
  paintPicks();
}

function clearPicks() {
  picked.clear();
  anchor = null;
  paintPicks();
}

/** Déplace le curseur : un seul tabindex="0" dans toute la liste. */
function moveTo(o, focus = true) {
  for (const x of $("side-list").querySelectorAll('.ses[tabindex="0"]')) x.tabIndex = -1;
  o.tabIndex = 0;
  cursor = o.dataset.id;
  if (focus) o.focus();
}

$("side-list").addEventListener("click", (e) => {
  const o = e.target.closest(".ses");
  if (!o) return;
  const sid = o.dataset.id;
  moveTo(o, false);
  if (e.shiftKey) pickRange(anchor ?? id ?? sid, sid);
  else if (e.metaKey || e.ctrlKey || e.target.closest(".ses-mark")) togglePick(sid);
  else {
    anchor = sid;
    if (sid !== id) show(sid);
  }
});

$("side-list").addEventListener("keydown", (e) => {
  const o = e.target.closest(".ses");
  if (!o) return;
  const all = [...$("side-list").querySelectorAll(".ses")];
  const i = all.indexOf(o);
  const mod = e.metaKey || e.ctrlKey;
  let to = -1;
  if (e.key === "ArrowDown") to = Math.min(all.length - 1, i + 1);
  else if (e.key === "ArrowUp") to = Math.max(0, i - 1);
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = all.length - 1;
  else if (e.key === "Enter" && !mod) { anchor = o.dataset.id; if (o.dataset.id !== id) show(o.dataset.id); }
  else if (e.key === " " && !mod) togglePick(o.dataset.id);
  else if (e.key.toLowerCase() === "a" && mod) pickAll();
  else return;
  e.preventDefault();
  if (to < 0) return;
  // Maj étend la sélection au fil du déplacement, comme un gestionnaire de fichiers.
  if (e.shiftKey) pickRange(o.dataset.id, all[to].dataset.id);
  moveTo(all[to]);
});

$("picks-del").addEventListener("click", () => dropMany());
$("picks-clear").addEventListener("click", () => clearPicks());

/** Après une suppression, le curseur passe à l'audit suivant, à défaut au précédent. */
function after(ids) {
  const at = sessions.findIndex((m) => ids.includes(m.id));
  const rest = sessions.filter((m) => !ids.includes(m.id));
  const next = sessions.slice(at).find((m) => !ids.includes(m.id)) || rest[rest.length - 1];
  return next ? next.id : null;
}

async function drop(sid) {
  const m = sessions.find((x) => x.id === sid);
  if (m && live(m)) return ask("Cet audit est en cours : arrêtez-le avant de le supprimer.");
  if (!(await ask("Supprimer cet audit et ses résultats ?", "Supprimer"))) return;
  const next = after([sid]);
  await fetch(`/api/crawl/${sid}`, { method: "DELETE" }).catch(() => {});
  picked.delete(sid);
  if (sid === id) blank(false);
  cursor = next;
  await loadSessions();
  if (document.activeElement === document.body) focusCursor();
}

/**
 * Suppression des audits sélectionnés. Les requêtes partent ensemble et restent
 * indépendantes côté serveur : un échec isolé laisse son audit sélectionné,
 * prêt pour un nouvel essai, sans annuler les autres.
 */
async function dropMany() {
  const ids = sessions.filter((m) => picked.has(m.id) && !live(m)).map((m) => m.id);
  if (!ids.length) return;
  const q = ids.length === 1
    ? "Supprimer cet audit et ses résultats ?"
    : `Supprimer ${ids.length} audits et leurs résultats ?`;
  if (!(await ask(q, "Supprimer"))) return;
  const next = after(ids);
  const done = await Promise.all(ids.map((sid) =>
    fetch(`/api/crawl/${sid}`, { method: "DELETE" }).then((r) => r.ok, () => false)));
  ids.forEach((sid, i) => { if (done[i]) picked.delete(sid); });
  const cur = ids.indexOf(id);
  if (cur >= 0 && done[cur]) blank(false);
  cursor = next;
  await loadSessions();
  if (document.activeElement === document.body) focusCursor();
  const failed = done.filter((ok) => !ok).length;
  if (failed) ask(`${failed} audit${failed === 1 ? " n’a" : "s n’ont"} pas pu être supprimé${failed === 1 ? "" : "s"}.`);
}

/**
 * Remplace confirm() et alert(), même contrat, en promesse : une boîte au style
 * de l'interface, fermée par Échap, dont le bouton d'action a le focus — ⌫ puis
 * Entrée suffisent à supprimer au clavier. Sans libellé d'action, elle informe.
 */
function ask(msg, yes = "") {
  const d = $("ask");
  $("ask-msg").textContent = msg;
  $("ask-yes").hidden = !yes;
  $("ask-yes").textContent = yes;
  $("ask-no").textContent = yes ? "Annuler" : "OK";
  d.returnValue = "";
  d.showModal();
  (yes ? $("ask-yes") : $("ask-no")).focus();
  return new Promise((ok) => d.addEventListener("close", () => ok(d.returnValue === "yes"), { once: true }));
}
// Un clic hors de la boîte l'annule, comme Échap.
$("ask").addEventListener("click", (e) => { if (e.target === $("ask")) $("ask").close(); });

/* ---- presets ----
   Un preset porte la cible et ses réglages sous un nom. Il se recharge dans le
   formulaire d'un clic, et se déclenche de l'extérieur avec son jeton : la
   section Webhook en donne la commande et la notification Google Chat. */
const selected = () => presetList.find((x) => x.name === $("preset-sel").value);

async function loadPresets() {
  try {
    presetList = await (await fetch("/api/presets")).json();
  } catch {
    return; // le serveur répondra au prochain rafraîchissement
  }
  renderPresets();
}

function renderPresets() {
  const sel = $("preset-sel");
  const cur = sel.value;
  sel.innerHTML = '<option value="">— aucun —</option>' +
    presetList.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
  sel.value = presetList.some((p) => p.name === cur) ? cur : "";
  presetTools();
}

/**
 * Le webhook ne vise que le preset sélectionné. Le champ de la notification est
 * vidé au passage : son URL n'est jamais renvoyée par l'API, la laisser à
 * l'écran ferait croire qu'elle a été relue.
 */
function presetTools() {
  const p = selected();
  $("preset-del").disabled = !p;
  $("hook-none").hidden = !!p;
  $("hook").hidden = !p;
  $("hook-name").textContent = p ? p.name : "";
  $("chat-state").textContent = p ? (p.chat ? "— active" : "— aucune") : "";
  $("preset-chat-del").disabled = !p?.chat;
  $("preset-chat").value = "";
  $("preset-chat").placeholder = p?.chat ? "notification enregistrée — collez une URL pour la remplacer" : CHAT_PLACEHOLDER;
  if (!p) curl("");
  else if ($("preset-curl").dataset.name !== p.name) curl(p.name);
  hints();
}

function say(box, text, err) {
  const el = $(box);
  el.hidden = !text;
  el.className = "msg" + (err ? " err" : "");
  el.textContent = text || "";
}

/* Le jeton n'est montré qu'une fois, et nulle part ailleurs : ni dans l'URL,
   ni dans un attribut, ni dans le stockage du navigateur. Sans jeton frais, la
   commande garde une variable à sa place, prête pour un secret de CI. */
function curl(name, token) {
  const box = $("preset-curl");
  $("preset-key").hidden = !token;
  box.dataset.name = name;
  box.value = !name ? "" :
    `curl -X POST ${location.origin}/api/hooks/run \\\n` +
    `  -H "Authorization: Bearer ${token || "$CROWLER_TOKEN"}" \\\n` +
    `  -H "content-type: application/json" \\\n` +
    `  -d '{"preset":"${name}"}'`;
}

/** Montre un jeton frais : la section s'ouvre, et le focus attend sur « Copier ». */
function showToken(name, token) {
  curl(name, token);
  $("sec-hook").open = true;
  $("preset-copy").focus();
}

/** Enregistre un preset. Partagé par les deux boutons qui le font, pour qu'ils ne divergent pas. */
async function putPreset(body) {
  const res = await fetch("/api/presets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "enregistrement impossible");
  return data;
}

$("preset-sel").addEventListener("change", () => {
  curl(""); // un jeton affiché ne survit pas à un changement de preset
  say("preset-msg", "");
  say("hook-msg", "");
  presetTools();
  const p = selected();
  if (!p) return;
  $("preset-name").value = p.name;
  applyOpts({ start: p.url, opts: p.opts }); // le formulaire porte le preset, prêt à lancer
});

$("preset-save").addEventListener("click", async () => {
  const name = ($("preset-name").value.trim() || $("preset-sel").value).trim();
  if (!name) return say("preset-msg", "Donnez un nom au preset.", true);
  curl("");
  try {
    // chatUrl vide : le serveur garde la notification déjà enregistrée.
    const data = await putPreset({ name, url: $("url").value.trim(), opts: readOpts(), chatUrl: "" });
    await loadPresets();
    $("preset-sel").value = name;
    presetTools();
    say("hook-msg", "");
    if (!data.token) return say("preset-msg", `Preset « ${name} » mis à jour. Son jeton reste valable.`);
    say("preset-msg", `Preset « ${name} » créé. Son jeton s’affiche une seule fois, dans la section Webhook.`);
    showToken(name, data.token);
  } catch (err) {
    say("preset-msg", err.message, true);
  }
});

$("preset-token").addEventListener("click", async () => {
  const name = $("preset-sel").value;
  if (!name) return;
  if (!(await ask(`Régénérer le jeton de « ${name} » ? L’ancien cessera immédiatement de fonctionner.`, "Régénérer"))) return;
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}/token`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "rotation impossible");
    say("hook-msg", `Nouveau jeton pour « ${name} ». L’ancien ne fonctionne plus.`);
    showToken(name, data.token);
  } catch (err) {
    say("hook-msg", err.message, true);
  }
});

/* La notification se change seule : le preset est renvoyé avec la cible et les
   réglages qu'il porte déjà, pas avec ceux du formulaire, peut-être modifiés
   depuis son chargement. */
$("chat-save").addEventListener("click", async () => {
  const p = selected();
  if (!p) return;
  const chatUrl = $("preset-chat").value.trim();
  if (!chatUrl) return say("hook-msg", "Collez d’abord l’URL du webhook Google Chat.", true);
  try {
    await putPreset({ name: p.name, url: p.url, opts: p.opts, chatUrl });
    await loadPresets();
    say("hook-msg", `Notification enregistrée pour « ${p.name} ».`);
  } catch (err) {
    say("hook-msg", err.message, true);
  }
});

$("preset-chat-del").addEventListener("click", async () => {
  const name = $("preset-sel").value;
  if (!name) return;
  if (!(await ask(`Retirer la notification Google Chat de « ${name} » ? Ses audits ne préviendront plus personne.`, "Retirer"))) return;
  try {
    const res = await fetch(`/api/presets/${encodeURIComponent(name)}/chat`, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error || "retrait impossible");
    await loadPresets();
    say("hook-msg", `Notification retirée de « ${name} ».`);
  } catch (err) {
    say("hook-msg", err.message, true);
  }
});

$("preset-del").addEventListener("click", async () => {
  const name = $("preset-sel").value;
  if (!name) return;
  if (!(await ask(`Supprimer le preset « ${name} » ? Son jeton cessera de fonctionner.`, "Supprimer"))) return;
  await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
  $("preset-sel").value = "";
  $("preset-name").value = "";
  await loadPresets();
  say("hook-msg", "");
  say("preset-msg", `Preset « ${name} » supprimé.`);
});

$("preset-copy").addEventListener("click", async () => {
  const t = $("preset-curl");
  try {
    await navigator.clipboard.writeText(t.value);
    say("hook-msg", "Commande copiée.");
  } catch {
    t.select(); // presse-papiers refusé (hors HTTPS, ou permission) : à copier à la main
    say("hook-msg", "Copiez la commande sélectionnée.");
  }
});

// Entrée valide le champ où l'on tape ; ⌘/Ctrl+Entrée reste réservé au lancement.
for (const [field, button] of [["preset-name", "preset-save"], ["preset-chat", "chat-save"]]) {
  $(field).addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    $(button).click();
  });
}

/** Charge un audit : reprise en direct s'il tourne encore, relecture sinon. */
async function show(sid) {
  const n = ++opening;
  if (es) { es.close(); es = null; }
  halting = false;
  let m;
  try {
    const res = await fetch(`/api/crawl/${sid}`);
    if (!res.ok) throw new Error();
    m = await res.json();
  } catch {
    if (n !== opening) return;
    blank();
    return loadSessions();
  }
  if (n !== opening) return; // une ouverture plus récente l'emporte
  id = m.id; target = m.start; stats = m.stats; filter = null; notice = null; shown = m;
  cursor = m.id; // Tab ramène dans l'historique sur l'audit ouvert
  smInfo = m.sitemap || null;
  rows.clear();
  shut.clear();
  applyOpts(m);
  tools(true);
  crumb(m);
  renderSide();
  $("legend").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  $("meter").hidden = false;
  $("readout").dataset.state = live(m) ? "run" : "done";

  if (live(m)) {
    busy(true);
    $("panel").innerHTML = '<p class="note">Reprise de l’audit en cours…</p>';
    return connect();  // le snapshot SSE rapatrie les lignes déjà collectées
  }
  busy(false);
  $("panel").innerHTML = '<p class="note">Lecture de l’audit…</p>';
  await replay(sid);
  if (sid !== id) return; // l'utilisateur a changé d'audit entre-temps
  finish(m, false);
  render();
}

/** Relit les lignes d'un audit terminé, en flux : le NDJSON n'est jamais bufferisé entier. */
async function replay(sid) {
  let res;
  try {
    res = await fetch(`/api/crawl/${sid}/rows`);
    if (!res.ok) throw new Error();
  } catch {
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const take = (line) => { if (line) { const r = JSON.parse(line); rows.set(r.u, r); } };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (sid !== id) return reader.cancel().catch(() => {});
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { take(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  take(buf.trim());
}

/** Remet le formulaire sur les réglages de l'audit affiché : le relancer est à un clic. */
function applyOpts(m) {
  $("url").value = m.start;
  if (m.opts) {
    for (const k of BOOLS) if (typeof m.opts[k] === "boolean") $(k).checked = m.opts[k];
    for (const k of NUMS) if (Number.isFinite(m.opts[k])) $(k).value = m.opts[k];
    for (const k of STRS) $(k).value = typeof m.opts[k] === "string" ? m.opts[k] : "";
    $("exclude").value = (m.opts.exclude || []).join("\n");
  }
  hints();
}

/** Le ton du badge suit la raison de fin : en cours, arrêté, plafonné ou terminé. */
const tone = (m) =>
  live(m) ? "run"
  : /interrompu|arrêt|stopped/.test(m.reason || "") ? "stop"
  : /limite/.test(m.reason || "") ? "warn"
  : "ok";

function crumb(m) {
  $("crumb").innerHTML = m
    ? `<h1>${esc(m.host)}</h1>` +
      `<p class="crumb-m"><span class="badge" data-s="${tone(m)}">${esc(live(m) ? "en cours" : m.reason || "terminé")}</span>` +
      `<span>${esc(WHEN.format(new Date(m.startedAt)))}</span>` +
      (m.preset ? `<i class="ses-tag">${esc(m.preset)}</i>` : "") + `</p>`
    : '<h1>Nouvel audit</h1><p class="crumb-m">Explorez un site, relevez chaque lien cassé et la page qui le contient.</p>';
}

/** Écran vide, prêt pour un nouvel audit. */
function blank(focus = true) {
  if (es) { es.close(); es = null; }
  id = null; target = ""; stats = null; filter = null; halting = false; notice = null; smInfo = null; shown = null;
  rows.clear();
  shut.clear();
  busy(false);
  tools(false);
  crumb(null);
  renderSide();
  $("legend").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  $("meter").hidden = true;
  document.title = TITLE;
  render();
  $("panel").innerHTML = IDLE;
  if (focus) $("url").focus();
}
$("new").addEventListener("click", () => blank());

function reset() {
  rows.clear(); stats = null; filter = null; id = null; notice = null; smInfo = null; shown = null;
  shut.clear();
  if (es) { es.close(); es = null; }
  $("legend").querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  $("meter").hidden = false;
  $("readout").dataset.state = "run";
  $("rd-tag").textContent = "démarrage";
  $("rd-done").textContent = "0";
  $("rd-unit").textContent = "URLs";
  $("rd-rest").innerHTML = "";
  $("panel").innerHTML = '<p class="note">Résolution de robots.txt et de la page de départ…</p>';
  paint();
}

function connect() {
  es = new EventSource(`/api/crawl/${id}/events`);
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.rows) for (const r of m.rows) rows.set(r.u, r);
    if (m.stats) stats = m.stats;
    if (m.type === "done") {
      smInfo = m.sitemap || null;
      es.close(); es = null;
      busy(false);
      finish(m);
    }
    paint();
  };
  // Le job a été évincé de la mémoire : l'audit reste lisible sur disque.
  es.addEventListener("gone", () => { es.close(); es = null; if (id) show(id); });
  es.onerror = () => { if (es && es.readyState === 2) { es = null; busy(false); } };
}

/* ---- dessin ----
   Cadencé par un minuteur, pas par requestAnimationFrame : rAF ne se déclenche
   jamais dans un onglet en arrière-plan, et un crawl laissé tourner n'aurait
   rien affiché au retour. Le drapeau de traîne garantit que le dernier lot est
   toujours dessiné. */
function paint() {
  if (painting) { pendingPaint = true; return; }
  painting = true;
  setTimeout(() => {
    painting = false;
    render();
    if (pendingPaint) { pendingPaint = false; paint(); }
  }, 100);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

function counts() {
  const c = { "2":0, "3":0, "4":0, "5":0, x:0 };
  for (const r of rows.values()) if (r.s || r.e) c[klass(r)]++;
  return c;
}

const pair = (n, k) => `<span class="rd-pair"><b>${n}</b>${k ? " " + k : ""}</span>`;

function render() {
  const c = counts();
  const settled = c["2"] + c["3"] + c["4"] + c["5"] + c.x;
  const pending = stats ? stats.queued + stats.inflight : 0;
  // La barre sert aussi de progression : plein = réglé, queue hachurée = encore en file.
  const frac = settled + pending ? settled / (settled + pending) : 0;
  for (const seg of $("bar").children) {
    seg.style.width = (settled ? (c[seg.dataset.k] / settled) * frac * 100 : 0) + "%";
  }
  for (const chip of $("legend").querySelectorAll(".chip")) {
    chip.querySelector("b").textContent = NUM.format(c[chip.dataset.k]);
    chip.dataset.empty = c[chip.dataset.k] === 0;
  }

  if (stats && stats.live) {
    const rate = stats.elapsed > 500 ? Math.round(stats.done / (stats.elapsed / 1000)) : 0;
    $("rd-tag").textContent = "exploration";
    $("rd-done").textContent = NUM.format(stats.done);
    $("rd-unit").textContent = "explorées";
    $("rd-rest").innerHTML =
      pair(NUM.format(stats.queued), "en file") + pair(stats.inflight, "en cours") + pair(rate, "URLs/s") +
      (stats.sitemap ? pair(NUM.format(stats.sitemap), "du sitemap") : "") +
      (stats.excluded ? pair(NUM.format(stats.excluded), stats.excluded === 1 ? "lien exclu" : "liens exclus") : "");
    if (halting) $("rd-tag").textContent = "arrêt en cours";
    document.title = `${NUM.format(stats.done)} URLs · exploration — crowler`;
  }

  const all = [...rows.values()];
  const bad = all.filter(broken);
  const lost = all.filter((r) => r.or);
  $("n-broken").textContent = NUM.format(bad.length);
  $("n-all").textContent = NUM.format(all.length);
  $("n-orphans").textContent = NUM.format(lost.length);
  if (!id && !starting) { $("panel").innerHTML = notice || IDLE; return; }
  // Pendant le crawl, l'entrée d'historique correspondante suit le compteur.
  if (stats && stats.live) {
    const sum = $("side-list").querySelector(`[data-id="${id}"] .ses-sum`);
    if (sum) sum.textContent = `en cours · ${NUM.format(stats.done)} URLs`;
  }

  if (view === "synth") { $("panel").innerHTML = synthView(); return; }
  if (view === "orphans") { $("panel").innerHTML = orphanView(keep(lost), lost.length); return; }
  const list = keep(view === "broken" ? bad : all);
  $("panel").innerHTML = view === "broken" ? brokenView(list, bad.length) : tableView(list, all.length);
}

function keep(list) {
  const q = query.toLowerCase();
  return list.filter((r) => {
    if (filter && klass(r) !== filter) return false;
    if (q && !r.u.toLowerCase().includes(q) && !(r.f || []).some((f) => f.from.toLowerCase().includes(q))) return false;
    return true;
  });
}

function brokenView(list, total) {
  if (!list.length) {
    return total
      ? '<p class="note"><b>Aucun résultat</b>Ce filtre ne correspond à aucun lien cassé.</p>'
      : (stats && !stats.live
          ? '<p class="note"><b>Aucun lien cassé</b>Toutes les URLs atteintes ont répondu correctement.</p>'
          : '<p class="note">Exploration en cours…</p>');
  }
  list.sort((a, b) => b.n - a.n || a.s - b.s);
  return list.map((r) => {
    const k = klass(r);
    const refs = r.f || [];
    const head =
      `<span class="code k${k}">${esc(label(r))}</span>` +
      `<span class="grp-u">${esc(short(r.u))}` +
        (r.e && r.s ? `<em>${esc(r.e)}</em>` : r.e ? `<em>${esc(detail(r.e))}</em>` : "") +
      `</span>` +
      `<span class="grp-n">${r.n ? NUM.format(r.n) + (r.n > 1 ? " liens entrants" : " lien entrant") : "point de départ"}</span>`;
    if (!refs.length) return `<div class="grp"><div class="grp-h">${head}</div></div>`;
    const body = `<ul class="refs">` + refs.map((f) =>
        `<li>${linkable(f.from) ? `<a href="${esc(f.from)}" target="_blank" rel="noopener noreferrer nofollow">${esc(short(f.from))}</a>` : esc(f.from)}` +
        (f.text ? ` <q>${esc(f.text)}</q>` : "") +
        (f.via ? ` <small title="URL liée par la page, qui redirige vers l’URL cassée">via ${esc(short(f.via))}</small>` : "") + `</li>`).join("") +
      (r.n > refs.length ? `<li class="rest">et ${NUM.format(r.n - refs.length)} autres pages (voir liens-casses.csv)</li>` : "") +
      `</ul>`;
    // Le panneau est redessiné à chaque lot : l'état replié vit dans `shut`, pas dans le DOM.
    return `<details class="grp" data-u="${esc(r.u)}"${shut.has(r.u) ? "" : " open"}>` +
      `<summary class="grp-h"><svg class="i chev" aria-hidden="true"><use href="#i-chev"/></svg>${head}</summary>${body}</details>`;
  }).join("");
}

// « toggle » ne remonte pas le DOM : on l'écoute en phase de capture.
$("panel").addEventListener("toggle", (e) => {
  const g = e.target;
  if (!g.matches("details.grp")) return;
  if (g.open) shut.delete(g.dataset.u);
  else shut.add(g.dataset.u);
}, true);

/** Les orphelines n'ont, par définition, aucun referer à montrer : la table
    des URLs suffit, la colonne « liens entrants » y vaut zéro partout. */
function orphanView(list, total) {
  if (list.length) return tableView(list, total);
  if (total) return '<p class="note"><b>Aucun résultat</b>Ce filtre ne correspond à aucune page orpheline.</p>';
  if (stats && stats.live) return '<p class="note">Exploration en cours…</p>';
  if (!stats || !stats.sitemap) {
    return '<p class="note"><b>Aucun sitemap lu</b>Cet audit n’a trouvé aucun sitemap, ou l’option « Lire le sitemap du site » était décochée.' +
      (smInfo && smInfo.errors.length ? "<br>" + esc(smInfo.errors[0]) : "") + "</p>";
  }
  return '<p class="note"><b>Aucune page orpheline</b>Les ' + NUM.format(stats.sitemap) +
    ' URLs du sitemap sont toutes atteignables par un lien du site.</p>';
}

const detail = (e) => ({
  robots: "bloqué par robots.txt", "private-host": "cible sur réseau privé, ignorée",
  "bad-url": "href malformé", timeout: "délai dépassé", aborted: "requête interrompue",
  "no-location": "redirection sans en-tête Location", "bad-location": "en-tête Location invalide",
}[e] || e);

const COLS = [
  ["s", "statut"], ["u", "url"], ["k", "type"], ["d", "prof."],
  ["t", "content-type"], ["m", "ms"], ["b", "taille"], ["n", "liens entrants"], ["sm", "sitemap"],
  ["r", "redirige vers"],
];

function tableView(list, total) {
  if (!list.length) {
    return total
      ? '<p class="note"><b>Aucun résultat</b>Ce filtre ne correspond à aucune URL.</p>'
      : '<p class="note">Exploration en cours…</p>';
  }
  list.sort((a, b) => {
    const x = a[sortKey] ?? "", y = b[sortKey] ?? "";
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir;
  });
  const shown = list.slice(0, MAX_TABLE_ROWS);
  const head = COLS.map(([k, l]) =>
    `<th${k === sortKey ? ` aria-sort="${sortDir > 0 ? "ascending" : "descending"}"` : ""}>` +
    `<button class="th-b" type="button" data-k="${k}" onclick="sortBy('${k}')">${l}</button></th>`).join("");
  const body = shown.map((r) => {
    const k = klass(r);
    return `<tr>` +
      `<td><span class="pill k${k}">${esc(label(r))}</span></td>` +
      `<td class="u">${linkable(r.u) ? `<a href="${esc(r.u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(short(r.u))}</a>` : esc(r.u)}${r.e ? ` <span class="dim">${esc(detail(r.e))}</span>` : ""}</td>` +
      `<td class="kind">${esc(r.k)}</td>` +
      `<td class="n">${r.d}</td>` +
      `<td class="dim">${esc(r.t)}</td>` +
      `<td class="n">${r.m}</td>` +
      `<td class="n">${bytes(r.b)}</td>` +
      `<td class="n">${r.n ? NUM.format(r.n) : ""}</td>` +
      `<td class="dim">${r.or ? '<b class="orph">orpheline</b>' : r.sm ? "oui" : ""}</td>` +
      `<td class="u dim">${r.r ? esc(short(r.r)) : ""}</td>` +
    `</tr>`;
  }).join("");
  const rest = list.length - shown.length;
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    (rest > 0 ? `<p class="more">${NUM.format(rest)} URLs supplémentaires non affichées — affinez le filtre ou exportez le CSV.</p>` : "");
}

// Le tableau est redessiné : le focus revient sur l'en-tête qu'on vient d'activer.
window.sortBy = (k) => {
  sortDir = k === sortKey ? -sortDir : (k === "u" || k === "t" ? 1 : -1);
  sortKey = k;
  render();
  $("panel").querySelector(`.th-b[data-k="${k}"]`)?.focus();
};

/* ---- synthèse ----
   Une seule passe sur les lignes, à la demande : l'onglet n'est calculé que
   lorsqu'il est celui affiché, donc un crawl en cours ne paie rien pour lui.
   Les barres sont des div dimensionnées en pourcentage — pas de librairie de
   graphiques, et rien à dessiner qui dépende du nombre d'URLs. */
const MS_EDGES = [100, 300, 600, 1000, 3000];
const MS_LABELS = ["<100", "<300", "<600", "<1 s", "<3 s", "≥3 s"];
const MS_TIPS = ["moins de 100 ms", "de 100 à 300 ms", "de 300 à 600 ms",
                 "de 600 ms à 1 s", "de 1 à 3 s", "3 s et plus"];
const MS_HUE = ["2", "2", "3", "3", "4", "4"];   // vert = rapide, rouge = lent
const KINDS = [["page", "pages"], ["asset", "assets"], ["external", "externes"]];
const DEPTH_COLS = 9;   // au-delà, la queue est regroupée en « 9+ »
const TOP = 8;
const COMPACT = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });

function synth() {
  const zero = () => ({ "2": 0, "3": 0, "4": 0, "5": 0, x: 0, n: 0 });
  const kinds = { page: zero(), asset: zero(), external: zero() };
  const depths = [];
  const ms = new Array(MS_LABELS.length).fill(0);
  const lat = [];
  const hosts = new Map();
  const pages = new Map();
  let settled = 0, weight = 0, capped = false;
  let sm = 0, orphans = 0, unlisted = 0;

  for (const r of rows.values()) {
    // Le décompte sitemap porte sur toutes les lignes : une URL déclarée puis
    // bloquée par robots.txt reste une URL du sitemap.
    if (r.sm) sm++;
    if (r.or) orphans++;
    else if (r.k === "page" && !r.sm) unlisted++;
    if (!r.s && !r.e) continue;   // encore en file : rien à résumer
    settled++;
    const bad = broken(r);
    const kind = kinds[r.k] || (kinds[r.k] = zero());
    kind[klass(r)]++; kind.n++;

    const d = depths[r.d] || (depths[r.d] = { n: 0, bad: 0 });
    d.n++; if (bad) d.bad++;

    weight += r.b || 0;
    if (r.s > 0) {
      lat.push(r.m);
      let i = 0;
      while (i < MS_EDGES.length && r.m >= MS_EDGES[i]) i++;
      ms[i]++;
    }
    if (r.k === "external") {
      let e = hosts.get(hostOf(r.u));
      if (!e) hosts.set(hostOf(r.u), (e = { n: 0, bad: 0 }));
      e.n++; if (bad) e.bad++;
    }
    if (bad && r.f) {
      for (const f of r.f) pages.set(f.from, (pages.get(f.from) || 0) + 1);
      if (r.n > r.f.length) capped = true;  // referers échantillonnés
    }
  }
  // Le tri n'a lieu qu'ici, une fois, sur un onglet ouvert à la main.
  lat.sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((lat.length * p) / 100))] : 0);
  return {
    settled, kinds, ms, weight, capped, answered: lat.length,
    sm, orphans, unlisted, declared: (stats && stats.sitemap) || 0,
    p50: pct(50), p90: pct(90), p99: pct(99),
    depths: depthCols(depths),
    hosts: [...hosts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].bad - a[1].bad).slice(0, TOP),
    pages: [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP),
  };
}

/** Colonnes de profondeur, la queue au-delà de DEPTH_COLS regroupée. */
function depthCols(depths) {
  const out = [];
  for (let i = 0; i < depths.length && i < DEPTH_COLS; i++) {
    const d = depths[i] || { n: 0, bad: 0 };
    out.push({ l: String(i), n: d.n, bad: d.bad });
  }
  if (depths.length > DEPTH_COLS) {
    const tail = { l: DEPTH_COLS + "+", n: 0, bad: 0 };
    for (let i = DEPTH_COLS; i < depths.length; i++) {
      const d = depths[i];
      if (d) { tail.n += d.n; tail.bad += d.bad; }
    }
    out.push(tail);
  }
  return out;
}

const card = (title, cap, body) =>
  `<section class="card"><h3>${title}</h3><p class="cap">${cap}</p>${body}</section>`;

/** Barre empilée par classe de status, aux couleurs de la barre principale. */
function kindBar(row) {
  const t = row.n || 1;
  return `<div class="krow-t">` + ["2", "3", "4", "5", "x"].map((k) => !row[k] ? "" :
    `<i style="width:${((row[k] / t) * 100).toFixed(2)}%;background:var(--s${k})"` +
    ` title="${NUM.format(row[k])} ${k === "x" ? "sans réponse" : k + "xx"}"></i>`).join("") + `</div>`;
}

/** Histogramme en colonnes ; `hue` colore le fût, la part cassée coiffe en rouge. */
function cols(data, hue, tip) {
  const max = Math.max(1, ...data.map((d) => d.n));
  return `<div class="cols">` + data.map((d, i) =>
    `<div class="col" title="${esc(tip(d, i))}">` +
      `<span class="col-n">${d.n ? COMPACT.format(d.n) : ""}</span>` +
      `<div class="col-t"><span style="height:${(d.n ? Math.max(2, (d.n / max) * 100) : 0.7).toFixed(1)}%;background:${hue(i)}">` +
        (d.bad ? `<i style="height:${((d.bad / d.n) * 100).toFixed(1)}%"></i>` : "") +
      `</span></div>` +
      `<span class="col-l">${esc(d.l)}</span>` +
    `</div>`).join("") + `</div>`;
}

/** Classement horizontal : libellé, barre à l'échelle du premier, compte. */
function topList(items) {
  const max = Math.max(1, ...items.map((x) => x.n));
  return `<ol class="tops">` + items.map((x) => {
    const ok = ((x.n - x.bad) / max) * 100, bad = (x.bad / max) * 100;
    return `<li title="${esc(x.tip)}">` +
      `<span class="tl">${x.u && linkable(x.u)
        ? `<a href="${esc(x.u)}" target="_blank" rel="noopener noreferrer nofollow">${esc(x.l)}</a>`
        : esc(x.l)}</span>` +
      `<span class="tt">${ok > 0 ? `<i style="width:${ok.toFixed(2)}%"></i>` : ""}` +
        `${bad > 0 ? `<i class="b" style="width:${bad.toFixed(2)}%"></i>` : ""}</span>` +
      `<b${x.bad === x.n ? ` style="color:var(--s4)"` : ""}>${NUM.format(x.n)}</b></li>`;
  }).join("") + `</ol>`;
}

function synthView() {
  if (stats && stats.live) {
    return '<p class="note"><b>Synthèse à la fin de l’audit</b>Les graphiques portent sur l’audit complet : ils sont dressés une fois le crawl terminé.</p>';
  }
  const s = synth();
  if (!s.settled) {
    return '<p class="note"><b>Rien à résumer</b>Cet audit n’a enregistré aucune URL.</p>';
  }
  const urls = (n) => `${NUM.format(n)} URL${n === 1 ? "" : "s"}`;
  const many = (n, one, more) => `${NUM.format(n)} ${n === 1 ? one : more}`;
  const out = [];

  out.push(card("Statuts par rôle",
    "<b>pages</b> et <b>assets</b> sont sur le domaine audité, <b>externes</b> couvre tout le hors-domaine.",
    KINDS.filter(([k]) => s.kinds[k].n).map(([k, l]) =>
      `<div class="krow"><span class="krow-l">${l}</span>${kindBar(s.kinds[k])}` +
      `<span class="krow-n">${NUM.format(s.kinds[k].n)}</span></div>`).join("")));

  out.push(card("URLs par profondeur",
    "Distance en clics depuis l’URL de départ. La coiffe rouge d’une colonne est cassée.",
    cols(s.depths, () => "var(--accent)",
      (d) => `profondeur ${d.l} — ${urls(d.n)}${d.bad ? `, dont ${many(d.bad, "cassée", "cassées")}` : ""}`)));

  if (s.declared || s.sm) {
    out.push(card("Sitemap",
      "Ce que le sitemap déclare, face à ce que le crawl atteint en suivant les liens." +
      (smInfo && smInfo.sources.length
        ? ` ${many(smInfo.sources.length, "fichier lu", "fichiers lus")}.` : "") +
      (smInfo && smInfo.errors.length
        ? ` <b style="color:var(--s4)">${esc(smInfo.errors[0])}</b>` : ""),
      topList([
        { l: "déclarées", u: "", n: s.declared, bad: 0,
          tip: `${urls(s.declared)} listées par le sitemap, doublons écartés` },
        { l: "aussi liées", u: "", n: s.sm - s.orphans, bad: 0,
          tip: `${urls(s.sm - s.orphans)} du sitemap qu’un lien du site atteint également` },
        { l: "orphelines", u: "", n: s.orphans, bad: s.orphans,
          tip: `${urls(s.orphans)} du sitemap qu’aucun lien du site n’atteint` },
        { l: "liées, hors sitemap", u: "", n: s.unlisted, bad: 0,
          tip: `${urls(s.unlisted)} du domaine trouvées en suivant les liens, absentes du sitemap` },
      ])));
  }

  if (s.answered) {
    out.push(card("Temps de réponse",
      `${NUM.format(s.answered)} réponses reçues, <b>${bytes(s.weight) || "0 o"}</b> transférés.`,
      cols(s.ms.map((n, i) => ({ l: MS_LABELS[i], n, bad: 0 })), (i) => `var(--s${MS_HUE[i]})`,
        (d, i) => `${MS_TIPS[i]} — ${urls(d.n)}`) +
      `<p class="pcts"><span>p50<b>${dur(s.p50)}</b></span>` +
      `<span>p90<b>${dur(s.p90)}</b></span><span>p99<b>${dur(s.p99)}</b></span></p>`));
  }

  if (s.hosts.length) {
    out.push(card("Domaines externes",
      "Liens testés hors du domaine ; en rouge, ceux qui ont échoué.",
      topList(s.hosts.map(([h, v]) => ({
        l: h, u: "", n: v.n, bad: v.bad,
        tip: `${h} — ${many(v.n, "lien testé", "liens testés")}` +
             `${v.bad ? `, ${many(v.bad, "cassé", "cassés")}` : ""}`,
      })))));
  }

  if (s.pages.length) {
    out.push(card("Pages à corriger",
      "Occurrences de liens cassés, par page qui les contient." +
      (s.capped ? " Les referers sont échantillonnés à 20 par lien cassé : l’export CSV donne le compte exact." : ""),
      topList(s.pages.map(([u, n]) => ({
        l: short(u), u, n, bad: n,
        tip: `${short(u)} — ${many(n, "lien cassé", "liens cassés")}`,
      })))));
  }

  return `<div class="synth">${out.join("")}</div>`;
}

/* ---- fin de crawl ----
   `now` distingue un audit qui vient de se terminer sous les yeux de
   l'utilisateur d'un audit relu depuis l'historique : pas de notification, et
   pas de rechargement de la liste, pour le second. */
function finish(m, now = true) {
  const bad = [...rows.values()].filter(broken).length;
  const lost = [...rows.values()].filter((r) => r.or).length;
  if (!m.stats) {
    $("readout").dataset.state = "done";
    $("rd-tag").textContent = m.reason || "interrompu";
    $("rd-done").textContent = "0";
    $("rd-unit").textContent = "URL enregistrée";
    $("rd-rest").innerHTML = "";
    $("panel").innerHTML = '<p class="note"><b>Audit interrompu</b>Le serveur s’est arrêté pendant ce crawl : aucun résultat n’a été enregistré.</p>';
    return;
  }
  const secs = dur(m.stats.elapsed);
  $("readout").dataset.state = "done";
  $("rd-tag").textContent = m.reason;
  $("rd-done").textContent = NUM.format(m.stats.done);
  $("rd-unit").textContent = "URLs explorées";
  $("rd-rest").innerHTML =
    pair(NUM.format(bad), bad === 1 ? "lien cassé" : "liens cassés") +
    (lost ? pair(NUM.format(lost), lost === 1 ? "orpheline" : "orphelines") : "") +
    (m.stats.excluded ? pair(NUM.format(m.stats.excluded), m.stats.excluded === 1 ? "lien exclu" : "liens exclus") : "") +
    pair(secs, "");
  document.title = bad ? `${NUM.format(bad)} liens cassés — crowler` : TITLE;

  const msg = bad
    ? `${NUM.format(m.stats.done)} URLs explorées, ${NUM.format(bad)} ${bad === 1 ? "lien cassé" : "liens cassés"} en ${secs}.`
    : `${NUM.format(m.stats.done)} URLs explorées, aucun lien cassé, en ${secs}.`;
  $("sr").textContent = "Audit terminé. " + msg;
  if (!now) return;
  crumb(shown = { ...shown, reason: m.reason, stats: m.stats, broken: bad });
  notifyDone(msg);
  loadSessions();
}

/* L'API Notification exige un contexte sécurisé (localhost compte) et un geste
   de l'utilisateur pour la demande d'autorisation : d'où la demande au lancement. */
function askNotify() {
  if ($("notify").checked && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().then(notifyHint);
  } else notifyHint();
}

function notifyHint() {
  const box = $("notify"), hint = $("notify-hint");
  if (!("Notification" in window)) {
    box.checked = false; box.disabled = true;
    hint.textContent = "— indisponible sans HTTPS";
  } else if (Notification.permission === "denied") {
    box.checked = false;
    hint.textContent = "— refusé par le navigateur";
  } else {
    hint.textContent = "";
  }
}

function notifyDone(msg) {
  if (!$("notify").checked || !("Notification" in window) || Notification.permission !== "granted") return;
  const n = new Notification(`Audit terminé — ${hostOf(target)}`, { body: msg, tag: "crowler-" + id });
  n.onclick = () => { window.focus(); n.close(); };
}

/* ---- commandes ---- */
$("legend").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const k = chip.dataset.k;
  filter = filter === k ? null : k;
  for (const c of $("legend").querySelectorAll(".chip")) c.setAttribute("aria-pressed", String(c.dataset.k === filter));
  render();
});

/** Change de vue. Les onglets suivent le motif ARIA : un seul arrêt de Tab,
    les flèches pour passer de l'un à l'autre. */
function tab(v, focus = false) {
  view = v;
  for (const [t, w] of TABS) {
    $(t).setAttribute("aria-selected", String(w === v));
    $(t).tabIndex = w === v ? 0 : -1;
    if (focus && w === v) $(t).focus();
  }
  $("search").hidden = v === "synth";   // le filtre ne porte pas sur la synthèse
  render();
}
for (const [t, v] of TABS) $(t).addEventListener("click", () => tab(v));
$("tabs").addEventListener("keydown", (e) => {
  const i = TABS.findIndex(([t]) => t === e.target.id);
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
  if (i < 0 || j === undefined) return;
  e.preventDefault();
  tab(TABS[(j + TABS.length) % TABS.length][1], true);
});

let qt;
$("q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { query = e.target.value.trim(); render(); }, 140); });
$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("form").requestSubmit(); }
});

/* ---- clavier ----
   Les raccourcis à une touche ne valent que hors saisie : un « n » tapé dans un
   champ doit rester un « n ». Les chiffres se lisent sur la touche physique
   (e.code) : sur un clavier AZERTY, « 1 » est la touche « & ». */
const typing = (el) => el instanceof Element &&
  el.matches("input:not([type=checkbox]):not([type=button]), textarea, select, [contenteditable]");

document.addEventListener("keydown", (e) => {
  if ($("ask").open || e.defaultPrevented || e.altKey) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Enter" && mod) {
    e.preventDefault();
    $("form").requestSubmit();
    return;
  }
  if (typing(e.target)) return;
  if (e.key === "Escape" && picked.size) return clearPicks();
  if (e.key === "Delete" || e.key === "Backspace") {
    const o = e.target.closest?.(".ses");
    if (!picked.size && !o) return;
    e.preventDefault();
    return picked.size ? dropMany() : drop(o.dataset.id);
  }
  if (mod) return;
  if (e.key === "/") {
    if ($("rail").hidden || $("search").hidden) return;
    e.preventDefault();
    $("q").focus();
    $("q").select();
  } else if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    blank();
  } else if (e.key === "?") {
    e.preventDefault();
    $("keys").open = !$("keys").open;
  } else if (/^Digit[1-4]$/.test(e.code) && !$("rail").hidden) {
    e.preventDefault();
    tab(TABS[Number(e.code.slice(5)) - 1][1]);
  }
});

/* ---- résumés des sections ----
   Repliée, une section en dit l'essentiel : ce qui s'écarte des défauts, les
   exclusions en vigueur, le preset chargé. Les défauts sont ceux du HTML
   (defaultValue, defaultChecked) : aucune valeur n'est recopiée ici. */
function hints() {
  const moved = [...BOOLS, ...NUMS].filter((k) => {
    const el = $(k);
    return el.type === "checkbox" ? el.checked !== el.defaultChecked : Number(el.value) !== Number(el.defaultValue);
  }).length;
  hint("h-cfg", moved ? `${moved} réglage${moved > 1 ? "s" : ""} modifié${moved > 1 ? "s" : ""}` : "par défaut", moved > 0);
  const n = $("exclude").value.split("\n").filter((t) => t.trim()).length;
  const sm = $("sitemapUrl").value.trim() ? " · sitemap imposé" : $("useSitemap").checked ? "" : " · sitemap ignoré";
  hint("h-scope", (n ? `${n} motif${n > 1 ? "s" : ""} d’exclusion` : "aucune exclusion") + sm, n > 0 || !!sm);
  const p = selected();
  const saved = presetList.length;
  hint("h-presets", p ? `« ${p.name} » chargé` : saved ? `${saved} enregistré${saved > 1 ? "s" : ""}` : "aucun", !!p);
  hint("h-hook", p ? `« ${p.name} »${p.chat ? " · Google Chat" : ""}` : "aucun preset chargé", !!(p && p.chat));
}

function hint(el, text, on) {
  $(el).textContent = text;
  $(el).toggleAttribute("data-on", on);
}
$("cfgs").addEventListener("input", () => hints());
$("cfgs").addEventListener("change", () => hints());

/* ---- préférences ----
   Deux préférences de ce navigateur, rien de plus : les sections ouvertes et
   le thème. Le stockage peut être refusé (navigation privée) : les défauts
   valent alors, sans erreur. */
const pref = {
  get(k) { try { return localStorage.getItem("crowler." + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("crowler." + k, v); } catch { /* préférence perdue, sans conséquence */ } },
};

let opened = [];
try { opened = JSON.parse(pref.get("open") || "[]"); } catch { /* valeur illisible : tout replié */ }
for (const s of SECS) {
  $(s).open = Array.isArray(opened) && opened.includes(s);
  $(s).addEventListener("toggle", () => pref.set("open", JSON.stringify(SECS.filter((x) => $(x).open))));
}

const THEMES = [["", "automatique", "i-auto"], ["light", "clair", "i-sun"], ["dark", "sombre", "i-moon"]];
function theme(v) {
  const [k, name, icon] = THEMES.find(([t]) => t === v) || THEMES[0];
  if (k) document.documentElement.dataset.theme = k;
  else delete document.documentElement.dataset.theme;
  $("theme").querySelector("use").setAttribute("href", "#" + icon);
  $("theme").title = `Thème : ${name}`;
  $("theme").setAttribute("aria-label", `Thème : ${name}, cliquer pour changer`);
  return k;
}
let themed = theme(pref.get("theme") || "");
$("theme").addEventListener("click", () => {
  const i = THEMES.findIndex(([t]) => t === themed);
  themed = theme(THEMES[(i + 1) % THEMES.length][0]);
  pref.set("theme", themed);
});

for (const k of document.querySelectorAll("kbd.mod")) k.textContent = MOD;
notifyHint();
hints();

/* ---- démarrage ----
   Au chargement on reprend l'audit en cours s'il y en a un, sinon le dernier
   enregistré : un rafraîchissement de page ne perd plus rien. */
(async () => {
  loadPresets();
  await loadSessions();
  const pick = sessions.find(live) || sessions[0];
  if (pick) await show(pick.id);
  else $("url").focus();
})();
