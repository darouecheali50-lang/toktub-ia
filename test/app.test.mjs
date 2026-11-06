// Tests de bout en bout du serveur avec un fournisseur IA simulé
// (aucun appel réel ni crédit consommé). Lancer : npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
import { loadConfig } from "../src/config.js";
import { makeFixtures, probeJson, firstSoundAt } from "./helpers.mjs";

let fx;
before(() => { fx = makeFixtures(); });
after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

function cfgWith(over = {}) {
  const cfg = loadConfig({ FAL_KEY: "cle-factice", FREE_CREDITS: "1000" });
  return { ...cfg, creditUsd: 0.07, galleryDir: fs.mkdtempSync(path.join(os.tmpdir(), "ds-gal-")), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ds-data-")), pollIntervalMs: 30, ...over };
}

// Fournisseur simulé : reproduit la séquence de statuts documentée par fal.
function fakeProvider({ output, fail, calls = { uploads: [], deleted: [], cancelled: 0, inputs: [], models: [] } } = {}) {
  let polls = 0;
  return {
    calls,
    factory: () => ({
      async uploadFile(p, mime) {
        assert.ok(fs.existsSync(p), "le fichier à envoyer doit exister");
        calls.uploads.push({ p, mime, info: mime.startsWith("video") ? probeJson(p) : null });
        return `https://cdn.exemple/${path.basename(p)}`;
      },
      async submit(model, input) { calls.models.push(model); calls.inputs.push(input); return { request_id: "r1", status_url: "s", response_url: "r", cancel_url: "c", queue_position: 2 }; },
      async status() {
        polls++;
        if (polls <= 2) return { status: "IN_QUEUE", queue_position: 2 - polls };
        if (polls <= 4) return { status: "IN_PROGRESS" };
        return fail ? { status: "COMPLETED", error: fail, error_type: "runner_error" } : { status: "COMPLETED", metrics: { inference_time: 42 } };
      },
      async result() { return output.endsWith(".jpg") ? { imageUrl: "https://cdn.exemple/img.jpg" } : { videoUrl: "https://cdn.exemple/sortie.mp4" }; },
      async download(_url, dest) { fs.copyFileSync(output, dest); },
      async cancel() { calls.cancelled++; },
      async deleteFile(u) { calls.deleted.push(u); return true; },
    }),
  };
}

async function start(cfg, provider) {
  const app = await createApp(cfg, { providerFactory: provider?.factory });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const signup = async (email = `client${Math.random().toString(36).slice(2)}@exemple.fr`, password = "motdepasse-solide") => {
    const r = await fetch(base + "/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });
    return { status: r.status, body: await r.json(), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
  };
  const me = await signup();
  const s = { app, base, signup, cookie: me.cookie, user: me.body.user };
  s.req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Cookie: s.cookie, ...(opts.headers || {}) } });
  s.up = async (kind, file, headers = {}) => {
    const r = await s.req(`/api/uploads/${kind}`, { method: "PUT", body: fs.readFileSync(file), headers });
    return { status: r.status, body: await r.json() };
  };
  s.close = () => app.close();
  return s;
}

async function waitJob(s, id) {
  for (let i = 0; i < 400; i++) {
    const j = await (await s.req(`/api/jobs/${id}`)).json();
    if (["termine", "erreur"].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("délai dépassé");
}

test("sans clé API : « Service vidéo non configuré » et génération refusée", async () => {
  const cfg = { ...cfgWith(), falKey: "" };
  const s = await start(cfg);
  try {
    const st = await (await fetch(s.base + "/api/status")).json();
    assert.equal(st.configured, false);
    assert.ok(st.missing.includes("FAL_KEY"));
    assert.equal(JSON.stringify(st).includes("cle-factice"), false, "aucun secret exposé");
    const r = await s.req("/api/jobs", { method: "POST", body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "Service vidéo non configuré.");
  } finally { s.close(); }
});

test("comptes : inscription, connexion, routes protégées, données séparées entre clients", async () => {
  const s = await start(cfgWith({ freeCredits: 3 }));
  try {
    assert.equal(s.user.credits, 3, "crédits offerts à l'inscription");
    assert.equal((await fetch(s.base + "/api/jobs")).status, 401, "sans compte : refusé");
    assert.equal((await s.signup("x", "court")).status, 400);
    const email = "lea@exemple.fr";
    assert.equal((await s.signup(email, "motdepasse-solide")).status, 201);
    assert.equal((await s.signup(email, "autre-motdepasse")).status, 400, "pas de doublon");
    const bad = await fetch(s.base + "/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "mauvais-mot" }) });
    assert.equal(bad.status, 401);
    const ok = await fetch(s.base + "/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "motdepasse-solide" }) });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    await s.app.db.flush();
    const raw = fs.readFileSync(path.join(s.app.uploads.dir, "..", "db.json"), "utf8");
    assert.equal(raw.includes("motdepasse-solide"), false, "mot de passe jamais stocké en clair");
    // Requête venant d'un autre site refusée.
    const cross = await s.req("/api/jobs", { method: "POST", body: "{}", headers: { Origin: "https://pirate.exemple" } });
    assert.equal(cross.status, 403);
    // Un autre client ne voit pas les fichiers du premier.
    const v = (await s.up("video", fx.f("danse.mp4"))).body;
    const other = await s.signup();
    const r = await fetch(s.base + "/api/jobs", { method: "POST", headers: { Cookie: other.cookie }, body: JSON.stringify({ tool: "move", videoId: v.id, imageId: "x" }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Vidéo introuvable/);
  } finally { s.close(); }
});

test("crédits : débités avant la génération, refusés si insuffisants, recrédités en cas d'échec", async () => {
  const fp = fakeProvider({ output: fx.f("perso-ia.jpg") });
  const s = await start(cfgWith({ freeCredits: 6 }), fp);
  try {
    // Vidéo 10 s = 10 crédits > 6 : refusée sans appel au fournisseur.
    const r = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "un chat", duration: "10" }) });
    assert.equal(r.status, 402);
    assert.match((await r.json()).error, /Crédits insuffisants.*10 crédits.*il vous en reste 6/);
    assert.equal(fp.calls.models.length, 0);
    // Image = 1 crédit.
    const j = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "image", prompt: "un robot" }) })).json();
    assert.equal(j.credits, 1);
    assert.equal(j.me.credits, 5);
    await waitJob(s, j.id);
  } finally { s.close(); }

  const fail = fakeProvider({ output: fx.f("sortie-ia.mp4"), fail: "panne" });
  const s2 = await start(cfgWith({ freeCredits: 6 }), fail);
  try {
    const j = await (await s2.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "un chat", duration: "5" }) })).json();
    assert.equal(j.me.credits, 1);
    const done = await waitJob(s2, j.id);
    assert.equal(done.state, "erreur");
    await new Promise((r) => setTimeout(r, 50));
    const me = (await (await s2.req("/api/me")).json()).user;
    assert.equal(me.credits, 6, "crédits rendus après l'échec");
  } finally { s2.close(); }
});

