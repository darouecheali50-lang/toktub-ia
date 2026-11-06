// Réglages modifiables par l'administrateur depuis le site (nom, textes, images des cartes, prix du crédit).
// Stockés dans data/settings.json ; les images dans data/branding/.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const CARD_IDS = ["mix", "move", "video", "image", "memes"];

export const DEFAULT_SETTINGS = {
  appName: "Danse Studio",
  tagline: "Que souhaitez-vous créer aujourd'hui ?",
  creditUsd: null, // null = valeur par défaut du serveur
  cards: {
    mix: { tag: "Personnage", title: "Mix", desc: "Remplacez la personne d'une vidéo par votre photo",
      prompt: "Photo réaliste verticale : une danseuse en tenue colorée au milieu d'une rue, à côté de sa silhouette lumineuse qui se transforme en un autre personnage, effet de remplacement, éclairage néon vert, style publicité" },
    move: { tag: "Danse", title: "Move", desc: "Faites danser n'importe quelle photo",
      prompt: "Photo réaliste verticale : une personne en pleine danse hip-hop, mouvement dynamique, traînées de mouvement, fond de studio sombre avec lumières violettes, style affiche" },
    video: { tag: "IA", title: "Générer une vidéo", desc: "Écrivez une idée, l'IA la filme",
      prompt: "Photo réaliste : une caméra de cinéma devant un paysage de coucher de soleil, pellicule lumineuse, ambiance tournage de film, couleurs orange chaud" },
    image: { tag: "IA", title: "Générer une image", desc: "Une photo réaliste en quelques secondes",
      prompt: "Photo réaliste : un portrait artistique coloré d'une jeune femme entourée de fleurs, lumière douce bleue et rose, très détaillé" },
    memes: { tag: "Gratuit", title: "Mèmes", desc: "Ajoutez du texte sur votre image",
      prompt: "Photo réaliste drôle : un chat surpris avec de grands yeux assis sur un canapé jaune, expression comique, fond simple" },
  },
  images: {}, // id de carte -> nom de fichier dans data/branding
};

const IMAGE_SIG = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", test: (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP" },
];
export const sniffImage = (buf) => IMAGE_SIG.find((s) => buf.length > 12 && s.test(buf)) || null;
const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export function createSettings(cfg) {
  const file = path.join(cfg.dataDir, "settings.json");
  const dir = path.join(cfg.dataDir, "branding");
  fs.mkdirSync(dir, { recursive: true });
  const defaultCreditUsd = cfg.creditUsd;
  let data = structuredClone(DEFAULT_SETTINGS);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      data = { ...data, ...saved, cards: { ...data.cards }, images: { ...(saved.images || {}) } };
      for (const id of CARD_IDS) data.cards[id] = { ...DEFAULT_SETTINGS.cards[id], ...(saved.cards?.[id] || {}) };
    } catch { console.error("Réglages illisibles (data/settings.json) : valeurs par défaut utilisées."); }
  }
  const apply = () => { cfg.creditUsd = data.creditUsd > 0 ? data.creditUsd : defaultCreditUsd; };
  apply();

  let chain = Promise.resolve();
  const save = () => {
    const snap = JSON.stringify(data, null, 2);
    chain = chain.then(async () => { const tmp = `${file}.tmp`; await fsp.writeFile(tmp, snap); await fsp.rename(tmp, file); });
    return chain;
  };

  function publicView() {
    return {
      appName: data.appName, tagline: data.tagline,
      creditUsd: cfg.creditUsd, defaultCreditUsd,
      cards: Object.fromEntries(CARD_IDS.map((id) => [id, {
        ...data.cards[id], image: data.images[id] ? `/branding/${data.images[id]}` : null,
      }])),
    };
  }

  async function update(body) {
    if (body.appName != null) {
      const n = clean(body.appName, 40);
      if (!n) throw httpError("Le nom de l'application ne peut pas être vide.");
      data.appName = n;
    }
    if (body.tagline != null) data.tagline = clean(body.tagline, 120) || DEFAULT_SETTINGS.tagline;
    if (body.creditUsd !== undefined) {
      if (body.creditUsd === null || body.creditUsd === "") data.creditUsd = null;
      else {
        const v = Number(body.creditUsd);
        if (!(v >= 0.03 && v <= 1)) throw httpError("Valeur d'un crédit : entre 0,03 $ et 1 $.");
        data.creditUsd = Math.round(v * 1000) / 1000;
      }
    }
    if (body.cards && typeof body.cards === "object") {
      for (const id of CARD_IDS) {
        const c = body.cards[id];
        if (!c) continue;
        const cur = data.cards[id];
        if (c.tag != null) cur.tag = clean(c.tag, 20);
        if (c.title != null) cur.title = clean(c.title, 40) || DEFAULT_SETTINGS.cards[id].title;
        if (c.desc != null) cur.desc = clean(c.desc, 120);
        if (c.prompt != null) cur.prompt = clean(c.prompt, 600) || DEFAULT_SETTINGS.cards[id].prompt;
      }
    }
    apply();
    await save();
    return publicView();
  }

  async function setImage(id, buf) {
    if (!CARD_IDS.includes(id)) throw httpError("Carte inconnue.");
    const sig = sniffImage(buf);
    if (!sig) throw httpError("Image refusée : formats acceptés JPEG, PNG ou WebP.", 415);
    const name = `${id}-${crypto.randomBytes(6).toString("hex")}.${sig.ext}`;
    await fsp.writeFile(path.join(dir, name), buf);
    const old = data.images[id];
    data.images[id] = name;
    await save();
    if (old) await fsp.rm(path.join(dir, old), { force: true });
    return publicView();
  }

  async function removeImage(id) {
    if (!CARD_IDS.includes(id)) throw httpError("Carte inconnue.");
    const old = data.images[id];
    delete data.images[id];
    await save();
    if (old) await fsp.rm(path.join(dir, old), { force: true });
    return publicView();
  }

  // Fichier d'image de carte (nom généré par nous uniquement).
  function imageFile(name) {
    if (!/^[a-z]+-[a-f0-9]{12}\.(jpg|png|webp)$/.test(name) || !Object.values(data.images).includes(name)) return null;
    return { path: path.join(dir, name), mime: IMAGE_SIG.find((s) => name.endsWith("." + s.ext)).mime };
  }

  return { publicView, update, setImage, removeImage, imageFile, get: () => data, flush: () => chain };
}
