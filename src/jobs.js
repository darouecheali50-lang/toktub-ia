// File de tâches de génération (en mémoire, une instance serveur).
// Chaque état affiché correspond à une étape réellement en cours.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { makeAiInput, muxFinal, probe, lastFrame, concatVideos } from "./media.js";
import { normalizeParams, creditsFor, aiFps } from "./config.js";

export const STATES = {
  preparation: "Préparation des fichiers",
  envoi: "Envoi au service IA",
  attente: "En attente chez le service IA",
  generation: "Génération par l'IA",
  assemblage: "Finalisation",
  termine: "Terminé",
  erreur: "Erreur",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });
const FINAL = ["termine", "erreur"];

export function createJobManager({ cfg, uploads, getProvider, accounts = null, log = console }) {
  const jobs = new Map();
  const workDir = path.join(cfg.dataDir, "jobs");
  fs.mkdirSync(workDir, { recursive: true });
  let day = new Date().toISOString().slice(0, 10);
  let todayCount = new Map(); // utilisateur -> nombre de créations aujourd'hui

  // ---- Sauvegarde sur disque : les créations survivent à un redémarrage du serveur ----
  const stateFile = path.join(cfg.dataDir, "jobs.json");
  const KEEP = ["id", "token", "tool", "state", "createdAt", "updatedAt", "params", "sourceDuration", "audioMode", "warnings",
    "userId", "estimate", "credits", "dir", "task", "remote", "output", "expiresAt", "error", "inferenceSeconds", "segmentIndex", "segmentTotal", "queuePosition"];
  let saveTimer = null;
  let stopped = false;
  const STOP = Symbol("arrêt");
  function persist() {
    if (stopped) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const list = [...jobs.values()].map((j) => {
        const o = Object.fromEntries(KEEP.map((k) => [k, j[k]]));
        o.files = Object.fromEntries(Object.entries(j.files || {}).filter(([, f]) => f).map(([k, f]) => [k, { id: f.id, kind: f.kind, path: f.path, mime: f.mime, info: f.info }]));
        return o;
      });
      const tmp = `${stateFile}.tmp`;
      fs.promises.writeFile(tmp, JSON.stringify(list)).then(() => fs.promises.rename(tmp, stateFile)).catch((e) => log.error?.(`Sauvegarde des créations impossible : ${e.message}`));
    }, 50);
  }

  const activeCount = (userId) => [...jobs.values()].filter((j) => !FINAL.includes(j.state) && (userId === undefined || j.userId === userId)).length;

  function publicView(job) {
    const tool = cfg.tools[job.tool];
    const base = `/api/jobs/${job.id}/file?t=${job.token}`;
    return {
      id: job.id,
      tool: job.tool,
      toolLabel: tool.label,
      kind: tool.kind,
      state: job.state,
      stateLabel: STATES[job.state],
      queuePosition: job.queuePosition ?? null,
      error: job.error || null,
      warnings: job.warnings,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      params: job.params,
      estimate: job.estimate,
      credits: job.credits,
      segment: job.segmentTotal > 1 ? { index: job.segmentIndex, total: job.segmentTotal } : null,
      inferenceSeconds: job.inferenceSeconds ?? null,
      audioMode: job.audioMode,
      result: job.state === "termine"
        ? {
            url: base,
            downloadUrl: `${base}&download=1`,
            mime: job.output.mime,
            durationSec: job.output.duration ?? null,
            sourceDurationSec: job.sourceDuration ?? null,
            hasAudio: job.output.hasAudio ?? null,
            expiresAt: job.expiresAt,
          }
        : null,
    };
  }

  function take(id, kind, userId) {
    if (!id) return null;
    const f = uploads.get(String(id));
    const label = { video: "Vidéo", image: "Image", audio: "Fichier audio" }[kind];
    if (!f || f.kind !== kind || f.inUse || f.userId !== userId) throw httpError(`${label} introuvable : importez-la à nouveau.`);
    return f;
  }

  async function create(body, user = null) {
    const userId = user?.id ?? null;
    const tool = cfg.tools[body.tool];
    if (!tool) throw httpError("Outil inconnu.");
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; todayCount = new Map(); }
    const admin = !!(user && cfg.adminEmails?.includes(user.email));
    const countKey = userId ?? "anonyme";
    if (!admin && (todayCount.get(countKey) || 0) >= cfg.dailyJobLimit) throw httpError(`Limite quotidienne atteinte (${cfg.dailyJobLimit} créations par jour). Revenez demain.`, 429);
    if (activeCount() >= (cfg.maxActiveJobsTotal ?? cfg.maxConcurrentJobs * 5)) throw httpError("Le service est très demandé. Réessayez dans quelques minutes.", 429);
    if (!admin && activeCount(userId) >= cfg.maxConcurrentJobs) throw httpError(`Vous avez déjà ${cfg.maxConcurrentJobs} créations en cours. Patientez jusqu'à la fin de l'une d'elles.`, 429);

    const params = normalizeParams(tool, body, cfg);
    const video = tool.needs.includes("video") ? take(body.videoId, "video", userId) : null;
    const image = tool.needs.includes("image") ? take(body.imageId, "image", userId) : null;
    if (tool.needs.includes("video") && !video) throw httpError("Ajoutez une vidéo.");
    if (tool.needs.includes("image") && !image) throw httpError("Ajoutez une image.");
    const audio = tool.restoreAudio && body.audioId ? take(body.audioId, "audio", userId) : null;

    const warnings = [];
    let audioMode = null;
    let sourceDuration = null;
    if (video) {
      sourceDuration = video.info.video.duration || video.info.duration;
      if (audio) {
        audioMode = "remplacement";
        if (audio.info.duration > sourceDuration + 0.5) warnings.push(`La musique de remplacement (${audio.info.duration.toFixed(1)} s) est plus longue que la vidéo : elle sera arrêtée à la fin de la vidéo.`);
        else if (audio.info.duration < sourceDuration - 0.5) warnings.push(`La musique de remplacement (${audio.info.duration.toFixed(1)} s) est plus courte que la vidéo : la fin sera silencieuse.`);
      } else if (video.info.audio) audioMode = "original";
      else { audioMode = "aucun"; warnings.push("La vidéo de référence ne contient pas de son : le résultat sera muet."); }
    }

    const estimate = tool.estimate({ video: video && { durationSec: sourceDuration, fps: video.info.video.fps }, params }) || null;
    const credits = creditsFor(cfg, estimate);
    const refund = user && accounts ? await accounts.charge(user, credits) : async () => {};

    for (const f of [video, image, audio]) if (f) f.inUse = true;
    todayCount.set(countKey, (todayCount.get(countKey) || 0) + 1);

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      token: crypto.randomBytes(24).toString("hex"),
      tool: body.tool,
      state: "preparation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      params,
      sourceDuration,
      audioMode,
      warnings,
      userId,
      estimate,
      credits,
      refund,
      files: { video, image, audio },
      dir: path.join(workDir, crypto.randomBytes(8).toString("hex")),
    };
    jobs.set(job.id, job);
    persist();
    run(job, tool).catch((e) => fail(job, e));
    return job;
  }

  function set(job, state, extra = {}) {
    Object.assign(job, extra, { state, updatedAt: Date.now() });
    persist();
  }

  function fail(job, e) {
    if (e === STOP || stopped) return; // arrêt du serveur : la création sera reprise au prochain démarrage
    log.error?.(`[job ${job.id}] ${e.stack || e.message}`);
    if (job.task && ["attente", "generation"].includes(job.state)) safeProvider()?.cancel(job.task).catch(() => {});
    set(job, "erreur", { error: e.message || String(e) });
    job.refund?.().then(() => { if (job.credits) job.warnings.push(`${job.credits} crédit(s) recrédité(s) sur votre compte.`); }).catch(() => {});
    cleanup(job, { keepOutput: false });
  }

  // Soumet une tâche et suit son statut réel jusqu'à COMPLETED (aucune progression inventée).
  async function runTask(job, provider, model, input, { resume = false } = {}) {
    if (!resume) {
      job.task = await provider.submit(model, input);
      set(job, job.segmentIndex > 1 ? "generation" : "attente", { queuePosition: job.task.queue_position ?? null });
    }
    const deadline = Date.now() + cfg.maxJobMinutes * 60 * 1000;
    let transientErrors = 0;
    for (;;) {
      if (Date.now() > deadline) {
        await provider.cancel(job.task);
        throw new Error(`Délai dépassé (${cfg.maxJobMinutes} min). La tâche a été annulée chez le fournisseur.`);
      }
      await sleep(cfg.pollIntervalMs);
      if (stopped) throw STOP;
      let st;
      try { st = await provider.status(job.task); transientErrors = 0; } catch (e) {
        if (e.retryable && ++transientErrors < 5) continue;
        throw e;
      }
      if (st.status === "IN_QUEUE") set(job, job.segmentIndex > 1 ? "generation" : "attente", { queuePosition: st.queue_position ?? null });
      else if (st.status === "IN_PROGRESS") set(job, "generation", { queuePosition: null });
      else if (st.status === "COMPLETED") {
        if (st.error) throw new Error(`Le service IA a signalé une erreur${st.error_type ? ` (${st.error_type})` : ""} : ${st.error}`);
        job.inferenceSeconds = (job.inferenceSeconds || 0) + (st.metrics?.inference_time || 0) || null;
        break;
      }
    }
    return provider.result(job.task);
  }

  async function run(job, tool, { resume = false } = {}) {
    const provider = getProvider();
    await fsp.mkdir(job.dir, { recursive: true });
    const { video, image, audio } = job.files;
    let res = null;
    if (resume) {
      // Reprise après redémarrage : la tâche existe déjà chez fal, on reprend son suivi.
      res = await runTask(job, provider, null, null, { resume: true });
      return finish(job, tool, provider, res, []);
    }

    // 1. Préparation (vidéo H.264 muette pour l'IA) et envoi réel des fichiers.
    let aiInput = null;
    if (video) {
      aiInput = path.join(job.dir, "ia-entree.mp4");
      await makeAiInput(video.path, aiInput, video.info, { fps: aiFps(video.info.video.fps, job.params?.fluidite) });
    }
    set(job, "envoi");
    job.remote = {};
    if (aiInput) { job.remote.videoUrl = await provider.uploadFile(aiInput, "video/mp4"); await fsp.rm(aiInput, { force: true }); }
    if (image) job.remote.imageUrl = await provider.uploadFile(image.path, image.mime);

    // 2. Création de la tâche (ou de plusieurs morceaux enchaînés pour les vidéos longues).
    const segments = tool.segments ? tool.segments(job.params) : [null];
    job.segmentTotal = segments.length;
    const parts = [];
    let startImageUrl = job.remote.imageUrl;
    for (let i = 0; i < segments.length; i++) {
      job.segmentIndex = i + 1;
      const first = i === 0;
      const model = first ? tool.model : tool.continueModel;
      const input = first
        ? tool.buildInput({ videoUrl: job.remote.videoUrl, imageUrl: startImageUrl, params: job.params, segment: segments[i] })
        : tool.buildContinueInput({ imageUrl: startImageUrl, params: job.params, segment: segments[i] });
      res = await runTask(job, provider, model, input);
      if (segments.length > 1) {
        if (!res.videoUrl) throw new Error("Le service IA n'a renvoyé aucune vidéo pour un des morceaux.");
        const part = path.join(job.dir, `morceau-${i + 1}.mp4`);
        await provider.download(res.videoUrl, part);
        parts.push(part);
        if (i < segments.length - 1) {
          const frame = path.join(job.dir, `suite-${i + 1}.jpg`);
          await lastFrame(part, frame);
          startImageUrl = await provider.uploadFile(frame, "image/jpeg");
          (job.remote.extra ||= []).push(startImageUrl);
        }
        set(job, "generation");
      }
    }

    return finish(job, tool, provider, res, parts);
  }

  async function finish(job, tool, provider, res, parts) {
    const { video, audio } = job.files;
    // 4. Récupération du résultat.
    set(job, "assemblage", { queuePosition: null });
    if (parts.length > 1) {
      const info = await probe(parts[0]);
      const joined = path.join(job.dir, "creation.mp4");
      await concatVideos(parts, joined, { width: info.video.width, height: info.video.height, fps: info.video.fps });
      for (const p of parts) await fsp.rm(p, { force: true });
      const outInfo = await probe(joined);
      job.output = { path: joined, mime: "video/mp4", filename: "creation.mp4", duration: outInfo.duration, hasAudio: false };
      job.expiresAt = Date.now() + cfg.resultTtlMinutes * 60 * 1000;
      set(job, "termine");
      await cleanup(job, { keepOutput: true });
      return;
    }

    if (tool.kind === "image") {
      if (!res.imageUrl) throw new Error("Le service IA n'a renvoyé aucune image.");
      const out = path.join(job.dir, "creation.jpg");
      await provider.download(res.imageUrl, out);
      const info = await probe(out).catch(() => null);
      if (!info?.video) throw new Error("L'image renvoyée par le service IA est illisible.");
      job.output = { path: out, mime: "image/jpeg", filename: "creation.jpg" };
    } else {
      if (!res.videoUrl) throw new Error("Le service IA n'a renvoyé aucune vidéo.");
      const generated = path.join(job.dir, "ia-sortie.mp4");
      await provider.download(res.videoUrl, generated);
      const genInfo = await probe(generated).catch(() => null);
      if (!genInfo?.video) throw new Error("La vidéo renvoyée par le service IA est illisible.");
      const genDuration = genInfo.video.duration || genInfo.duration;
      const finalPath = path.join(job.dir, "creation.mp4");

      if (tool.restoreAudio) {
        if (Math.abs(genDuration - job.sourceDuration) > 0.5) {
          job.warnings.push(`Le service IA a renvoyé une vidéo de ${genDuration.toFixed(1)} s pour une source de ${job.sourceDuration.toFixed(1)} s. ` +
            (genDuration < job.sourceDuration
              ? "La fin du mouvement n'a pas été générée par le fournisseur ; la musique d'origine est conservée en entier (dernière image figée)."
              : "La musique est placée depuis le début."));
        }
        if (genInfo.audio) job.warnings.push("Le service IA a renvoyé une piste audio : elle a été remplacée par la bande-son choisie.");
        // Réintégration de la musique (FFmpeg) : le moteur ne documente pas la conservation de l'audio.
        const audioSource = audio ? audio.path : (video.info.audio ? video.path : null);
        await muxFinal({ generated, audioSource, out: finalPath, trimAudioTo: audio ? genDuration : null });
        await fsp.rm(generated, { force: true });
      } else {
        await fsp.rename(generated, finalPath);
      }
      const outInfo = await probe(finalPath);
      if (tool.restoreAudio && job.audioMode !== "aucun" && !outInfo.audio) throw new Error("La piste audio n'a pas pu être intégrée à la vidéo finale.");
      job.output = { path: finalPath, mime: "video/mp4", filename: "creation.mp4", duration: outInfo.duration, hasAudio: !!outInfo.audio };
    }

    job.expiresAt = Date.now() + cfg.resultTtlMinutes * 60 * 1000;
    set(job, "termine");
    await cleanup(job, { keepOutput: true });
  }

  // Supprime les fichiers temporaires locaux et, si possible, les copies chez fal.
  async function cleanup(job, { keepOutput }) {
    const { video, image, audio } = job.files || {};
    for (const f of [video, image, audio]) if (f) { await uploads.remove(f.id); await fsp.rm(f.path, { force: true }).catch(() => {}); }
    if (job.remote) {
      const provider = safeProvider();
      for (const url of [job.remote.videoUrl, job.remote.imageUrl, ...(job.remote.extra || [])]) if (url) await provider?.deleteFile(url).catch(() => {});
      job.remote = null;
    }
    if (!keepOutput) await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  function safeProvider() { try { return getProvider(); } catch { return null; } }

  async function remove(id) {
    const job = jobs.get(id);
    if (!job) return;
    if (!FINAL.includes(job.state) && job.task) await safeProvider()?.cancel(job.task);
    jobs.delete(id);
    persist();
    await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  // Au démarrage : recharge les créations et reprend celles qui tournaient chez fal.
  function restore() {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return; }
    for (const saved of list) {
      const job = { ...saved, files: saved.files || {} };
      const tool = cfg.tools[job.tool];
      if (!tool) continue;
      jobs.set(job.id, job);
      if (job.state === "termine") {
        if (!job.output || !fs.existsSync(job.output.path)) jobs.delete(job.id);
        continue;
      }
      if (job.state === "erreur") continue;
      job.refund = accounts && job.userId ? makeRefund(job) : null;
      const resumable = job.task?.status_url && (job.segmentTotal || 1) <= 1
        && Object.values(job.files).every((f) => !f || fs.existsSync(f.path));
      if (resumable) {
        job.warnings.push("Le serveur a redémarré pendant la création : son suivi a été repris automatiquement.");
        log.info?.(`[job ${job.id}] reprise après redémarrage`);
        run(job, tool, { resume: true }).catch((e) => fail(job, e));
      } else {
        fail(job, new Error("La création a été interrompue par un redémarrage du serveur avant d'être envoyée au service IA. Vos crédits ont été rendus : relancez-la."));
      }
    }
    persist();
  }

  function makeRefund(job) {
    let done = false;
    return async () => {
      if (done || !job.credits) return;
      done = true;
      await accounts.refundTo(job.userId, job.credits);
    };
  }

  async function sweep() {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (job.state === "termine" && job.expiresAt < now) await remove(job.id);
      if (job.state === "erreur" && now - job.updatedAt > 60 * 60 * 1000) await remove(job.id);
    }
  }

  const list = (userId = null) => [...jobs.values()].filter((j) => j.state === "termine" && j.userId === userId).sort((a, b) => b.createdAt - a.createdAt);

  restore();
  // Arrêt propre : sauvegarde immédiate, puis plus aucun suivi ni écriture (reprise au redémarrage).
  async function stop() {
    clearTimeout(saveTimer);
    const list = [...jobs.values()].map((j) => {
      const o = Object.fromEntries(KEEP.map((k) => [k, j[k]]));
      o.files = Object.fromEntries(Object.entries(j.files || {}).filter(([, f]) => f).map(([k, f]) => [k, { id: f.id, kind: f.kind, path: f.path, mime: f.mime, info: f.info }]));
      return o;
    });
    stopped = true;
    await fs.promises.writeFile(stateFile, JSON.stringify(list));
  }
  return { create, get: (id) => jobs.get(id), list, publicView, remove, sweep, activeCount, stop, flush: () => new Promise((r) => setTimeout(r, 80)) };
}