test("administrateur : crédits illimités", async () => {
  const s = await start(cfgWith({ freeCredits: 0, adminEmails: ["patron@exemple.fr"] }), fakeProvider({ output: fx.f("perso-ia.jpg") }));
  try {
    const admin = await s.signup("patron@exemple.fr");
    assert.equal(admin.body.user.unlimited, true);
    const r = await fetch(s.base + "/api/jobs", { method: "POST", headers: { Cookie: admin.cookie }, body: JSON.stringify({ tool: "image", prompt: "un robot" }) });
    assert.equal(r.status, 202);
    const normal = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "image", prompt: "un robot" }) });
    assert.equal(normal.status, 402, "un client sans crédit ne peut pas générer");
  } finally { s.close(); }
});

test("validation des imports : type, taille, durée, dimensions", async () => {
  const s = await start(cfgWith({ maxAudioMB: 0.01 }));
  try {
    let r = await s.up("video", fx.f("faux.mp4"));
    assert.equal(r.status, 415);
    r = await s.up("video", fx.f("perso.png"));
    assert.equal(r.status, 415, "une image envoyée comme vidéo est refusée");
    r = await s.up("video", fx.f("longue.mp4"));
    assert.equal(r.status, 422);
    assert.match(r.body.error, /trop longue.*35\.0 s.*n'est pas coupée/);
    r = await s.up("image", fx.f("mini.png"));
    assert.equal(r.status, 422);
    r = await s.up("audio", fx.f("musique.mp3"));
    assert.equal(r.status, 413);
    r = await s.up("video", fx.f("danse.mp4"));
    assert.equal(r.status, 201);
    assert.equal(r.body.hasAudio, true);
    assert.equal(Math.round(r.body.fps), 25);
    // Formule fal : 4 s × 25 i/s ÷ 16 = 6,25 s facturées × 0,06 $ (580p) = 0,375 $
    const est = async (resolution) => (await (await s.req("/api/estimate", { method: "POST", body: JSON.stringify({ tool: "move", videoId: r.body.id, resolution, fluidite: "origine" }) })).json()).estimate;
    assert.equal((await est("580p")).usd, 0.38);
    assert.equal((await est("720p")).usd, 0.5);
    const left = fs.readdirSync(path.join(s.app.uploads.dir));
    assert.equal(left.length, 1, "les fichiers refusés sont supprimés immédiatement");
  } finally { s.close(); }
});

test("génération complète : états réels, musique d'origine synchronisée, nettoyage", async () => {
  const fp = fakeProvider({ output: fx.f("sortie-ia.mp4") });
  const cfg = cfgWith();
  const s = await start(cfg, fp);
  try {
    const v = (await s.up("video", fx.f("danse.mp4"))).body;
    const i = (await s.up("image", fx.f("perso.png"))).body;
    const r = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id, resolution: "720p" }) });
    assert.equal(r.status, 202);
    const created = await r.json();
    const seen = new Set([created.state]);
    let j;
    for (;;) {
      j = await (await s.req(`/api/jobs/${created.id}`)).json();
      seen.add(j.state);
      if (["termine", "erreur"].includes(j.state)) break;
      await new Promise((res) => setTimeout(res, 5));
    }
    assert.equal(j.state, "termine", j.error);
    assert.ok(seen.has("attente") && seen.has("generation"), `états observés : ${[...seen]}`);

    // Ce qui est envoyé à l'IA : vidéo MP4 sans son + image, paramètres documentés.
    assert.equal(fp.calls.models[0], "fal-ai/wan/v2.2-14b/animate/move");
    assert.equal(fp.calls.uploads[0].mime, "video/mp4");
    assert.equal(fp.calls.uploads[0].info.streams.some((x) => x.codec_type === "audio"), false);
    assert.deepEqual(fp.calls.inputs[0], {
      video_url: fp.calls.inputs[0].video_url, image_url: fp.calls.inputs[0].image_url, resolution: "720p", enable_safety_checker: true,
    });

    // Vidéo finale : flux vidéo de l'IA + piste audio d'origine, bip toujours à 2,0 s.
    const vid = await s.req(j.result.url);
    assert.equal(vid.status, 200);
    const out = path.join(fx.dir, "final.mp4");
    fs.writeFileSync(out, Buffer.from(await vid.arrayBuffer()));
    const info = probeJson(out);
    const vs = info.streams.find((x) => x.codec_type === "video");
    const as = info.streams.find((x) => x.codec_type === "audio");
    assert.ok(as, "piste audio présente");
    assert.equal(vs.r_frame_rate, "16/1", "le flux vidéo de l'IA est conservé tel quel");
    assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.15, `durée ${info.format.duration}`);
    const onset = firstSoundAt(out);
    assert.ok(onset != null && Math.abs(onset - 2.0) < 0.06, `bip attendu à 2,0 s, mesuré à ${onset}`);
    assert.equal(j.result.hasAudio, true);
    assert.equal(j.inferenceSeconds, 42);

    // Lecture partielle (iPhone/Safari) et téléchargement.
    const part = await s.req(j.result.url, { headers: { Range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const dl = await s.req(j.result.downloadUrl);
    assert.match(dl.headers.get("content-disposition"), /attachment/);
    await dl.arrayBuffer();
    assert.equal((await s.req(`/api/jobs/${j.id}/file?t=mauvais`)).status, 404);

    // Nettoyage : imports supprimés, copies distantes supprimées, seul le résultat reste.
    assert.deepEqual(fs.readdirSync(s.app.uploads.dir), []);
    assert.equal(fp.calls.deleted.length, 2);
    const jobDir = s.app.jobs.get(j.id).dir;
    assert.deepEqual(fs.readdirSync(jobDir), ["creation.mp4"]);
    // « Nouvelle création » supprime aussi le résultat.
    await s.req(`/api/jobs/${j.id}`, { method: "DELETE" });
    assert.equal(fs.existsSync(jobDir), false);
  } finally { s.close(); }
});

