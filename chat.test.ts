import { expect, test } from "bun:test";
import * as chat from "./chat";

const card = (m: ReturnType<typeof chat.doneCard>) => m.cardsV2[0]!.card;
const done = (over: Partial<Parameters<typeof chat.doneCard>[0]> = {}) =>
  chat.doneCard({
    host: "exemple.fr",
    preset: "prod",
    id: "ab12",
    reason: "terminé",
    done: 312,
    broken: 0,
    elapsed: 134_000,
    top: [],
    base: "https://crowler.exemple.fr",
    ...over,
  });

// ---- base publique ---------------------------------------------------------

test("la base des liens se tire de DOMAINS, jokers et schéma compris", () => {
  expect(chat.publicBase("exemple.fr")).toBe("https://exemple.fr");
  expect(chat.publicBase("exemple.fr, www.exemple.fr")).toBe("https://exemple.fr");
  expect(chat.publicBase("https://exemple.fr")).toBe("https://exemple.fr");
  expect(chat.publicBase("https://exemple.fr/chemin")).toBe("https://exemple.fr");
  // Un joker Caddy ne fait pas une URL cliquable : on prend l'entrée suivante.
  expect(chat.publicBase("*.exemple.fr, exemple.fr")).toBe("https://exemple.fr");
  expect(chat.publicBase("*.exemple.fr")).toBe("");
  expect(chat.publicBase("")).toBe("");
  expect(chat.publicBase(undefined)).toBe("");
});

test("une durée se lit dans un fil de discussion", () => {
  expect(chat.dur(900)).toBe("900 ms");
  expect(chat.dur(12_300)).toBe("12 s");
  expect(chat.dur(74_000)).toBe("1 min 14 s");
  expect(chat.dur(120_000)).toBe("2 min");
  expect(chat.dur(3_600_000)).toBe("1 h");
  expect(chat.dur(5_412_000)).toBe("1 h 30 min");
});

// ---- cartes ----------------------------------------------------------------

test("la carte de lancement porte le site, le preset et la date, rien d'autre", () => {
  const c = chat.startCard({ host: "exemple.fr", preset: "prod", at: Date.UTC(2026, 8, 9, 12, 32) }).cardsV2[0]!.card;
  expect(c.header).toEqual({ title: "Audit lancé", subtitle: "exemple.fr" });
  expect(c.sections).toHaveLength(1);
  const labels = c.sections[0]!.widgets.map((w) => (w.decoratedText as { topLabel: string }).topLabel);
  expect(labels).toEqual(["Preset", "Démarré"]);
  expect(JSON.stringify(c)).not.toContain("openLink");
});

test("sans lien cassé, la carte de fin le dit et n'offre que l'export complet", () => {
  const c = card(done());
  expect(c.header.title).toBe("Audit terminé — aucun lien cassé");
  expect(c.sections).toHaveLength(2); // les chiffres, puis les boutons
  const buttons = c.sections[1]!.widgets[0]!.buttonList as { buttons: { text: string }[] };
  expect(buttons.buttons.map((b) => b.text)).toEqual(["Export complet (CSV)"]);
});

test("la carte de fin résume les liens cassés et pointe les deux exports", () => {
  const c = card(
    done({
      broken: 2,
      top: [
        { url: "https://exemple.fr/a-propos", status: 404 },
        { url: "https://partenaire.fr/lien", status: 0, error: "timeout" },
      ],
    }),
  );
  expect(c.header.title).toBe("Audit terminé — 2 liens cassés");
  expect(c.sections).toHaveLength(3);
  expect(c.sections[0]!.widgets.map((w) => (w.decoratedText as { text: string }).text)).toEqual([
    "prod",
    "312 en 2 min 14 s",
  ]);

  const list = c.sections[1]!;
  expect(list.header).toBe("Liens possiblement cassés");
  const text = (list.widgets[0]!.textParagraph as { text: string }).text;
  // Sans statut, seule la raison de l'échec renseigne.
  expect(text).toBe("<b>404</b> — https://exemple.fr/a-propos<br><b>timeout</b> — https://partenaire.fr/lien");

  const buttons = c.sections[2]!.widgets[0]!.buttonList as { buttons: { onClick: { openLink: { url: string } } }[] };
  expect(buttons.buttons.map((b) => b.onClick.openLink.url)).toEqual([
    "https://crowler.exemple.fr/api/crawl/ab12/broken.csv",
    "https://crowler.exemple.fr/api/crawl/ab12/pages.csv",
  ]);
});

