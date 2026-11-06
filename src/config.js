// Configuration côté serveur. Les secrets ne quittent jamais ce module
// (seules des informations non sensibles sont exposées via publicStatus()).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Charge .env s'il existe (Node >= 20.12). Les variables déjà définies
// dans l'environnement (hébergeur) ne sont pas écrasées.
// ENV_FILE permet de garder ce fichier sur un disque persistant chez l'hébergeur.
export const ENV_FILE = process.env.ENV_FILE ? path.resolve(ROOT, process.env.ENV_FILE) : path.join(ROOT, ".env");
const envFile = ENV_FILE;
if (fs.existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const num = (name, def, env = process.env) => {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// Découpe une durée en morceaux de 10 s (maximum du modèle) et 5 s : 15 → [10, 5], 30 → [10, 10, 10].
export function splitDuration(total) {
  const out = [];
  let left = total;
  while (left > 0) { const seg = left >= 10 ? 10 : 5; out.push(String(seg)); left -= seg; }
  return out;
}

// Tarifs Wan 2.2 Animate (Move et Replace), page officielle fal consultée le 05/11/2026 :
// facturation au nombre d'images, 16 images = 1 « seconde vidéo ».
const WAN_PRICE = { "480p": 0.04, "580p": 0.06, "720p": 0.08 };
// Mode « eco » : la vidéo envoyée à l'IA est ramenée à 16 images/s (si elle en a plus).
// Moins d'images à générer = moins cher et plus rapide ; la durée et la musique ne changent pas.
export const ECO_FPS = 16;
export const aiFps = (fps, fluidite) => (fluidite === "eco" && fps > ECO_FPS ? ECO_FPS : fps);
const wanEstimate = ({ durationSec, fps: srcFps, resolution, fluidite }) => {
  const price = WAN_PRICE[resolution];
  const fps = aiFps(srcFps, fluidite);
  if (!durationSec || !fps || price == null) return null;
  const billedSeconds = (durationSec * fps) / 16;
  return { usd: round(billedSeconds * price), detail: `${round(billedSeconds)} s vidéo facturées × ${price} $` };
};

// Taille (px) des formats FLUX schnell, pour l'estimation au mégapixel.
const FLUX_SIZES = {
  square_hd: [1024, 1024], square: [512, 512], portrait_4_3: [768, 1024],
  portrait_16_9: [576, 1024], landscape_4_3: [1024, 768], landscape_16_9: [1024, 576],
};

// Outils disponibles. Chaque modèle et paramètre provient de la documentation officielle fal.ai.
export const TOOLS = {
  move: {
    label: "Move — faire danser une photo",
    kind: "video",
    model: "fal-ai/wan/v2.2-14b/animate/move",
    needs: ["video", "image"],
    restoreAudio: true,
    options: { resolution: ["480p", "580p", "720p"], fluidite: ["eco", "origine"] },
    defaults: { resolution: "580p", fluidite: "eco" },
    pricingNote: "0,04 $ (480p), 0,06 $ (580p) ou 0,08 $ (720p) par « seconde vidéo » = 16 images.",
    estimate: ({ video, params }) => video && wanEstimate({ durationSec: video.durationSec, fps: video.fps, resolution: params.resolution, fluidite: params.fluidite }),
    buildInput: ({ videoUrl, imageUrl, params }) => ({
      video_url: videoUrl, image_url: imageUrl, resolution: params.resolution, enable_safety_checker: true,
    }),
  },
  mix: {
    label: "Mix — remplacer la personne d'une vidéo",
    kind: "video",
    model: "fal-ai/wan/v2.2-14b/animate/replace",
    needs: ["video", "image"],
    restoreAudio: true,
    options: { resolution: ["480p", "580p", "720p"], fluidite: ["eco", "origine"] },
    defaults: { resolution: "580p", fluidite: "eco" },
    pricingNote: "0,04 $ (480p), 0,06 $ (580p) ou 0,08 $ (720p) par « seconde vidéo » = 16 images.",
    estimate: ({ video, params }) => video && wanEstimate({ durationSec: video.durationSec, fps: video.fps, resolution: params.resolution, fluidite: params.fluidite }),
    buildInput: ({ videoUrl, imageUrl, params }) => ({
      video_url: videoUrl, image_url: imageUrl, resolution: params.resolution, enable_safety_checker: true,
    }),
  },
  video: {
    label: "Générer une vidéo à partir d'un texte",
    kind: "video",
    model: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    // Au-delà de 10 s (maximum du modèle), la vidéo est prolongée par morceaux :
    // chaque suite part de la dernière image du morceau précédent (image-to-video), puis tout est assemblé.
    continueModel: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    needs: [],
    prompt: true,
    options: { duration: ["5", "10", "15", "20", "30"], aspect_ratio: ["16:9", "9:16", "1:1"] },
    defaults: { duration: "5", aspect_ratio: "9:16" },
    pricingNote: "0,35 $ pour 5 s puis 0,07 $ par seconde (texte → vidéo). Au-delà de 10 s, les suites (image → vidéo) sont estimées au même tarif.",
    segments: (params) => splitDuration(Number(params.duration)),
    estimate: ({ params }) => {
      const d = Number(params.duration);
      return { usd: round(d * 0.07), detail: `${d} s de vidéo${d > 10 ? `, ${splitDuration(d).length} morceaux enchaînés` : ""}` };
    },
    buildInput: ({ params, segment }) => ({
      prompt: params.prompt, duration: segment, aspect_ratio: params.aspect_ratio, enable_safety_checker: true,
    }),
    buildContinueInput: ({ params, imageUrl, segment }) => ({ prompt: params.prompt, image_url: imageUrl, duration: segment }),
  },
  animer: {
    label: "Animer une image avec un texte",
    kind: "video",
    model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    continueModel: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    needs: ["image"],
    prompt: true,
    options: { duration: ["5", "10", "15", "20", "30"] },
    defaults: { duration: "5" },
    pricingNote: "Tarif image → vidéo non indiqué dans la documentation consultée : estimé à 0,07 $ par seconde comme le texte → vidéo. Vérifiez sur fal.",
    segments: (params) => splitDuration(Number(params.duration)),
    estimate: ({ params }) => {
      const d = Number(params.duration);
      return { usd: round(d * 0.07), detail: `${d} s de vidéo (estimation)` };
    },
    buildInput: ({ imageUrl, params, segment }) => ({ prompt: params.prompt, image_url: imageUrl, duration: segment }),
    buildContinueInput: ({ params, imageUrl, segment }) => ({ prompt: params.prompt, image_url: imageUrl, duration: segment }),
  },
  image: {
    label: "Générer une image à partir d'un texte",
    kind: "image",
    model: "fal-ai/flux/schnell",
    needs: [],
    prompt: true,
    options: { image_size: Object.keys(FLUX_SIZES) },
    defaults: { image_size: "portrait_4_3" },
    pricingNote: "0,003 $ par mégapixel (moins d'un centime par image).",
    estimate: ({ params }) => {
      const [w, h] = FLUX_SIZES[params.image_size] || [1024, 768];
      const mp = (w * h) / 1e6;
      return { usd: round(mp * 0.003, 4), detail: `${round(mp)} mégapixel` };
    },
    buildInput: ({ params }) => ({
      prompt: params.prompt, image_size: params.image_size, num_images: 1, output_format: "jpeg", enable_safety_checker: true,
    }),
  },
};

export function loadConfig(env = process.env) {
  return {
    root: ROOT,
    port: num("PORT", 3000, env),
    host: env.HOST || "0.0.0.0",
    falKey: env.FAL_KEY || "",
    adminEmails: String(env.ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    freeCredits: Number.isFinite(Number(env.FREE_CREDITS)) && env.FREE_CREDITS !== "" && env.FREE_CREDITS != null ? Number(env.FREE_CREDITS) : 3,
    // Render fournit RENDER_EXTERNAL_URL automatiquement : PUBLIC_URL devient facultatif.
    publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/$/, ""),
    // Valeur d'un crédit en coût fal : plus elle est haute, moins chaque création coûte de crédits.
    // Modifiable par l'administrateur dans « Personnaliser ».
    creditUsd: Number(env.CREDIT_USD) > 0 ? Number(env.CREDIT_USD) : 0.09,
    plans: {
      basique: { label: "Basique", month: 6, year: 60, credits: num("BASIC_CREDITS", 50, env) },
      pro: { label: "Pro", month: 9, year: 90, credits: num("PRO_CREDITS", 80, env) },
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || "",
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
      prices: {
        basique_month: env.STRIPE_PRICE_BASIQUE_MOIS || "", basique_year: env.STRIPE_PRICE_BASIQUE_AN || "",
        pro_month: env.STRIPE_PRICE_PRO_MOIS || "", pro_year: env.STRIPE_PRICE_PRO_AN || "",
      },
    },
    tools: TOOLS,
    dataDir: path.resolve(ROOT, env.DATA_DIR || "data"),
    galleryDir: env.GALLERY_DIR ? path.resolve(ROOT, env.GALLERY_DIR) : path.join(ROOT, "public", "galerie"),
    envFile: env.ENV_FILE ? ENV_FILE : null, // null = .env à la racine du projet
    maxVideoMB: num("MAX_VIDEO_MB", 100, env),
    maxImageMB: num("MAX_IMAGE_MB", 10, env),
    maxAudioMB: num("MAX_AUDIO_MB", 25, env),
    minVideoSeconds: 1,
    maxVideoSeconds: num("MAX_VIDEO_SECONDS", 30, env),
    maxPromptChars: 1500,
    maxConcurrentJobs: num("MAX_JOBS_PER_USER", 4, env),
    maxActiveJobsTotal: num("MAX_ACTIVE_JOBS_TOTAL", 20, env),
    dailyJobLimit: num("DAILY_JOBS_PER_USER", 30, env),
    maxJobMinutes: num("MAX_JOB_MINUTES_V2", 90, env),
    resultTtlMinutes: num("RESULT_TTL_HOURS", 72, env) * 60,
    pollIntervalMs: num("POLL_INTERVAL_MS", 5000, env),
    falFileTtlSeconds: num("FAL_FILE_TTL_SECONDS", 3600, env),
    trustProxy: env.TRUST_PROXY === "1",
  };
}

export function missingSettings(cfg) {
  const missing = [];
  if (!cfg.falKey) missing.push("FAL_KEY");
  return missing;
}

// Nombre de crédits d'une création : coût estimé ÷ valeur d'un crédit, arrondi au-dessus, minimum 1.
export function creditsFor(cfg, estimate) {
  if (!estimate) return 1;
  return Math.max(1, Math.ceil(estimate.usd / cfg.creditUsd - 1e-9));
}

// Vérifie et complète les paramètres d'un outil à partir des valeurs autorisées.
export function normalizeParams(tool, raw, cfg) {
  const params = {};
  for (const [k, allowed] of Object.entries(tool.options || {})) {
    const v = raw[k] == null ? "" : String(raw[k]);
    params[k] = allowed.includes(v) ? v : tool.defaults[k];
  }
  if (tool.prompt) {
    const p = String(raw.prompt || "").trim();
    if (!p) throw Object.assign(new Error("Écrivez une description (prompt) avant de générer."), { status: 400 });
    if (p.length > cfg.maxPromptChars) throw Object.assign(new Error(`Description trop longue (${cfg.maxPromptChars} caractères maximum).`), { status: 400 });
    params.prompt = p;
  }
  return params;
}