test("musique de remplacement : ajustée à la durée de la vidéo, avec avertissement", async () => {
  const s = await start(cfgWith(), fakeProvider({ output: fx.f("sortie-ia.mp4") }));
  try {
    const v = (await s.up("video", fx.f("danse.webm"))).body; // WebM : converti avant envoi
    const i = (await s.up("image", fx.f("perso.png"))).body;
    const a = (await s.up("audio", fx.f("musique.mp3"))).body;
    const created = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id, audioId: a.id }) })).json();
    assert.ok(created.warnings.some((w) => /plus longue que la vidéo/.test(w)), "l'utilisateur est prévenu");
    const j = await waitJob(s, created.id);
    assert.equal(j.state, "termine", j.error);
    assert.equal(j.audioMode, "remplacement");
    assert.ok(Math.abs(j.result.durationSec - 4) < 0.15, `durée ${j.result.durationSec}`);
    assert.equal(j.params.resolution, "580p", "résolution par défaut");
  } finally { s.close(); }
});

test("vidéo IA plus courte que la source : signalée, la musique n'est pas coupée", async () => {
  const s = await start(cfgWith(), fakeProvider({ output: fx.f("sortie-courte.mp4") }));
  try {
    const v = (await s.up("video", fx.f("danse.mp4"))).body;
    const i = (await s.up("image", fx.f("perso.png"))).body;
    const created = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id }) })).json();
    const j = await waitJob(s, created.id);
    assert.equal(j.state, "termine", j.error);
    assert.ok(j.warnings.some((w) => /3\.0 s pour une source de 4\.0 s/.test(w)));
    assert.ok(j.result.durationSec > 3.9, "audio d'origine conservé en entier");
  } finally { s.close(); }
});

test("vidéo sans son : avertissement et résultat muet assumé", async () => {
  const s = await start(cfgWith(), fakeProvider({ output: fx.f("sortie-ia.mp4") }));
  try {
    const v = (await s.up("video", fx.f("muette.mp4"))).body;
    const i = (await s.up("image", fx.f("perso.png"))).body;
    const created = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id }) })).json();
    assert.ok(created.warnings.some((w) => /muet/.test(w)));
    const j = await waitJob(s, created.id);
    assert.equal(j.state, "termine", j.error);
    assert.equal(j.result.hasAudio, false);
  } finally { s.close(); }
});

test("erreur du service IA : état « erreur » avec le message, aucun faux succès, nettoyage", async () => {
  const fp = fakeProvider({ output: fx.f("sortie-ia.mp4"), fail: "Contenu refusé par le filtre de sécurité" });
  const s = await start(cfgWith(), fp);
  try {
    const v = (await s.up("video", fx.f("danse.mp4"))).body;
    const i = (await s.up("image", fx.f("perso.png"))).body;
    const created = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id }) })).json();
    const j = await waitJob(s, created.id);
    assert.equal(j.state, "erreur");
    assert.match(j.error, /runner_error.*filtre de sécurité/);
    assert.equal(j.result, null);
    for (let k = 0; k < 40 && (fs.readdirSync(s.app.uploads.dir).length || fs.existsSync(s.app.jobs.get(j.id).dir)); k++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(fs.readdirSync(s.app.uploads.dir), []);
    assert.equal(fs.existsSync(s.app.jobs.get(j.id).dir), false);
    // Les fichiers déjà utilisés ne peuvent pas relancer une génération par erreur.
    const again = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id }) });
    assert.equal(again.status, 400);
  } finally { s.close(); }
});

test("limites de coût : une génération à la fois et plafond quotidien", async () => {
  const s = await start(cfgWith({ dailyJobLimit: 1, pollIntervalMs: 2000 }), fakeProvider({ output: fx.f("sortie-ia.mp4") }));
  try {
    const ids = async () => ({ v: (await s.up("video", fx.f("danse.mp4"))).body.id, i: (await s.up("image", fx.f("perso.png"))).body.id });
    const a = await ids();
    assert.equal((await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: a.v, imageId: a.i }) })).status, 202);
    const b = await ids();
    const r = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: b.v, imageId: b.i }) });
    assert.equal(r.status, 429);
  } finally { s.close(); }
});

