// Génère les images de la galerie « Explorer » avec FLUX schnell (fal.ai).
// Usage : npm run galerie      (nécessite FAL_KEY dans .env)
// Coût : 0,003 $ par mégapixel, soit environ 0,05 $ pour toute la galerie.
// Les exemples de type « vidéo » reçoivent une image d'aperçu (pas une vidéo).
import fs from "node:fs";
import path from "node:path";
import { loadConfig, TOOLS } from "../src/config.js";
import { createFalProvider } from "../src/providers/fal.js";
import { EXEMPLES } from "../public/exemples.js";

const cfg = loadConfig();
if (!cfg.falKey) {
  console.error("FAL_KEY manquante : renseignez-la dans .env.");
  process.exit(1);
}
const outDir = cfg.galleryDir;
fs.mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, "manifest.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
const provider = createFalProvider({ key: cfg.falKey, fileTtlSeconds: 600 });
const VIDEO_TO_IMG = { "9:16": "portrait_16_9", "16:9": "landscape_16_9", "1:1": "square_hd" };
const tool = TOOLS.image;

for (const ex of EXEMPLES) {
  if (manifest[ex.id]) { console.log(`✓ ${ex.titre} (déjà générée)`); continue; }
  const image_size = ex.type === "video" ? VIDEO_TO_IMG[ex.format] : ex.format;
  try {
    const task = await provider.submit(tool.model, tool.buildInput({ params: { prompt: ex.prompt, image_size } }));
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = await provider.status(task);
      if (st.status === "COMPLETED") { if (st.error) throw new Error(st.error); break; }
    }
    const res = await provider.result(task);
    await provider.download(res.imageUrl, path.join(outDir, `${ex.id}.jpg`));
    manifest[ex.id] = `galerie/${ex.id}.jpg`;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`✓ ${ex.titre}`);
  } catch (e) {
    console.error(`✗ ${ex.titre} : ${e.message}`);
  }
}
console.log("Galerie terminée. Rechargez la page Explorer.");
