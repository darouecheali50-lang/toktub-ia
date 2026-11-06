// Outils FFmpeg / FFprobe (exécutés côté serveur, sans shell : pas d'injection possible).
import { spawn } from "node:child_process";

function run(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`${cmd} introuvable ou impossible à lancer (${e.code || e.message}). Installez FFmpeg sur le serveur.`));
    });
    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} a échoué (code ${code}) : ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

export async function checkFfmpeg() {
  try {
    await run("ffmpeg", ["-version"], { timeoutMs: 10000 });
    await run("ffprobe", ["-version"], { timeoutMs: 10000 });
    return true;
  } catch {
    return false;
  }
}

const parseRate = (r) => {
  if (!r || r === "0/0") return null;
  const [a, b] = r.split("/").map(Number);
  return b ? a / b : a || null;
};

export async function probe(file) {
  const out = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration",
    "-of", "json",
    file,
  ], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const duration = Number(j.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0;
  return {
    formatName: j.format?.format_name || "",
    duration,
    video: v
      ? {
          codec: v.codec_name,
          width: v.width,
          height: v.height,
          fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
          duration: Number(v.duration) || duration,
        }
      : null,
    audio: a ? { codec: a.codec_name, duration: Number(a.duration) || duration } : null,
  };
}

// Prépare la vidéo envoyée à l'IA : MP4 H.264 sans piste audio
// (l'audio n'est pas utile au moteur et reste sur notre serveur).
export async function makeAiInput(src, dst, info, { fps } = {}) {
  const isMp4 = /mp4|mov/.test(info.formatName);
  const resample = fps && info.video?.fps && fps < info.video.fps - 0.01;
  if (!resample && isMp4 && info.video?.codec === "h264") {
    await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-map", "0:v:0", "-c", "copy", "-an", "-movflags", "+faststart", dst]);
  } else {
    await run("ffmpeg", ["-y", "-v", "error", "-i", src, "-map", "0:v:0", ...(resample ? ["-vf", `fps=${fps}`] : []),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", dst]);
  }
}

// Assemble la vidéo générée et la bande-son.
// - audio d'origine : la piste est copiée depuis t=0, comme la vidéo source -> synchronisation conservée ;
// - musique de remplacement : coupée à la durée de la vidéo générée (l'utilisateur en est informé avant).
// La vidéo n'est jamais coupée ni ré-encodée (copie du flux).
export async function muxFinal({ generated, audioSource, out, trimAudioTo }) {
  const args = ["-y", "-v", "error", "-i", generated];
  if (audioSource) {
    args.push("-i", audioSource, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k");
    if (trimAudioTo) args.push("-t", trimAudioTo.toFixed(3));
  } else {
    args.push("-map", "0:v:0", "-c:v", "copy", "-an");
  }
  args.push("-movflags", "+faststart", out);
  await run("ffmpeg", args);
}

// Dernière image d'une vidéo (JPEG), pour enchaîner un morceau suivant.
export async function lastFrame(src, dst) {
  await run("ffmpeg", ["-y", "-v", "error", "-sseof", "-0.25", "-i", src, "-update", "1", "-q:v", "2", "-frames:v", "1", dst]);
}

// Assemble plusieurs morceaux bout à bout (même taille et cadence que le premier), sans son.
export async function concatVideos(files, out, { width, height, fps }) {
  const args = ["-y", "-v", "error"];
  for (const f of files) args.push("-i", f);
  const w = width % 2 ? width - 1 : width;
  const h = height % 2 ? height - 1 : height;
  const scaled = files.map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${Math.round(fps) || 24}[v${i}]`).join(";");
  const chain = files.map((_, i) => `[v${i}]`).join("");
  args.push("-filter_complex", `${scaled};${chain}concat=n=${files.length}:v=1:a=0[v]`, "-map", "[v]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out);
  await run("ffmpeg", args);
}