test("créer un personnage avec l'IA, puis lui faire reprendre la danse et la musique (Move et Mix)", async () => {
  // Un fournisseur unique qui renvoie une image pour FLUX et une vidéo pour Wan.
  const calls = { models: [], inputs: [], uploads: [] };
  let polls = 0;
  const provider = () => ({
    async uploadFile(p, mime) { calls.uploads.push(mime); return `https://cdn/${path.basename(p)}`; },
    async submit(model, input) { calls.models.push(model); calls.inputs.push(input); polls = 0; return { status_url: "s", response_url: "r", cancel_url: "c" }; },
    async status() { return ++polls < 2 ? { status: "IN_PROGRESS" } : { status: "COMPLETED" }; },
    async result() { return calls.models.at(-1) === "fal-ai/flux/schnell" ? { imageUrl: "x" } : { videoUrl: "y" }; },
    async download(_u, dest) { fs.copyFileSync(dest.endsWith(".jpg") ? fx.f("perso-ia.jpg") : fx.f("sortie-ia.mp4"), dest); },
    async cancel() {}, async deleteFile() { return true; },
  });
  const s2 = await start(cfgWith(), { factory: provider });
  try {
    // 1. Personnage généré par texte.
    const r = await s2.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "image", prompt: "un robot doré, en pied", image_size: "portrait_16_9" }) });
    assert.equal(r.status, 202);
    const img = await waitJob(s2, (await r.json()).id);
    assert.equal(img.state, "termine", img.error);
    assert.equal(img.kind, "image");
    assert.equal(img.result.mime, "image/jpeg");
    assert.deepEqual(calls.inputs[0], { prompt: "un robot doré, en pied", image_size: "portrait_16_9", num_images: 1, output_format: "jpeg", enable_safety_checker: true });
    const imgFile = await s2.req(img.result.url);
    assert.equal(imgFile.headers.get("content-type"), "image/jpeg");
    await imgFile.arrayBuffer();

    for (const toolId of ["move", "mix"]) {
      // 2. Le personnage est réutilisé comme photo (copie : l'original reste dans « Mes créations »).
      const reuse = await s2.req(`/api/jobs/${img.id}/reuse`, { method: "POST" });
      assert.equal(reuse.status, 201);
      const perso = await reuse.json();
      assert.equal(perso.kind, "image");
      assert.equal(perso.width, 576);

      // 3. Danse de référence avec musique : même mouvement, même musique.
      const v = (await s2.up("video", fx.f("danse.mp4"))).body;
      const job = await (await s2.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: toolId, videoId: v.id, imageId: perso.id }) })).json();
      const done = await waitJob(s2, job.id);
      assert.equal(done.state, "termine", done.error);
      assert.equal(calls.models.at(-1), toolId === "move" ? "fal-ai/wan/v2.2-14b/animate/move" : "fal-ai/wan/v2.2-14b/animate/replace");
      assert.equal(done.audioMode, "original");
      const out = path.join(fx.dir, `perso-${toolId}.mp4`);
      fs.writeFileSync(out, Buffer.from(await (await s2.req(done.result.url)).arrayBuffer()));
      const onset = firstSoundAt(out);
      assert.ok(onset != null && Math.abs(onset - 2.0) < 0.06, `${toolId} : bip attendu à 2,0 s, mesuré à ${onset}`);
    }
    // L'image d'origine est toujours téléchargeable.
    assert.equal((await s2.req(img.result.url)).status, 200);
    const list = await (await s2.req("/api/jobs")).json();
    assert.equal(list.jobs.length, 3);
  } finally { s2.close(); }
});

test("vidéo à partir d'un texte : prompt obligatoire, paramètres vérifiés, pas de musique ajoutée", async () => {
  const fp = fakeProvider({ output: fx.f("sortie-ia.mp4") });
  const s = await start(cfgWith(), fp);
  try {
    const bad = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "   " }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /prompt/);
    const unknown = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "pirate" }) });
    assert.equal(unknown.status, 400);
    const r = await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "un chat qui danse", duration: "99", aspect_ratio: "9:16" }) });
    const j = await waitJob(s, (await r.json()).id);
    assert.equal(j.state, "termine", j.error);
    assert.equal(fp.calls.models[0], "fal-ai/kling-video/v2.5-turbo/pro/text-to-video");
    assert.deepEqual(fp.calls.inputs[0], { prompt: "un chat qui danse", duration: "5", aspect_ratio: "9:16", enable_safety_checker: true });
    assert.equal(j.estimate.usd, 0.35);
    assert.equal(j.audioMode, null);
    // La vidéo générée peut servir de danse de référence.
    const reuse = await s.req(`/api/jobs/${j.id}/reuse`, { method: "POST" });
    assert.equal((await reuse.json()).kind, "video");
  } finally { s.close(); }
});

test("vidéo de 15 s : deux morceaux enchaînés (texte → vidéo puis image → vidéo depuis la dernière image), assemblés", async () => {
  const fp = fakeProvider({ output: fx.f("sortie-ia.mp4") });
  const s = await start(cfgWith(), fp);
  try {
    const j = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "une danse", duration: "15", aspect_ratio: "9:16" }) })).json();
    assert.equal(j.credits, 15);
    const done = await waitJob(s, j.id);
    assert.equal(done.state, "termine", done.error);
    assert.deepEqual(fp.calls.models, ["fal-ai/kling-video/v2.5-turbo/pro/text-to-video", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"]);
    assert.equal(fp.calls.inputs[0].duration, "10");
    assert.equal(fp.calls.inputs[1].duration, "5");
    assert.match(fp.calls.inputs[1].image_url, /suite-1\.jpg$/, "la suite part de la dernière image");
    assert.equal(done.segment.total, 2);
    // Les deux morceaux simulés font 4 s chacun : la vidéo finale fait 8 s.
    assert.ok(Math.abs(done.result.durationSec - 8) < 0.3, `durée ${done.result.durationSec}`);
  } finally { s.close(); }
});

