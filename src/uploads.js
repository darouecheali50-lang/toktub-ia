// Réception des fichiers : flux écrit directement sur disque, taille plafonnée,
// type vérifié par signature binaire (pas seulement l'extension) puis par FFprobe.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { probe } from "./media.js";

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const KINDS = {
  video: { label: "vidéo", mime: "video/mp4" },
  image: { label: "image" },
  audio: { label: "fichier audio" },
};

export function sniff(buf) {
  const at = (o, s) => buf.length >= o + s.length && buf.subarray(o, o + s.length).toString("latin1") === s;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: "image", ext: "jpg", mime: "image/jpeg" };
  if (at(0, "\x89PNG")) return { kind: "image", ext: "png", mime: "image/png" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", ext: "webp", mime: "image/webp" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", ext: "wav", mime: "audio/wav" };
  if (at(0, "OggS")) return { kind: "audio", ext: "ogg", mime: "audio/ogg" };
  if (at(0, "fLaC")) return { kind: "audio", ext: "flac", mime: "audio/flac" };
  if (at(0, "ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { kind: "audio", ext: "mp3", mime: "audio/mpeg" };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: "video", ext: "webm", mime: "video/webm" };
  if (at(4, "ftyp")) {
    const brand = buf.subarray(8, 12).toString("latin1");
    if (/^M4A |^M4B /.test(brand)) return { kind: "audio", ext: "m4a", mime: "audio/mp4" };
    if (brand === "qt  ") return { kind: "video", ext: "mov", mime: "video/quicktime" };
    return { kind: "video", ext: "mp4", mime: "video/mp4" };
  }
  if (at(4, "moov") || at(4, "mdat") || at(4, "wide") || at(4, "free")) return { kind: "video", ext: "mov", mime: "video/quicktime" };
  return null;
}

export function createUploadStore(cfg) {
  const dir = path.join(cfg.dataDir, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const files = new Map(); // id -> { id, kind, path, mime, size, info, createdAt }
  const limits = {
    video: cfg.maxVideoMB * 1024 * 1024,
    image: cfg.maxImageMB * 1024 * 1024,
    audio: cfg.maxAudioMB * 1024 * 1024,
  };

  async function receive(req, kind, userId = null) {
    if (!KINDS[kind]) throw new UploadError("Type de fichier inconnu.");
    const max = limits[kind];
    const declared = Number(req.headers["content-length"]);
    if (declared && declared > max) {
      throw new UploadError(`Fichier trop volumineux : ${KINDS[kind].label} limitée à ${Math.round(max / 1048576)} Mo.`, 413);
    }
    const id = crypto.randomBytes(16).toString("hex");
    const tmp = path.join(dir, `${id}.part`);
    let size = 0;
    let head = Buffer.alloc(0);
    const out = fs.createWriteStream(tmp);
    try {
      await new Promise((resolve, reject) => {
        req.on("data", (chunk) => {
          size += chunk.length;
          if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
          if (size > max) {
            req.unpipe(out);
            req.resume();
            reject(new UploadError(`Fichier trop volumineux : ${KINDS[kind].label} limitée à ${Math.round(max / 1048576)} Mo.`, 413));
          }
        });
        req.on("error", reject);
        req.on("aborted", () => reject(new UploadError("Envoi interrompu.")));
        out.on("error", reject);
        out.on("finish", resolve);
        req.pipe(out);
      });
      if (size === 0) throw new UploadError("Fichier vide.");
      const type = sniff(head);
      if (!type || type.kind !== kind) {
        const accepted = { video: "MP4, MOV ou WebM", image: "JPEG, PNG ou WebP", audio: "MP3, WAV, M4A, OGG ou FLAC" }[kind];
        throw new UploadError(`Format non pris en charge pour la ${KINDS[kind].label}. Formats acceptés : ${accepted}.`, 415);
      }
      const finalPath = path.join(dir, `${id}.${type.ext}`);
      await fsp.rename(tmp, finalPath);
      let info;
      try {
        info = await probe(finalPath);
      } catch {
        await fsp.rm(finalPath, { force: true });
        throw new UploadError(`Le fichier est illisible ou corrompu (${KINDS[kind].label}).`, 415);
      }
      const problem = validateMedia(kind, info, cfg);
      if (problem) {
        await fsp.rm(finalPath, { force: true });
        throw new UploadError(problem, 422);
      }
      const rec = { id, kind, path: finalPath, mime: type.mime, size, info, userId, createdAt: Date.now() };
      files.set(id, rec);
      return rec;
    } finally {
      out.destroy();
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  // Réutilise un fichier déjà présent sur le serveur (ex. personnage généré par l'IA)
  // comme s'il venait d'être importé : copie, contrôle FFprobe, enregistrement.
  async function adopt(srcPath, kind, userId = null) {
    const head = Buffer.alloc(64);
    const fd = await fsp.open(srcPath, "r");
    try { await fd.read(head, 0, 64, 0); } finally { await fd.close(); }
    const type = sniff(head);
    if (!type || type.kind !== kind) throw new UploadError("Ce fichier ne peut pas être réutilisé ici.", 415);
    const id = crypto.randomBytes(16).toString("hex");
    const finalPath = path.join(dir, `${id}.${type.ext}`);
    await fsp.copyFile(srcPath, finalPath);
    const info = await probe(finalPath);
    const problem = validateMedia(kind, info, cfg);
    if (problem) { await fsp.rm(finalPath, { force: true }); throw new UploadError(problem, 422); }
    const size = (await fsp.stat(finalPath)).size;
    const rec = { id, kind, path: finalPath, mime: type.mime, size, info, userId, createdAt: Date.now() };
    files.set(id, rec);
    return rec;
  }

  async function remove(id) {
    const rec = files.get(id);
    if (!rec) return;
    files.delete(id);
    await fsp.rm(rec.path, { force: true }).catch(() => {});
  }

  // Fichiers envoyés mais jamais utilisés : supprimés après 30 minutes.
  async function sweep(maxAgeMs = 30 * 60 * 1000) {
    for (const rec of files.values()) {
      if (!rec.inUse && Date.now() - rec.createdAt > maxAgeMs) await remove(rec.id);
    }
  }

  return { receive, adopt, get: (id) => files.get(id), remove, sweep, dir };
}

export function validateMedia(kind, info, cfg) {
  if (kind === "video") {
    if (!info.video) return "Aucune piste vidéo détectée dans ce fichier.";
    const d = info.video.duration || info.duration;
    if (!d) return "Durée de la vidéo illisible.";
    if (d < cfg.minVideoSeconds) return `Vidéo trop courte (${d.toFixed(1)} s, minimum ${cfg.minVideoSeconds} s).`;
    if (d > cfg.maxVideoSeconds + 0.05) {
      return `Vidéo trop longue : ${d.toFixed(1)} s pour une limite de ${cfg.maxVideoSeconds} s. ` +
        "Elle n'est pas coupée automatiquement : raccourcissez-la avant l'import.";
    }
    if (!info.video.fps) return "Cadence d'images de la vidéo illisible.";
  }
  if (kind === "image") {
    if (!info.video?.width || !info.video?.height) return "Dimensions de l'image illisibles.";
    if (Math.min(info.video.width, info.video.height) < 256) return "Image trop petite : au moins 256 px sur le plus petit côté.";
  }
  if (kind === "audio") {
    if (!info.audio) return "Aucune piste audio détectée dans ce fichier.";
  }
  return null;
}
