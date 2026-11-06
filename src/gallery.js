// Génère depuis le site (administrateur) toutes les images manquantes :
// galerie « Inspirations / Explorer » et images des cartes d'outils. FLUX schnell, < 0,01 $ par image.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TOOLS } from "./config.js";
import { EXEMPLES } from "../public/exemples.js";
import { CARD_IDS } from "./settings.js";

const VIDEO_TO_IMG = { "9:16": "portrait_16_9", "16:9": "landscape_16_9", "1:1": "square_hd" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createGalleryGenerator({ cfg, getProvider, settings, pollMs = 2000 }) {
  const outDir = cfg.galleryDir || path.join(cfg.root, "public", "galerie");
  const manifestPath = path.join(outDir, "manifest.json");
  let state = { running: false, done: 0, total: 0, errors: [], current: null, finishedAt: null };

  const readManifest = () => { try { return JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch { return {}; } };

  function pending() {
    const manifest = readManifest();
    const s = settings.get();
    const gallery = EXEMPLES.filter((e) => !manifest[e.id] || !fs.existsSync(path.join(outDir, path.basename(manifest[e.id]))));
    const cards = CARD_IDS.filter((id) => !s.images[id]);
    return { gallery, cards };
  }

  async function makeImage(prompt, image_size, dest) {
    const provider = getProvider();
    const tool = TOOLS.image;
    const task = await provider.submit(tool.model, tool.buildInput({ params: { prompt, image_size } }));
    const deadline = Date.now() + 5 * 60 * 1000;
    for (;;) {
      await sleep(pollMs);
      const st = await provider.status(task);
      if (st.status === "COMPLETED") { if (st.error) throw new Error(st.error); break; }
      if (Date.now() > deadline) throw new Error("Délai dépassé.");
    }
    const res = await provider.result(task);
    await provider.download(res.imageUrl, dest);
  }

  async function runAll(list) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const item of list) {
      state.current = item.label;
      try {
        if (item.kind === "gallery") {
          await makeImage(item.prompt, item.size, path.join(outDir, `${item.id}.jpg`));
          const m = readManifest();
          m[item.id] = `galerie/${item.id}.jpg`;
          await fsp.writeFile(manifestPath, JSON.stringify(m, null, 2));
        } else {
          const tmp = path.join(cfg.dataDir, `carte-${crypto.randomBytes(4).toString("hex")}.jpg`);
          try { await makeImage(item.prompt, "portrait_4_3", tmp); await settings.setImage(item.id, await fsp.readFile(tmp)); }
          finally { await fsp.rm(tmp, { force: true }); }
        }
      } catch (e) {
        // Solde épuisé ou clé refusée : inutile d'essayer les images suivantes.
        if (/Solde fal\.ai épuisé|HTTP 40[13]/.test(e.message)) { state.errors = [e.message]; break; }
        state.errors.push(`${item.label} : ${e.message}`);
      }
      state.done++;
    }
    state.running = false; state.current = null; state.finishedAt = Date.now();
  }

  function start() {
    if (state.running) return status();
    const { gallery, cards } = pending();
    const s = settings.get();
    const list = [
      ...cards.map((id) => ({ kind: "card", id, label: `Carte « ${s.cards[id].title} »`, prompt: s.cards[id].prompt })),
      ...gallery.map((e) => ({ kind: "gallery", id: e.id, label: e.titre, prompt: e.prompt, size: e.type === "video" ? VIDEO_TO_IMG[e.format] : e.format })),
    ];
    state = { running: list.length > 0, done: 0, total: list.length, errors: [], current: null, finishedAt: list.length ? null : Date.now() };
    if (list.length) runAll(list).catch((e) => { state.running = false; state.errors.push(e.message); });
    return status();
  }

  function status() {
    const { gallery, cards } = pending();
    // Estimation : ~0,8 mégapixel par image à 0,003 $/MP.
    const missing = gallery.length + cards.length;
    return { ...state, missing, missingGallery: gallery.length, missingCards: cards.length, estimateUsd: Math.round(missing * 0.003 * 100) / 100 };
  }

  return { start, status };
}