test("Stripe : paiement, signature du webhook vérifiée, crédits attribués une seule fois, résiliation", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ url: url.includes("checkout") ? "https://checkout.stripe.com/c/pay/cs_test" : "https://billing.stripe.com/p/session" }), { status: 200 });
  };
  const cfg = cfgWith({ freeCredits: 0, publicUrl: "https://danse.exemple" });
  cfg.stripe = { secretKey: "sk_test_x", webhookSecret: "whsec_test", prices: { basique_month: "price_bm", basique_year: "price_by", pro_month: "price_pm", pro_year: "price_py" } };
  const app = await createApp(cfg, { fetchImpl });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const su = await fetch(base + "/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "client@exemple.fr", password: "motdepasse-solide" }) });
    const cookie = su.headers.get("set-cookie").split(";")[0];
    const userId = (await su.json()).user.id;
    const co = await fetch(base + "/api/billing/checkout", { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ plan: "pro", interval: "month" }) });
    assert.equal((await co.json()).url, "https://checkout.stripe.com/c/pay/cs_test");
    const b = sent[0].body;
    assert.equal(sent[0].url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(b.get("mode"), "subscription");
    assert.equal(b.get("line_items[0][price]"), "price_pm");
    assert.equal(b.get("client_reference_id"), userId);
    assert.equal(b.get("subscription_data[metadata][plan]"), "pro");
    assert.equal(b.get("success_url"), "https://danse.exemple/#compte?paiement=ok&session={CHECKOUT_SESSION_ID}");

    const hook = async (event, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) => {
      const raw = JSON.stringify(event);
      const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
      return fetch(base + "/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${sig}` }, body: raw });
    };
    const meCredits = async () => (await (await fetch(base + "/api/me", { headers: { Cookie: cookie } })).json()).user;

    // Signature falsifiée ou trop ancienne : refusée.
    assert.equal((await hook({ id: "evt_0", type: "invoice.paid", data: { object: {} } }, "whsec_faux")).status, 400);
    assert.equal((await hook({ id: "evt_0", type: "invoice.paid", data: { object: {} } }, "whsec_test", 1000)).status, 400);

    await hook({ id: "evt_1", type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: userId, customer: "cus_1", subscription: "sub_1", metadata: { plan: "pro", interval: "month" } } } });
    // Format API 2025-03-31.basil : métadonnées dans invoice.parent.subscription_details.
    const invoice = { id: "evt_2", type: "invoice.paid", data: { object: { customer: "cus_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { user_id: userId, plan: "pro", interval: "month" } } } } } };
    await hook(invoice);
    let u = await meCredits();
    assert.equal(u.credits, 80);
    assert.equal(u.plan, "pro");
    assert.equal(u.canManageBilling, true);
    // Même événement renvoyé par Stripe : pas de double crédit.
    await hook(invoice);
    assert.equal((await meCredits()).credits, 80);

    const portal = await fetch(base + "/api/billing/portal", { method: "POST", headers: { Cookie: cookie } });
    assert.equal((await portal.json()).url, "https://billing.stripe.com/p/session");
    assert.equal(sent[1].body.get("customer"), "cus_1");

    // Ancien format (invoice.subscription_details) : annuel = 12 mois d'un coup.
    await hook({ id: "evt_3", type: "invoice.paid", data: { object: { customer: "cus_1", subscription_details: { metadata: { user_id: userId, plan: "basique", interval: "year" } } } } });
    assert.equal((await meCredits()).credits, 600);

    await hook({ id: "evt_4", type: "customer.subscription.deleted", data: { object: { customer: "cus_1", metadata: { user_id: userId } } } });
    u = await meCredits();
    assert.equal(u.plan, null);
    assert.equal(u.subscriptionStatus, "canceled");
  } finally { app.close(); }
});

