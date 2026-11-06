import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ff = (...args) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args]);
export const probeJson = (file) =>
  JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());

// Bip à 880 Hz exactement entre 2,0 s et 2,3 s, silence ailleurs : sert à mesurer la synchronisation.
const BEEP = "aevalsrc='if(between(t,2,2.3),0.8*sin(2*PI*880*t),0)':s=44100:d=4";

export function makeFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-fix-"));
  const f = (n) => path.join(dir, n);
  // Vidéo de danse de référence : 4 s, 25 i/s, avec son (bip à 2 s).
  ff("-f", "lavfi", "-i", "testsrc=s=320x480:r=25:d=4", "-f", "lavfi", "-i", BEEP,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", f("danse.mp4"));
  // Même vidéo en WebM (doit être convertie avant l'envoi à l'IA).
  ff("-f", "lavfi", "-i", "testsrc=s=320x480:r=25:d=4", "-c:v", "libvpx", "-b:v", "300k", "-an", f("danse.webm"));
  // Vidéo sans son.
  ff("-f", "lavfi", "-i", "testsrc=s=320x480:r=25:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f("muette.mp4"));
  // Vidéo trop longue (35 s).
  ff("-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=35", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f("longue.mp4"));
  // « Sortie IA » simulée : autre cadence (16 i/s), muette, même durée.
  ff("-f", "lavfi", "-i", "smptebars=s=320x480:r=16:d=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f("sortie-ia.mp4"));
  // « Sortie IA » plus courte que la source (3 s).
  ff("-f", "lavfi", "-i", "smptebars=s=320x480:r=16:d=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f("sortie-courte.mp4"));
  // Personnage + image trop petite.
  ff("-f", "lavfi", "-i", "color=c=orange:s=512x768", "-frames:v", "1", f("perso.png"));
  ff("-f", "lavfi", "-i", "color=c=orange:s=100x100", "-frames:v", "1", f("mini.png"));
  // « Image IA » simulée (JPEG, personnage en pied).
  ff("-f", "lavfi", "-i", "color=c=purple:s=576x1024", "-frames:v", "1", f("perso-ia.jpg"));
  // Musique de remplacement : 8 s (plus longue que la vidéo).
  ff("-f", "lavfi", "-i", "sine=f=440:d=8", "-c:a", "libmp3lame", f("musique.mp3"));
  // Faux fichier vidéo.
  fs.writeFileSync(f("faux.mp4"), "ceci n'est pas une vidéo".repeat(10));
  return { dir, f };
}

// Instant (en s) où le son commence après le silence initial (fin du premier silence détecté).
export function firstSoundAt(file) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-af", "silencedetect=n=-30dB:d=0.5", "-f", "null", "-"], { encoding: "utf8" });
  const m = /silence_end: ([\d.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : null;
}
