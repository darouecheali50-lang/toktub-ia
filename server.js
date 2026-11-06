// Danse Studio — serveur HTTP (Node.js, sans framework).
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, missingSettings, creditsFor } from "./src/config.js";
import { createUploadStore, UploadError } from "./src/uploads.js";
import { createJobManager } from "./src/jobs.js";
import { createFalProvider } from "./src/providers/fal.js";
import { checkFfmpeg } from "./src/media.js";
import { openDb } from "./src/db.js";
import { createAccounts } from "./src/accounts.js";
import { createBilling } from "./src/stripe.js";
import { setupAllowed, saveSetup, writeEnv } from "./src/setup.js";
import { createSettings } from "./src/settings.js";
import { createGalleryGenerator } from "./src/gallery.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

export async function createApp(cfg = loadConfig(), { providerFactory, fetchImpl } = {}) {
  const ffmpegOk = await checkFfmpeg();
  const db = openDb(cfg.dataDir);
  const settings = createSettings(cfg);
  const accounts = createAccounts({ db, cfg });
  const billing = createBilling({ cfg, db, accounts, fetchImpl });
  const uploads = createUploadStore(cfg);
  const factory = providerFactory || (() => createFalProvider({ key: cfg.falKey, fileTtlSeconds: cfg.falFileTtlSeconds }));
  let provider = null;
  const getProvider = () => (provider ||= factory());
  const jobs = createJobManager({ cfg, uploads, getProvider, accounts });
  const gallery = createGalleryGenerator({ cfg, getProvider, settings, pollMs: Math.min(2000, cfg.pollIntervalMs) });
  const publicDir = path.join(cfg.root, "public");

  const timer = setInterval(() => { uploads.sweep(); jobs.sweep(); }, 60 * 1000);
  timer.unref();

  // Exemples de prix en crédits, calculés avec les vrais tarifs et la valeur actuelle du crédit.
  function creditExamples() {
    const t = cfg.tools;
    const c = (tool, params, video) => { const e = tool.estimate({ params: { ...tool.defaults, ...params }, video }); return [creditsFor(cfg, e), e?.usd ?? 0]; };
    const dance = { durationSec: 10, fps: 30 };
    return [
      ["Image ou personnage", ...c(t.image, {})],
      ["Vidéo de 5 s à partir d'un texte", ...c(t.video, { duration: "5" })],
      ["Vidéo de 10 s à partir d'un texte", ...c(t.video, { duration: "10" })],
      ["Mix ou Move, vidéo de 10 s, mode Économique (480p)", ...c(t.move, { resolution: "480p", fluidite: "eco" }, dance)],
      ["Mix ou Move, vidéo de 10 s, mode Économique (580p)", ...c(t.move, { resolution: "580p", fluidite: "eco" }, dance)],
      ["Mix ou Move, vidéo de 10 s à 30 images/s, mode Fluide (580p)", ...c(t.move, { resolution: "580p", fluidite: "origine" }, dance)],
    ];
  }

  // Nom de fichier téléchargé : nom de l'application en minuscules, sans accents ni espaces.
  const fileSlug = () => settings.get().appName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "creation";
  const isAdminReq = (req) => { const u = accounts.current(req); return !!u && accounts.isAdmin(u); };

  function status(req) {
    const missing = missingSettings(cfg);
    if (!ffmpegOk) missing.push("FFmpeg (non installé sur le serveur)");
    return {
      configured: missing.length === 0,
      missing,
      provider: "fal.ai",
      billing: billing.enabled(),
      billingWebhook: billing.webhookReady(),
      publicUrl: cfg.publicUrl || null,
      setupAvailable: req ? setupAllowed(req, cfg) : false,
      freeCredits: cfg.freeCredits,
      plans: cfg.plans,
      settings: settings.publicView(),
      creditExamples: creditExamples().map(([t, n, usd]) => (req && isAdminReq(req) ? [t, n, usd] : [t, n])),
      tools: Object.fromEntries(Object.entries(cfg.tools).map(([id, t]) => [id, {
        label: t.label, kind: t.kind, model: t.model, needs: t.needs, prompt: !!t.prompt,
        restoreAudio: !!t.restoreAudio, options: t.options, defaults: t.defaults, pricingNote: t.pricingNote,
      }])),
      limits: {
        maxVideoMB: cfg.maxVideoMB, maxImageMB: cfg.maxImageMB, maxAudioMB: cfg.maxAudioMB,
        minVideoSeconds: cfg.minVideoSeconds, maxVideoSeconds: cfg.maxVideoSeconds, maxPromptChars: cfg.maxPromptChars,
        dailyJobLimit: cfg.dailyJobLimit, maxConcurrentJobs: cfg.maxConcurrentJobs, resultTtlMinutes: cfg.resultTtlMinutes,
      },
    };
  }

  const send = (res, code, obj, extra = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });
    res.end(body);
  };

  async function readBuffer(req, max) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new UploadError("Fichier trop volumineux.", 413);
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  const readBody = async (req, max = 16 * 1024) => (await readBuffer(req, max)).toString("utf8");
  async function readJson(req) {
    try { return JSON.parse((await readBody(req)) || "{}"); } catch (e) { if (e.status) throw e; throw new UploadError("JSON invalide."); }
  }

  // Protection contre les requêtes envoyées depuis un autre site (le cookie de session est SameSite=Lax).
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  // Exige un compte connecté (et un service configuré pour les routes de génération).
  function requireUser(req, res, { service = false } = {}) {
    if (!sameOrigin(req)) { send(res, 403, { error: "Origine refusée." }); return null; }
    if (service) {
      const st = status();
      if (!st.configured) { send(res, 503, { error: "Service vidéo non configuré.", missing: st.missing }); return null; }
    }
    const user = accounts.current(req);
    if (!user) { send(res, 401, { error: "Connectez-vous pour continuer." }); return null; }
    return user;
  }

  const ownJob = (user, id) => {
    const job = jobs.get(id);
    return job && job.userId === user.id ? job : null;
  };

  async function serveFile(req, res, job, download) {
    const file = job.output.path;
    const stat = await fsp.stat(file);
    const headers = { ...SECURITY_HEADERS, "Content-Type": job.output.mime, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" };
    if (download) headers["Content-Disposition"] = `attachment; filename="${fileSlug()}-${job.tool}-${job.id.slice(0, 6)}.${job.output.mime === "image/jpeg" ? "jpg" : "mp4"}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      let start = range[1] === "" ? stat.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : stat.size - 1;
      if (start < 0) start = 0;
      end = Math.min(end, stat.size - 1);
      if (start > end || start >= stat.size) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": stat.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }

  async function serveStatic(req, res, urlPath) {
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Introuvable");
    }
  }

  const originOf = (req) => `${req.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${req.headers.host}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const p = url.pathname;
    try {
      if (p === "/api/status" && req.method === "GET") return send(res, 200, status(req));

      // Configuration initiale (clé fal) depuis la page, sur l'ordinateur local uniquement.
      if (p === "/api/setup" && req.method === "POST") {
        if (!sameOrigin(req) || !setupAllowed(req, cfg)) return send(res, 403, { error: "Configuration possible uniquement depuis l'ordinateur où tourne l'application, avant la première clé." });
        saveSetup(cfg, await readJson(req));
        provider = null;
        return send(res, 200, { ok: true, status: status(req) });
      }

      // ----- Comptes -----
      if (p === "/api/auth/signup" && req.method === "POST") {
        if (!sameOrigin(req)) return send(res, 403, { error: "Origine refusée." });
        const { user, cookie } = await accounts.signup(req, await readJson(req));
        return send(res, 201, { user: accounts.publicUser(user) }, { "Set-Cookie": cookie });
      }
      if (p === "/api/auth/login" && req.method === "POST") {
        if (!sameOrigin(req)) return send(res, 403, { error: "Origine refusée." });
        const { user, cookie } = await accounts.login(req, await readJson(req));
        return send(res, 200, { user: accounts.publicUser(user) }, { "Set-Cookie": cookie });
      }
      if (p === "/api/auth/logout" && req.method === "POST") {
        return send(res, 200, { ok: true }, { "Set-Cookie": await accounts.logout(req) });
      }
      if (p === "/api/me" && req.method === "GET") {
        const user = accounts.current(req);
        return send(res, 200, { user: user ? accounts.publicUser(user) : null });
      }

      // ----- Abonnements Stripe -----
      if (p === "/api/billing/checkout" && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        const body = await readJson(req);
        return send(res, 200, { url: await billing.checkout(user, String(body.plan), String(body.interval), originOf(req)) });
      }
      if (p === "/api/billing/portal" && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        return send(res, 200, { url: await billing.portal(user, originOf(req)) });
      }
      if (p === "/api/billing/confirm" && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        const r = await billing.confirm(user, (await readJson(req)).session);
        return send(res, 200, { ...r, user: accounts.publicUser(user) });
      }
      // Branchement de Stripe par l'administrateur (la clé n'est jamais renvoyée au navigateur).
      if (p === "/api/admin/stripe" && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        if (!accounts.isAdmin(user)) return send(res, 403, { error: "Réservé à l'administrateur." });
        const body = await readJson(req);
        const publicUrl = String(body.publicUrl || cfg.publicUrl || "").trim();
        const r = await billing.setup(body.secretKey, publicUrl);
        const env = {
          STRIPE_SECRET_KEY: r.key,
          STRIPE_PRICE_BASIQUE_MOIS: r.prices.basique_month, STRIPE_PRICE_BASIQUE_AN: r.prices.basique_year,
          STRIPE_PRICE_PRO_MOIS: r.prices.pro_month, STRIPE_PRICE_PRO_AN: r.prices.pro_year,
        };
        if (r.webhookSecret) env.STRIPE_WEBHOOK_SECRET = r.webhookSecret;
        if (publicUrl) env.PUBLIC_URL = publicUrl.replace(/\/$/, "");
        writeEnv(cfg, env);
        cfg.stripe.secretKey = r.key;
        Object.assign(cfg.stripe.prices, r.prices);
        if (r.webhookSecret) cfg.stripe.webhookSecret = r.webhookSecret;
        if (publicUrl) cfg.publicUrl = publicUrl.replace(/\/$/, "");
        return send(res, 200, { ok: true, live: r.live, webhook: !!cfg.stripe.webhookSecret, status: status(req) });
      }
      if (p === "/api/stripe/webhook" && req.method === "POST") {
        const raw = await readBody(req, 1024 * 1024);
        const result = await billing.webhook(raw, req.headers["stripe-signature"]);
        return send(res, 200, { received: true, result });
      }

      let m;
      // ----- Personnalisation du site (administrateur) -----
      if (p === "/api/admin/settings" && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        if (!accounts.isAdmin(user)) return send(res, 403, { error: "Réservé à l'administrateur." });
        await settings.update(await readJson(req));
        return send(res, 200, { ok: true, status: status(req) });
      }
      if (p === "/api/admin/images" && (req.method === "GET" || req.method === "POST")) {
        const user = requireUser(req, res, { service: req.method === "POST" });
        if (!user) return;
        if (!accounts.isAdmin(user)) return send(res, 403, { error: "Réservé à l'administrateur." });
        return send(res, 200, req.method === "POST" ? gallery.start() : gallery.status());
      }
      m = /^\/api\/admin\/cards\/([a-z]+)\/image$/.exec(p);
      if (m && (req.method === "PUT" || req.method === "DELETE")) {
        const user = requireUser(req, res);
        if (!user) { req.resume(); return; }
        if (!accounts.isAdmin(user)) { req.resume(); return send(res, 403, { error: "Réservé à l'administrateur." }); }
        if (req.method === "DELETE") await settings.removeImage(m[1]);
        else await settings.setImage(m[1], await readBuffer(req, cfg.maxImageMB * 1024 * 1024));
        return send(res, 200, { ok: true, status: status(req) });
      }
      m = /^\/api\/admin\/cards\/([a-z]+)\/image-from-job\/([a-f0-9]{24})$/.exec(p);
      if (m && req.method === "POST") {
        const user = requireUser(req, res);
        if (!user) return;
        if (!accounts.isAdmin(user)) return send(res, 403, { error: "Réservé à l'administrateur." });
        const job = ownJob(user, m[2]);
        if (!job || job.state !== "termine" || !job.output.mime.startsWith("image/")) return send(res, 404, { error: "Image générée introuvable." });
        await settings.setImage(m[1], await fsp.readFile(job.output.path));
        return send(res, 200, { ok: true, status: status(req) });
      }

      // ----- Fichiers importés -----
      m = /^\/api\/uploads\/(video|image|audio)$/.exec(p);
      if (m && req.method === "PUT") {
        const user = requireUser(req, res, { service: true });
        if (!user) { req.resume(); return; }
        const rec = await uploads.receive(req, m[1], user.id);
        const info = rec.info;
        const out = { id: rec.id, kind: rec.kind, size: rec.size };
        if (rec.kind === "video") {
          const d = info.video.duration || info.duration;
          Object.assign(out, { durationSec: d, fps: info.video.fps, width: info.video.width, height: info.video.height, hasAudio: !!info.audio });
        } else if (rec.kind === "image") Object.assign(out, { width: info.video.width, height: info.video.height });
        else Object.assign(out, { durationSec: info.duration });
        return send(res, 201, out);
      }

      // ----- Estimation (coût fal et crédits) -----
      if (p === "/api/estimate" && req.method === "POST") {
        const body = await readJson(req);
        const tool = cfg.tools[body.tool];
        if (!tool) return send(res, 400, { error: "Outil inconnu." });
        const params = {};
        for (const [k, allowed] of Object.entries(tool.options || {})) params[k] = allowed.includes(String(body[k])) ? String(body[k]) : tool.defaults[k];
        const v = body.videoId ? uploads.get(String(body.videoId)) : null;
        const video = v?.kind === "video" ? { durationSec: v.info.video.duration || v.info.duration, fps: v.info.video.fps } : null;
        const estimate = tool.estimate({ video, params }) || null;
        const needsVideo = tool.needs.includes("video") && !video;
        return send(res, 200, { estimate, credits: needsVideo ? null : creditsFor(cfg, estimate), pricingNote: tool.pricingNote });
      }

      // ----- Créations -----
      if (p === "/api/jobs" && req.method === "POST") {
        const user = requireUser(req, res, { service: true });
        if (!user) return;
        const job = await jobs.create(await readJson(req), user);
        return send(res, 202, { ...jobs.publicView(job), me: accounts.publicUser(user) });
      }
      if (p === "/api/jobs" && req.method === "GET") {
        const user = requireUser(req, res);
        if (!user) return;
        return send(res, 200, { jobs: jobs.list(user.id).map(jobs.publicView) });
      }

      m = /^\/api\/jobs\/([a-f0-9]{24})$/.exec(p);
      if (m && (req.method === "GET" || req.method === "DELETE")) {
        const user = requireUser(req, res);
        if (!user) return;
        const job = ownJob(user, m[1]);
        if (!job) return send(res, 404, { error: "Création introuvable ou expirée (le serveur a pu redémarrer)." });
        if (req.method === "DELETE") { await jobs.remove(job.id); return send(res, 200, { ok: true }); }
        return send(res, 200, { ...jobs.publicView(job), me: accounts.publicUser(user) });
      }

      // Réutiliser une création (personnage généré → Mix / Move, vidéo générée → source de danse).
      m = /^\/api\/jobs\/([a-f0-9]{24})\/reuse$/.exec(p);
      if (m && req.method === "POST") {
        const user = requireUser(req, res, { service: true });
        if (!user) return;
        const job = ownJob(user, m[1]);
        if (!job || job.state !== "termine") return send(res, 404, { error: "Création introuvable ou expirée." });
        const kind = job.output.mime.startsWith("image/") ? "image" : "video";
        const rec = await uploads.adopt(job.output.path, kind, user.id);
        const info = rec.info;
        const out = { id: rec.id, kind, size: rec.size, width: info.video.width, height: info.video.height };
        if (kind === "video") Object.assign(out, { durationSec: info.video.duration || info.duration, fps: info.video.fps, hasAudio: !!info.audio });
        return send(res, 201, out);
      }

      m = /^\/api\/jobs\/([a-f0-9]{24})\/file$/.exec(p);
      if (m && (req.method === "GET" || req.method === "HEAD")) {
        const job = jobs.get(m[1]);
        const t = url.searchParams.get("t") || "";
        if (!job || job.state !== "termine" || t.length !== job.token.length || t !== job.token) {
          return send(res, 404, { error: "Fichier introuvable ou expiré." });
        }
        return serveFile(req, res, job, url.searchParams.get("download") === "1");
      }

      m = /^\/branding\/([^/]+)$/.exec(p);
      if (m && (req.method === "GET" || req.method === "HEAD")) {
        const f = settings.imageFile(m[1]);
        if (!f) { res.writeHead(404); return res.end(); }
        const data = await fsp.readFile(f.path);
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": f.mime, "Cache-Control": "public, max-age=31536000, immutable" });
        return res.end(req.method === "HEAD" ? undefined : data);
      }

      if (p.startsWith("/api/")) return send(res, 404, { error: "Route inconnue." });
      // Images de la galerie : servies depuis GALLERY_DIR (disque persistant en ligne).
      m = /^\/galerie\/([a-z0-9-]+\.(?:jpg|json))$/.exec(p);
      if (m && (req.method === "GET" || req.method === "HEAD")) {
        try {
          const data = await fsp.readFile(path.join(cfg.galleryDir, m[1]));
          res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": m[1].endsWith(".json") ? "application/json; charset=utf-8" : "image/jpeg", "Cache-Control": "no-store" });
          return res.end(req.method === "HEAD" ? undefined : data);
        } catch {
          if (m[1] === "manifest.json") return send(res, 200, {});
          res.writeHead(404); return res.end();
        }
      }
      if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
      res.writeHead(405); res.end();
    } catch (e) {
      const code = e.status || 500;
      if (code === 500) console.error(e);
      if (!res.headersSent) send(res, code, { error: code === 500 ? "Erreur interne du serveur." : e.message });
      else res.end();
    }
  });
  server.requestTimeout = 15 * 60 * 1000; // envois de vidéos sur connexion mobile lente

  return { server, jobs, uploads, db, accounts, billing, settings, gallery, status, close: async () => { clearInterval(timer); await jobs.stop(); server.close(); server.closeAllConnections?.(); await db.flush(); await settings.flush(); } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cfg = loadConfig();
  // Hébergeur (Docker) : démarre en root seulement pour donner le disque de données à l'utilisateur
  // DROP_TO_USER, puis abandonne les droits root avant de lire ou servir quoi que ce soit.
  if (process.env.DROP_TO_USER && process.getuid?.() === 0) {
    const { execFileSync } = await import("node:child_process");
    const user = process.env.DROP_TO_USER;
    for (const dir of new Set([cfg.dataDir, cfg.galleryDir, ...(cfg.envFile ? [path.dirname(cfg.envFile)] : [])])) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync("chown", ["-R", `${user}:`, dir]); // « user: » = son groupe principal
    }
    const gid = Number(execFileSync("id", ["-g", user]).toString().trim());
    process.initgroups(user, gid);
    process.setgid(gid);
    process.setuid(user);
  }
  const app = await createApp(cfg);
  app.server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`\nDanse Studio est déjà lancé (le port ${cfg.port} est occupé).`);
      console.error(`Ouvrez simplement http://localhost:${cfg.port} dans votre navigateur, ou fermez l'autre fenêtre noire puis relancez.\n`);
      process.exit(1);
    }
    throw e;
  });
  app.server.listen(cfg.port, cfg.host, () => {
    const st = app.status();
    console.log(`Danse Studio : http://localhost:${cfg.port}`);
    if (!st.configured) console.warn(`⚠ Service vidéo non configuré. Manquant : ${st.missing.join(", ")}`);
    if (!st.billing) console.warn("⚠ Paiement Stripe non configuré : les abonnements sont désactivés.");
  });
}