test("configuration depuis la page : clé enregistrée dans .env, seulement en local et une seule fois", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-root-"));
  fs.cpSync(path.resolve("public"), path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, ".env"), "FAL_KEY=\r\nAPP_ACCESS_CODE=\r\nPORT=3000\r\n");
  const cfg = { ...cfgWith(), root, falKey: "" };
  const app = await createApp(cfg);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal((await (await fetch(base + "/api/status")).json()).setupAvailable, true);
    const bad = await fetch(base + "/api/setup", { method: "POST", body: JSON.stringify({ falKey: "court" }) });
    assert.equal(bad.status, 400);
    const proxied = await fetch(base + "/api/setup", { method: "POST", headers: { "X-Forwarded-For": "8.8.8.8" }, body: JSON.stringify({ falKey: "fal_sk_abcdefghijklmnop1234" }) });
    assert.equal(proxied.status, 403, "refusé si la requête vient d'internet");
    const ok = await fetch(base + "/api/setup", { method: "POST", body: JSON.stringify({ falKey: "fal_sk_abcdefghijklmnop1234", adminEmail: "Patron@Exemple.fr" }) });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.status.configured, true);
    assert.equal(JSON.stringify(body).includes("fal_sk_abcdefghijklmnop1234"), false, "clé jamais renvoyée");
    const env = fs.readFileSync(path.join(root, ".env"), "utf8");
    assert.match(env, /^FAL_KEY=fal_sk_abcdefghijklmnop1234\r$/m);
    assert.match(env, /^ADMIN_EMAILS=patron@exemple\.fr\r$/m);
    assert.equal(env.includes("APP_ACCESS_CODE"), false);
    assert.match(env, /PORT=3000/);
    const again = await fetch(base + "/api/setup", { method: "POST", body: JSON.stringify({ falKey: "fal_sk_autreclefautre12345" }) });
    assert.equal(again.status, 403, "impossible de remplacer la clé une fois configurée");
    const admin = await (await fetch(base + "/api/auth/signup", { method: "POST", body: JSON.stringify({ email: "patron@exemple.fr", password: "motdepasse-solide" }) })).json();
    assert.equal(admin.user.unlimited, true);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("brancher Stripe depuis Mon compte : réservé à l'admin, 4 prix créés, retour de paiement crédité une seule fois", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-root-"));
  fs.cpSync(path.resolve("public"), path.join(root, "public"), { recursive: true });
  fs.copyFileSync(path.resolve(".env.example"), path.join(root, ".env.example"));
  fs.writeFileSync(path.join(root, ".env"), "FAL_KEY=fal_sk_x\nADMIN_EMAILS=patron@exemple.fr\n");
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, body: init.body ? new URLSearchParams(init.body) : null, version: init.headers["Stripe-Version"] });
    if (url.endsWith("/prices")) return new Response(JSON.stringify({ id: `price_${++n}` }));
    if (url.endsWith("/webhook_endpoints")) return new Response(JSON.stringify({ id: "we_1", secret: "whsec_auto" }));
    if (url.includes("/checkout/sessions/cs_test_ok")) return new Response(JSON.stringify({ id: "cs_test_ok", status: "complete", payment_status: "paid", client_reference_id: globalThis.__uid, customer: "cus_9", subscription: "sub_9", invoice: "in_9", mode: "subscription", metadata: { plan: "basique", interval: "month" } }));
    return new Response(JSON.stringify({ url: "https://checkout.stripe.com/x" }));
  };
  const cfg = { ...cfgWith({ freeCredits: 0, adminEmails: ["patron@exemple.fr"] }), root };
  const app = await createApp(cfg, { fetchImpl });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const signup = async (email) => {
    const r = await fetch(base + "/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password: "motdepasse-solide" }) });
    return { cookie: r.headers.get("set-cookie").split(";")[0], user: (await r.json()).user };
  };
  try {
    const client = await signup("client@exemple.fr");
    globalThis.__uid = client.user.id;
    const refused = await fetch(base + "/api/admin/stripe", { method: "POST", headers: { Cookie: client.cookie }, body: JSON.stringify({ secretKey: "sk_test_abcdefghijklmnop" }) });
    assert.equal(refused.status, 403, "un client ne peut pas brancher Stripe");
    const admin = await signup("patron@exemple.fr");
    const bad = await fetch(base + "/api/admin/stripe", { method: "POST", headers: { Cookie: admin.cookie }, body: JSON.stringify({ secretKey: "pk_test_publique" }) });
    assert.equal(bad.status, 400, "clé publique refusée");
    const ok = await fetch(base + "/api/admin/stripe", { method: "POST", headers: { Cookie: admin.cookie }, body: JSON.stringify({ secretKey: "sk_test_abcdefghijklmnop", publicUrl: "https://danse.exemple/" }) });
    const body = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(body.status.billing, true);
    assert.equal(body.webhook, true);
    assert.equal(JSON.stringify(body).includes("sk_test_abcdefghijklmnop"), false, "clé jamais renvoyée");
    const prices = sent.filter((x) => x.url.endsWith("/prices"));
    assert.equal(prices.length, 4);
    assert.deepEqual(prices.map((x) => x.body.get("unit_amount")), ["600", "6000", "900", "9000"]);
    assert.deepEqual(prices.map((x) => x.body.get("recurring[interval]")), ["month", "year", "month", "year"]);
    assert.equal(prices[0].version, "2025-03-31.basil");
    const wh = sent.find((x) => x.url.endsWith("/webhook_endpoints"));
    assert.equal(wh.body.get("url"), "https://danse.exemple/api/stripe/webhook");
    assert.deepEqual(wh.body.getAll("enabled_events[0]"), ["checkout.session.completed"]);
    const env = fs.readFileSync(path.join(root, ".env"), "utf8");
    assert.match(env, /STRIPE_SECRET_KEY=sk_test_abcdefghijklmnop/);
    assert.match(env, /STRIPE_PRICE_PRO_AN=price_4/);
    assert.match(env, /STRIPE_WEBHOOK_SECRET=whsec_auto/);
    assert.match(env, /FAL_KEY=fal_sk_x/, "clé fal conservée");

    // Retour du client après paiement (sans attendre le webhook).
    const conf = await (await fetch(base + "/api/billing/confirm", { method: "POST", headers: { Cookie: client.cookie }, body: JSON.stringify({ session: "cs_test_ok" }) })).json();
    assert.equal(conf.confirmed, true);
    assert.equal(conf.user.credits, 50);
    assert.equal(conf.user.plan, "basique");
    // Le webhook de la même facture arrive ensuite : pas de double crédit.
    app.accounts && (app.db.data.users[client.user.id].credits = 20); // le client a utilisé 30 crédits
    await app.billing.handleEvent({ id: "evt_x", type: "invoice.paid", data: { object: { id: "in_9", customer: "cus_9", parent: { subscription_details: { metadata: { user_id: client.user.id, plan: "basique", interval: "month" } } } } } });
    assert.equal(app.db.data.users[client.user.id].credits, 20, "facture déjà créditée au retour de paiement");
    // Un autre client ne peut pas utiliser cette session.
    const other = await signup("autre@exemple.fr");
    const steal = await fetch(base + "/api/billing/confirm", { method: "POST", headers: { Cookie: other.cookie }, body: JSON.stringify({ session: "cs_test_ok" }) });
    assert.equal(steal.status, 403);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("redémarrage pendant une création : le suivi reprend, le résultat est récupéré avec la musique, les créations restent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-data-"));
  const cfg = { ...cfgWith(), dataDir };
  // 1er serveur : fal ne termine jamais (on redémarre avant).
  const slow = { factory: () => ({
    async uploadFile(p) { return `https://cdn/${path.basename(p)}`; },
    async submit() { return { request_id: "r9", status_url: "https://queue.fal.run/x/requests/r9/status", response_url: "https://queue.fal.run/x/requests/r9", cancel_url: "c" }; },
    async status() { return { status: "IN_PROGRESS" }; },
    async result() { throw new Error("pas encore"); }, async download() {}, async cancel() {}, async deleteFile() { return true; },
  }) };
  const s1 = await start(cfg, slow);
  const cookie = s1.cookie;
  const v = (await s1.up("video", fx.f("danse.mp4"))).body;
  const i = (await s1.up("image", fx.f("perso.png"))).body;
  const job = await (await s1.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.id, imageId: i.id }) })).json();
  for (let k = 0; k < 100 && s1.app.jobs.get(job.id).state !== "generation"; k++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(s1.app.jobs.get(job.id).state, "generation");
  await s1.app.jobs.flush();
  await s1.close();

  // 2e serveur, même dossier de données : fal a terminé entre-temps.
  let polled = null;
  const done = { factory: () => ({
    async uploadFile() { throw new Error("ne doit pas renvoyer les fichiers"); },
    async submit() { throw new Error("ne doit pas relancer (et repayer) la création"); },
    async status(task) { polled = task.status_url; return { status: "COMPLETED" }; },
    async result() { return { videoUrl: "y" }; },
    async download(_u, dest) { fs.copyFileSync(fx.f("sortie-ia.mp4"), dest); },
    async cancel() {}, async deleteFile() { return true; },
  }) };
  const app2 = await createApp(cfg, { providerFactory: done.factory });
  await new Promise((r) => app2.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    let j;
    for (let k = 0; k < 200; k++) {
      j = await (await fetch(`${base}/api/jobs/${job.id}`, { headers: { Cookie: cookie } })).json();
      if (["termine", "erreur"].includes(j.state)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(j.state, "termine", j.error);
    assert.equal(polled, "https://queue.fal.run/x/requests/r9/status", "suivi de la même tâche fal");
    assert.ok(j.warnings.some((w) => /redémarré/.test(w)));
    const out = path.join(fx.dir, "repris.mp4");
    fs.writeFileSync(out, Buffer.from(await (await fetch(base + j.result.url)).arrayBuffer()));
    const onset = firstSoundAt(out);
    assert.ok(onset != null && Math.abs(onset - 2.0) < 0.06, `musique synchronisée, bip à ${onset}`);
    await app2.jobs.flush();
  } finally { await app2.close(); }

  // 3e serveur : la création terminée est toujours dans « Mes créations ».
  const app3 = await createApp(cfg, { providerFactory: done.factory });
  await new Promise((r) => app3.server.listen(0, "127.0.0.1", r));
  try {
    const list = await (await fetch(`http://127.0.0.1:${app3.server.address().port}/api/jobs`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.jobs.length, 1);
  } finally { await app3.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("redémarrage avant l'envoi à fal : création marquée en erreur et crédits rendus", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ds-data-"));
  const cfg = { ...cfgWith({ freeCredits: 10 }), dataDir };
  const hang = { factory: () => ({ uploadFile: () => new Promise(() => {}), submit: () => new Promise(() => {}), async deleteFile() { return true; }, async cancel() {} }) };
  const s1 = await start(cfg, hang);
  const cookie = s1.cookie;
  const job = await (await s1.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "x", duration: "5" }) })).json();
  assert.equal(job.me.credits, 5);
  await new Promise((r) => setTimeout(r, 100));
  await s1.app.jobs.flush();
  await s1.close();
  const app2 = await createApp(cfg, { providerFactory: hang.factory });
  await new Promise((r) => app2.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    await new Promise((r) => setTimeout(r, 100));
    const j = await (await fetch(`${base}/api/jobs/${job.id}`, { headers: { Cookie: cookie } })).json();
    assert.equal(j.state, "erreur");
    assert.match(j.error, /redémarrage/);
    const me = (await (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).json()).user;
    assert.equal(me.credits, 10, "crédits rendus");
  } finally { await app2.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test("personnalisation : nom, textes, prix du crédit et images des cartes, réservés à l'admin", async () => {
  const cfg = cfgWith({ adminEmails: ["patron@exemple.fr"] });
  const s = await start(cfg, fakeProvider({ output: fx.f("perso-ia.jpg") }));
  try {
    const admin = await s.signup("patron@exemple.fr");
    const A = (p, o = {}) => fetch(s.base + p, { ...o, headers: { Cookie: admin.cookie, ...(o.headers || {}) } });
    // Un client ne peut rien modifier.
    assert.equal((await s.req("/api/admin/settings", { method: "POST", body: JSON.stringify({ appName: "Pirate" }) })).status, 403);
    assert.equal((await s.req("/api/admin/cards/move/image", { method: "PUT", body: fs.readFileSync(fx.f("perso-ia.jpg")) })).status, 403);
    // L'admin change le nom, la phrase et la valeur du crédit.
    const r = await (await A("/api/admin/settings", { method: "POST", body: JSON.stringify({ appName: "Zaher Dance", tagline: "Faites danser vos photos", creditUsd: 0.14, cards: { move: { title: "Danse IA" } } }) })).json();
    assert.equal(r.status.settings.appName, "Zaher Dance");
    assert.equal(r.status.settings.cards.move.title, "Danse IA");
    const st = await (await fetch(s.base + "/api/status")).json();
    assert.equal(st.settings.tagline, "Faites danser vos photos");
    assert.equal(st.creditExamples[2][1], 5, "vidéo 10 s (0,70 $) à 0,14 $ le crédit = 5 crédits");
    assert.equal(st.creditExamples[0].length, 2, "le coût fal n'est pas montré aux visiteurs");
    const job = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "video", prompt: "un chat", duration: "10" }) })).json();
    assert.equal(job.credits, 5);
    assert.equal((await A("/api/admin/settings", { method: "POST", body: JSON.stringify({ creditUsd: 5 }) })).status, 400);
    // Image de carte : glisser-déposer (fichier vérifié) puis servie au public.
    assert.equal((await A("/api/admin/cards/move/image", { method: "PUT", body: "pas une image".repeat(5) })).status, 415);
    const up = await (await A("/api/admin/cards/move/image", { method: "PUT", body: fs.readFileSync(fx.f("perso-ia.jpg")) })).json();
    const url = up.status.settings.cards.move.image;
    assert.match(url, /^\/branding\/move-[a-f0-9]{12}\.jpg$/);
    const img = await fetch(s.base + url);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.equal((await fetch(s.base + "/branding/..%2Fdb.json")).status, 404);
    // Image générée par l'IA pour une carte.
    const gen = await (await A("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "image", prompt: "affiche de danse" }) })).json();
    await waitJob({ ...s, req: (p, o = {}) => A(p, o) }, gen.id);
    const fromJob = await (await A(`/api/admin/cards/mix/image-from-job/${gen.id}`, { method: "POST" })).json();
    assert.match(fromJob.status.settings.cards.mix.image, /^\/branding\/mix-/);
    // Les réglages survivent au redémarrage.
    await s.app.settings.flush();
    const s2 = await start({ ...cfgWith(), dataDir: cfg.dataDir });
    try {
      const st2 = await (await fetch(s2.base + "/api/status")).json();
      assert.equal(st2.settings.appName, "Zaher Dance");
      assert.match(st2.settings.cards.move.image, /^\/branding\/move-/);
    } finally { s2.close(); }
  } finally { s.close(); }
});

