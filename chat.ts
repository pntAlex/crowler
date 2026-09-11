/**
 * Notification Google Chat : la carte postée dans l'espace d'un preset au
 * démarrage puis à la fin de son audit.
 *
 * À ne pas confondre avec le webhook *entrant* qui déclenche un preset (README,
 * section « Webhook ») : ici crowler est l'appelant, pas l'appelé.
 *
 * Le schéma `cardsV2` ne se devine pas, il se lit :
 *   https://developers.google.com/workspace/chat/api/reference/rest/v1/cards
 *   https://developers.google.com/workspace/chat/format-messages  (balisage des textes)
 *   https://addons.gsuite.google.com/uikit/builder                (prévisualisation)
 */

/** Au-delà, le message devient un rapport : c'est le rôle du CSV joint. */
export const MAX_BROKEN_SHOWN = 5;
/** Une URL de suivi fait parfois des kilo-octets ; la carte doit rester lisible. */
export const MAX_URL_SHOWN = 120;
/** Un statut tient en trois chiffres, mais `errMsg` laisse passer 140 caractères
    d'erreur réseau : en gras devant l'URL, ça noie la ligne. */
export const MAX_WHY_SHOWN = 40;
/** Un espace Chat lent ne doit pas retenir la fin d'un crawl. */
export const CHAT_TIMEOUT_MS = 5000;

/** Ce que la carte sait d'un lien cassé : un sous-ensemble de `Row`, pour que ce
    module n'ait rien à importer du crawler. */
export type Broken = { url: string; status: number; error?: string };

/*
 * Les champs texte d'une carte acceptent un sous-ensemble de HTML, et les URLs
 * affichées viennent du site audité : elles sont hostiles par défaut.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const clip = (s: string, max = MAX_URL_SHOWN) => (s.length <= max ? s : s.slice(0, max - 1) + "…");

/**
 * Plus bavard que le `dur()` de l'interface, qui s'en tient aux secondes : un
 * audit d'une heure et demie annoncé « 5412.7 s » ne se lit pas dans un fil.
 */
export function dur(ms: number): string {
  if (ms < 950) return `${Math.max(0, Math.round(ms))} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Heure locale du serveur : TZ est posée dans compose.yaml, sinon c'est UTC. */
const stamp = (at: number) => new Date(at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

/**
 * `DOMAINS` sert d'abord aux labels Caddy : elle peut lister plusieurs domaines,
 * et contenir des jokers. On en tire la première entrée utilisable comme base
 * des liens de téléchargement, et rien du tout si elle n'en offre aucune — une
 * carte sans boutons vaut mieux qu'un lien qui ne mène nulle part.
 */
export function publicBase(domains: string | undefined): string {
  for (const raw of String(domains ?? "").split(/[,\s]+/)) {
    const host = raw.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    if (!host || host.startsWith("*")) continue; // un joker ne fait pas une URL cliquable
    return "https://" + host;
  }
  return "";
}

type Widget = Record<string, unknown>;
type Section = { header?: string; widgets: Widget[] };

const deco = (topLabel: string, text: string): Widget => ({ decoratedText: { topLabel, text } });

const link = (text: string, url: string) => ({ text, onClick: { openLink: { url } } });

const card = (cardId: string, title: string, subtitle: string, sections: Section[]) => ({
  cardsV2: [{ cardId, card: { header: { title, subtitle }, sections } }],
});

/** Au lancement, rien n'est encore connu : le site, le preset, la date. */
export function startCard(o: { host: string; preset: string; at: number }) {
  return card("crowler-start", "Audit lancé", esc(o.host), [
    { widgets: [deco("Preset", esc(o.preset)), deco("Démarré", esc(stamp(o.at)))] },
  ]);
}

/** Le libellé d'un lien cassé : son statut, ou la raison de l'échec s'il n'a jamais répondu. */
const why = (b: Broken) => (b.status ? String(b.status) : clip(b.error || "erreur", MAX_WHY_SHOWN));

export function doneCard(o: {
  host: string;
  preset: string;
  id: string;
  reason: string;
  done: number;
  broken: number;
  elapsed: number;
  top: Broken[];
  base: string;
}) {
  const plural = o.broken === 1 ? "lien cassé" : "liens cassés";
  const sections: Section[] = [
    {
      widgets: [
        deco("Preset", esc(o.preset)),
        deco("URLs explorées", `${o.done} en ${dur(o.elapsed)}`),
        // La raison ne se dit que si elle surprend : « terminé » n'apprend rien,
        // « arrêté manuellement » ou « limite de pages atteinte » changent la lecture.
        ...(o.reason && o.reason !== "terminé" ? [deco("Fin", esc(o.reason))] : []),
      ],
    },
  ];

  if (o.top.length) {
    // Un seul paragraphe plutôt qu'un widget par ligne : même rendu en liste,
    // le quart du JSON.
    const lines = o.top.map((b) => `<b>${esc(why(b))}</b> — ${esc(clip(b.url))}`);
    const rest = o.broken - o.top.length;
    if (rest > 0) lines.push(`… et ${rest} ${rest === 1 ? "autre" : "autres"}`);
    sections.push({ header: "Liens possiblement cassés", widgets: [{ textParagraph: { text: lines.join("<br>") } }] });
  }

  if (o.base) {
    const buttons = [];
    // Exporter zéro lien cassé n'a pas d'intérêt : le bouton n'apparaît que s'il y a de quoi.
    if (o.broken) buttons.push(link("Liens cassés (CSV)", `${o.base}/api/crawl/${o.id}/broken.csv`));
    buttons.push(link("Export complet (CSV)", `${o.base}/api/crawl/${o.id}/pages.csv`));
    sections.push({ widgets: [{ buttonList: { buttons } }] });
  }

  const title = o.broken ? `Audit terminé — ${o.broken} ${plural}` : "Audit terminé — aucun lien cassé";
  return card("crowler-done-" + o.id, title, esc(o.host), sections);
}

/**
 * Un espace injoignable, lent ou fâché ne doit jamais faire échouer un audit :
 * cette fonction ne lève pas. L'URL n'est pas validée ici mais au bord
 * (`safeChatUrl` dans server.ts), là où « refuser » veut dire quelque chose.
 */
export async function send(url: string, message: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
    const body = await res.text(); // lu pour libérer la connexion, pas pour son contenu
    // L'URL porte ses secrets dans sa query string : elle ne va pas dans le journal.
    if (!res.ok) console.error("chat", res.status, body.slice(0, 200));
  } catch (e) {
    console.error("chat", (e as Error).message);
  }
}