test("la liste des cassés est plafonnée, le reste est compté", () => {
  const top = Array.from({ length: 9 }, (_, i) => ({ url: `https://exemple.fr/p${i}`, status: 404 }));
  const c = card(done({ broken: 41, top: top.slice(0, chat.MAX_BROKEN_SHOWN) }));
  const text = (c.sections[1]!.widgets[0]!.textParagraph as { text: string }).text;
  expect(text.split("<br>")).toHaveLength(chat.MAX_BROKEN_SHOWN + 1);
  expect(text).toEndWith("… et 36 autres");

  const un = card(done({ broken: 2, top: [{ url: "https://exemple.fr/p", status: 404 }] }));
  expect((un.sections[1]!.widgets[0]!.textParagraph as { text: string }).text).toEndWith("… et 1 autre");
});

test("une URL venue du site audité est échappée et tronquée", () => {
  const hostile = "https://exemple.fr/?a=1&b=<script>alert(1)</script>" + "x".repeat(200);
  const c = card(done({ broken: 1, top: [{ url: hostile, status: 500 }] }));
  const text = (c.sections[1]!.widgets[0]!.textParagraph as { text: string }).text;
  expect(text).not.toContain("<script>");
  expect(text).toContain("&lt;script&gt;");
  expect(text).toContain("&amp;b=");
  expect(text).toEndWith("…");
  // Les seules balises restantes sont celles que la carte pose elle-même.
  expect(text.replace(/<\/?b>/g, "")).not.toContain("<");
});

test("sans DOMAINS la carte part quand même, sans boutons", () => {
  const c = card(done({ broken: 1, top: [{ url: "https://exemple.fr/p", status: 404 }], base: "" }));
  expect(c.sections).toHaveLength(2);
  expect(JSON.stringify(c)).not.toContain("openLink");
});

test("une fin inattendue est dite, une fin normale ne l'est pas", () => {
  const normale = card(done()).sections[0]!.widgets;
  expect(normale).toHaveLength(2);
  const arretee = card(done({ reason: "arrêté manuellement" })).sections[0]!.widgets;
  expect((arretee[2]!.decoratedText as { topLabel: string; text: string })).toEqual({
    topLabel: "Fin",
    text: "arrêté manuellement",
  });
});

// ---- envoi -----------------------------------------------------------------

test("send poste bien la carte en JSON", async () => {
  let type = "";
  let body: unknown = null;
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      type = req.headers.get("content-type") ?? "";
      body = await req.json();
      return new Response("ok");
    },
  });
  try {
    await chat.send(srv.url.href, { text: "coucou" });
  } finally {
    srv.stop(true);
  }
  expect(type).toContain("application/json");
  expect(body).toEqual({ text: "coucou" });
});

test("un espace fâché ou injoignable ne fait jamais lever", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
  try {
    await expect(chat.send(srv.url.href, { text: "x" })).resolves.toBeUndefined();
  } finally {
    srv.stop(true);
  }
  // Port fermé : la connexion est refusée tout de suite, sans attendre le délai.
  await expect(chat.send("http://127.0.0.1:1/", { text: "x" })).resolves.toBeUndefined();
});

test("une erreur réseau bavarde ne noie pas la ligne", () => {
  const c = card(
    done({
      broken: 1,
      base: "",
      top: [{ url: "https://absent.fr/", status: 0, error: "getaddrinfo ENOTFOUND " + "a".repeat(120) }],
    }),
  );
  const text = (c.sections[1]!.widgets[0]!.textParagraph as { text: string }).text;
  // 39 caractères retenus sur 40, le dernier étant l'ellipse.
  expect(text).toBe(`<b>getaddrinfo ENOTFOUND ${"a".repeat(17)}…</b> — https://absent.fr/`);
});