test("mode Économique : la vidéo envoyée à l'IA passe à 16 images/s, moins de crédits, durée et musique conservées", async () => {
  const fp = fakeProvider({ output: fx.f("sortie-ia.mp4") });
  const s = await start(cfgWith(), fp);
  try {
    const v = await s.up("video", fx.f("danse.mp4"));
    const est = async (fluidite) => (await (await s.req("/api/estimate", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.body.id, resolution: "580p", fluidite }) })).json());
    const eco = await est("eco"), full = await est("origine");
    assert.ok(eco.estimate.usd < full.estimate.usd, "moins cher en Économique");
    assert.equal(eco.estimate.usd, 0.24, "4 s × 16 i/s / 16 × 0,06 $");
    const img = await s.up("image", fx.f("perso.png"));
    const j = await (await s.req("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "move", videoId: v.body.id, imageId: img.body.id, fluidite: "eco" }) })).json();
    const done = await waitJob(s, j.id);
    assert.equal(done.state, "termine");
    const sent = fp.calls.uploads.find((u) => u.mime === "video/mp4").info;
    const vs = sent.streams.find((x) => x.codec_type === "video");
    assert.equal(vs.r_frame_rate, "16/1", "vidéo envoyée à 16 images/s");
    assert.ok(Math.abs(Number(sent.format.duration) - 4) < 0.2, "même durée que l'original");
    assert.equal(done.result.hasAudio, true, "musique d'origine remise");
  } finally { s.close(); }
});

test("images du site : l'admin génère d'un coup toutes les images manquantes (cartes + inspirations)", async () => {
  const fp = fakeProvider({ output: fx.f("perso-ia.jpg") });
  const cfg = cfgWith({ adminEmails: ["patron@exemple.fr"], pollIntervalMs: 5 });
  const s = await start(cfg, fp);
  try {
    const admin = await s.signup("patron@exemple.fr");
    const A = (p, o = {}) => fetch(s.base + p, { ...o, headers: { Cookie: admin.cookie, ...(o.headers || {}) } });
    assert.equal((await s.req("/api/admin/images", { method: "POST" })).status, 403, "réservé à l'admin");
    const before = await (await A("/api/admin/images")).json();
    assert.equal(before.missingCards, 5);
    assert.ok(before.missingGallery >= 8);
    const started = await (await A("/api/admin/images", { method: "POST" })).json();
    assert.equal(started.running, true);
    let st;
    for (let i = 0; i < 400; i++) { st = await (await A("/api/admin/images")).json(); if (!st.running) break; await new Promise((r) => setTimeout(r, 25)); }
    assert.equal(st.running, false);
    assert.deepEqual(st.errors, []);
    assert.equal(st.missing, 0, "plus aucune image manquante");
    const status = await (await fetch(s.base + "/api/status")).json();
    for (const c of Object.values(status.settings.cards)) assert.match(c.image, /^\/branding\//);
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.galleryDir, "manifest.json"), "utf8"));
    for (const rel of Object.values(manifest)) assert.ok(fs.existsSync(path.join(cfg.galleryDir, path.basename(rel))));
  } finally { s.close(); }
});
