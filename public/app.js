// Danse Studio — interface. Aucun secret ici : la clé API reste sur le serveur.
import { EXEMPLES } from "./exemples.js";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const ORDER = ["preparation", "envoi", "attente", "generation", "assemblage", "termine"];
const CHARACTER_SUFFIX = " — personnage en pied, corps entier visible de la tête aux pieds, de face, bras légèrement écartés du corps, fond uni clair, éclairage studio homogène, image nette.";
const SIZE_LABELS = { square_hd: "Carré HD", square: "Carré", portrait_4_3: "Portrait 3:4", portrait_16_9: "Portrait 9:16", landscape_4_3: "Paysage 4:3", landscape_16_9: "Paysage 16:9" };
const RATIO_CLASS = { "9:16": "ratio-916", "16:9": "ratio-169", "1:1": "ratio-11", square_hd: "ratio-11", square: "ratio-11", portrait_4_3: "ratio-34", portrait_16_9: "ratio-916", landscape_4_3: "ratio-43", landscape_16_9: "ratio-169" };

const state = {
  status: null,
  me: null,
  view: "accueil",
  animTool: "move",
  promptTool: "video",
  homeMode: "video",
  files: { anim: {}, prompt: {}, home: {} }, // réponses du serveur après vérification
  busy: 0,
  jobId: null,
  pollTimer: null,
  manifest: {},
  idea: null,
};


const fmtMB = (b) => `${(b / 1048576).toFixed(1).replace(".", ",")} Mo`;
const fmtS = (s) => `${Number(s).toFixed(1).replace(".", ",")} s`;
const fmtUSD = (v) => `${v < 0.01 ? v.toFixed(3) : v.toFixed(2)} $`.replace(".", ",");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const configured = () => !!state.status?.configured;
const tool = (id) => state.status?.tools?.[id];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    credentials: "same-origin",
    headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* réponse vide */ }
  if (res.status === 401) { setMe(null); openAuth("login", body?.error); }
  if (res.status === 402) setTimeout(() => { location.hash = "#tarifs"; }, 1800);
  if (!res.ok) throw new Error(body?.error || `Erreur serveur (HTTP ${res.status}).`);
  if (body?.me) setMe(body.me);
  return body;
}

// ================= Démarrage =================
async function init() {
  try {
    state.status = await (await fetch("/api/status")).json();
  } catch {
    showNotConfigured(["serveur injoignable"]);
    return;
  }
  try { state.manifest = await (await fetch("galerie/manifest.json")).json(); } catch { state.manifest = {}; }
  const st = state.status;
  $("#video-limits").textContent = `${st.limits.minVideoSeconds} à ${st.limits.maxVideoSeconds} s · ${st.limits.maxVideoMB} Mo max · MP4, MOV, WebM`;
  $("#pricing-list").innerHTML = Object.values(st.tools).map((t) => `<li><strong>${esc(t.label)}</strong> : ${esc(t.pricingNote)}</li>`).join("");
  fillSelect($("#resolution"), tool("move").options.resolution, tool("move").defaults.resolution);
  fillSelect($("#opt-aspect"), tool("video").options.aspect_ratio, tool("video").defaults.aspect_ratio);
  fillSelect($("#opt-duration"), tool("video").options.duration, tool("video").defaults.duration, (v) => `${v} s`);
  fillSelect($("#opt-size"), tool("image").options.image_size, tool("image").defaults.image_size, (v) => SIZE_LABELS[v] || v);
  fillSelect($("#p-aspect"), tool("video").options.aspect_ratio, tool("video").defaults.aspect_ratio);
  fillSelect($("#p-duration"), tool("video").options.duration, tool("video").defaults.duration, (v) => `${v} s`);
  fillSelect($("#p-size"), tool("image").options.image_size, tool("image").defaults.image_size, (v) => SIZE_LABELS[v] || v);
  applySettings();
  renderGallery();
  renderPlans();
  if (!st.configured) showNotConfigured(st.missing);
  try { setMe((await (await fetch("/api/me")).json()).user); } catch { setMe(null); }
  route();
}

function fillSelect(sel, values, def, label = (v) => v) {
  sel.innerHTML = values.map((v) => `<option value="${esc(v)}"${v === def ? " selected" : ""}>${esc(label(v))}</option>`).join("");
}

function showNotConfigured(missing) {
  $("#not-configured").classList.remove("hidden");
  $("#missing-list").textContent = missing.join(", ");
  $("#setup-form").classList.toggle("hidden", !state.status?.setupAvailable);
}
$("#setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#setup-error").textContent = "";
  try {
    const r = await api("/api/setup", { method: "POST", body: JSON.stringify({ falKey: $("#setup-key").value, adminEmail: $("#setup-email").value }) });
    $("#setup-key").value = "";
    state.status = r.status;
    if (r.status.configured) {
      $("#not-configured").className = "ok-banner inline";
      $("#not-configured").textContent = "C'est activé ! Créez maintenant votre compte (bouton « Se connecter ») avec le même e-mail : vous aurez des crédits illimités.";
    } else showNotConfigured(r.status.missing);
    refreshAll();
  } catch (err) {
    $("#setup-error").textContent = err.message;
  }
});

// ================= Compte =================
function setMe(me) {
  state.me = me;
  if (state.status) renderPlans();
  $("#login-btn").classList.toggle("hidden", !!me);
  $("#account-link").classList.toggle("hidden", !me);
  $("#credits-pill").classList.toggle("hidden", !me);
  $("#nav-reglages").classList.toggle("hidden", !me?.unlimited);
  $("#cards-hint").classList.toggle("hidden", !me?.unlimited);
  renderToolCards();
  refreshImagesBar();
  if (me) $("#credits-count").textContent = me.unlimited ? "Illimité" : `${me.credits} crédit${me.credits > 1 ? "s" : ""}`;
  if (state.view === "compte") renderAccount();
  refreshAll();
}

const authDlg = $("#auth-dialog");
let authMode = "signup";
function openAuth(mode = "signup", msg = "") {
  authMode = mode;
  $$("#auth-form .seg button").forEach((b) => { b.classList.toggle("on", b.dataset.mode === mode); b.setAttribute("aria-selected", String(b.dataset.mode === mode)); });
  const free = state.status?.freeCredits || 0;
  $("#auth-intro").textContent = msg && msg !== "Connectez-vous pour continuer." ? msg
    : mode === "signup" ? (free ? `Créez votre compte gratuitement : ${free} crédits offerts pour essayer.` : "Créez votre compte pour commencer.") : "Content de vous revoir !";
  $("#auth-submit").textContent = mode === "signup" ? "Créer mon compte" : "Se connecter";
  $("#auth-password").autocomplete = mode === "signup" ? "new-password" : "current-password";
  $("#auth-error").textContent = "";
  if (!authDlg.open) authDlg.showModal();
}
$$("#auth-form .seg button").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.mode)));
$$("[data-auth]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.auth)));
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#auth-error").textContent = "";
  try {
    const r = await api(`/api/auth/${authMode}`, { method: "POST", body: JSON.stringify({ email: $("#auth-email").value, password: $("#auth-password").value }) });
    setMe(r.user);
    $("#auth-password").value = "";
    authDlg.close();
  } catch (err) {
    $("#auth-error").textContent = err.message;
  }
});

// ================= Abonnements =================
let billInterval = "month";
function renderPlans() {
  const st = state.status;
  const plans = Object.entries(st.plans);
  $("#plans").innerHTML = plans.map(([id, p], i) => {
    const price = billInterval === "month" ? p.month : p.year;
    const credits = p.credits * (billInterval === "year" ? 12 : 1);
    return `<article class="plan${i === plans.length - 1 ? " best" : ""}">${i === plans.length - 1 ? '<span class="ribbon">Le plus choisi</span>' : ""}
      <h2>${esc(p.label)}</h2>
      <div class="price">${price} $<small> / ${billInterval === "month" ? "mois" : "an"}</small></div>
      <ul><li><strong>${credits} crédits</strong> ${billInterval === "month" ? "chaque mois" : "pour l'année (versés en une fois)"}</li>
        <li>≈ ${Math.floor(credits * textSecPerCredit())} secondes de vidéo à partir d'un texte</li><li>Mix, Move, vidéo et image</li><li>Musique d'origine conservée</li><li>Téléchargement sans filigrane</li>
        ${i === plans.length - 1 ? "<li>Le meilleur prix par crédit</li>" : ""}</ul>
      <button class="btn${i === plans.length - 1 ? "" : " ghost"}" type="button" data-plan="${esc(id)}"${st.billing ? "" : " disabled"}>${st.billing ? `Choisir ${esc(p.label)}` : "Paiement bientôt disponible"}</button></article>`;
  }).join("");
  $("#billing-note").textContent = st.billing ? "Paiement sécurisé par Stripe. Les crédits d'abonnement sont remis à niveau à chaque renouvellement (ils ne se cumulent pas)."
    : (state.me?.unlimited ? "Administrateur : branchez Stripe pour activer ces boutons (voir le README, partie « Stripe »)." : "Les abonnements seront bientôt disponibles.");
  const ex = st.creditExamples || [];
  $("#credit-examples").innerHTML = ex.map(([t, c]) => `<li>${esc(t)} : <strong>${c} crédit${c > 1 ? "s" : ""}</strong></li>`).join("")
    + "<li>Mix et Move dépendent de la durée et de la cadence de la vidéo importée : le nombre exact s'affiche avant de générer.</li>";
}
$$("#interval-seg button").forEach((b) => b.addEventListener("click", () => {
  billInterval = b.dataset.interval;
  $$("#interval-seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); });
  renderPlans();
}));
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-plan]");
  if (!b) return;
  if (!state.me) return openAuth("signup", "Créez votre compte, puis choisissez votre formule.");
  b.disabled = true;
  try {
    const { url } = await api("/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: b.dataset.plan, interval: billInterval }) });
    location.href = url;
  } catch (err) {
    $("#billing-note").textContent = err.message;
    b.disabled = false;
  }
});

function renderAccount() {
  const me = state.me;
  if (!me) { $("#account-details").innerHTML = ""; openAuth("login"); return; }
  const planLabel = me.plan ? `${state.status.plans[me.plan]?.label || me.plan} (${me.interval === "year" ? "annuel" : "mensuel"})` : "Aucun abonnement";
  const statusLabel = { active: "actif", past_due: "paiement en retard", canceled: "annulé", unpaid: "impayé", incomplete: "en attente de paiement" }[me.subscriptionStatus] || "—";
  $("#account-details").innerHTML = `<dt>E-mail</dt><dd>${esc(me.email)}</dd><dt>Crédits</dt><dd>${me.unlimited ? "Illimités (administrateur)" : me.credits}</dd>
    <dt>Formule</dt><dd>${esc(planLabel)}</dd><dt>Statut</dt><dd>${esc(statusLabel)}</dd>`;
  $("#acc-portal").classList.toggle("hidden", !me.canManageBilling);
  $("#admin-stripe").classList.toggle("hidden", !me.unlimited);
  const st = state.status;
  $("#stripe-state").textContent = st.billing
    ? (st.billingWebhook ? "✓ Stripe est branché : les abonnements et les renouvellements fonctionnent." :
      "✓ Stripe est branché : vous pouvez tester un paiement. Pour les renouvellements automatiques, indiquez l'adresse publique du site une fois en ligne, puis rebranchez.")
    : "Stripe n'est pas encore branché : les boutons d'abonnement sont désactivés.";
  $("#acc-upgrade").textContent = me.plan ? "Changer de formule" : "Choisir un abonnement";
}
$("#stripe-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#stripe-error").textContent = "";
  const btn = e.submitter;
  if (btn) { btn.disabled = true; btn.textContent = "Connexion à Stripe…"; }
  try {
    const r = await api("/api/admin/stripe", { method: "POST", body: JSON.stringify({ secretKey: $("#stripe-key").value, publicUrl: $("#stripe-url").value }) });
    $("#stripe-key").value = "";
    state.status = r.status;
    renderPlans();
    renderAccount();
    $("#stripe-error").textContent = "";
    $("#stripe-state").textContent = `✓ Stripe branché (${r.live ? "mode RÉEL : de vrais paiements" : "mode test : aucun vrai argent"}). Les 4 prix ont été créés. Essayez « Abonnements ».`;
  } catch (err) {
    $("#stripe-error").textContent = err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Brancher Stripe"; }
  }
});
$("#acc-portal").addEventListener("click", async () => {
  try { const { url } = await api("/api/billing/portal", { method: "POST" }); location.href = url; }
  catch (err) { $("#acc-error").textContent = err.message; }
});
$("#acc-logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  setMe(null);
  location.hash = "#accueil";
});

const canGenerate = () => configured() && !!state.me;

// ================= Navigation =================
function route() {
  const [h, query = ""] = (location.hash || "#accueil").slice(1).split("?");
  let view = h;
  if (h === "mix" || h === "move") { state.animTool = h; view = "anim"; setupAnim(); }
  else if (h === "video" || h === "image") { state.promptTool = h; view = "prompt"; setupPrompt(); }
  else if (!$(`.view[data-view="${h}"]`)) view = "accueil";
  state.view = view;
  $$(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== view));
  $$(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.view === h || (h === "aide" && false)));
  if (view === "creations") loadCreations();
  if (view === "reglages") renderSettingsForm();
  if (view === "compte") {
    $("#pay-ok").classList.toggle("hidden", !query.includes("paiement=ok"));
    renderAccount();
    const sid = /session=(cs_[A-Za-z0-9_]+)/.exec(query)?.[1];
    if (sid) {
      api("/api/billing/confirm", { method: "POST", body: JSON.stringify({ session: sid }) })
        .then((r) => { setMe(r.user); $("#pay-ok").textContent = r.confirmed ? "Merci ! Votre abonnement est actif et vos crédits ont été ajoutés." : "Paiement en cours de validation par Stripe… rechargez la page dans un instant."; })
        .catch((err) => { $("#pay-ok").textContent = err.message; });
    }
  }
  window.scrollTo({ top: 0 });
  refreshAll();
}
window.addEventListener("hashchange", route);

// ================= Import des fichiers =================
function localDuration(file) {
  return new Promise((resolve) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => { resolve(el.duration); URL.revokeObjectURL(el.src); };
    el.onerror = () => resolve(null);
    el.src = URL.createObjectURL(file);
  });
}

function upload(kind, file, statusEl) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/uploads/${kind}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      statusEl.innerHTML = `Envoi au serveur : ${pct} %<div class="bar"><span></span></div>`;
      $(".bar span", statusEl).style.width = `${pct}%`;
    };
    xhr.upload.onload = () => (statusEl.textContent = "Vérification du fichier…");
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* */ }
      if (xhr.status === 401) { setMe(null); openAuth("login", body?.error); }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error || `Erreur d'envoi (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Connexion interrompue pendant l'envoi."));
    xhr.send(file);
  });
}

// slot : "anim" | "prompt" | "home" ; els : { preview, status }
async function handleFile(slot, kind, file, els) {
  if (!file) return;
  const L = state.status.limits;
  delete state.files[slot][kind];
  if (els.preview) {
    els.preview.src = URL.createObjectURL(file);
    els.preview.classList.remove("hidden");
  }
  const max = { video: L.maxVideoMB, image: L.maxImageMB, audio: L.maxAudioMB }[kind];
  const status = els.status;
  if (file.size > max * 1048576) { status.innerHTML = `<span class="err">Fichier trop volumineux (${fmtMB(file.size)}, maximum ${max} Mo).</span>`; refreshAll(); return; }
  if (kind === "video") {
    const d = await localDuration(file);
    if (d && d > L.maxVideoSeconds + 0.05) {
      status.innerHTML = `<span class="err">Vidéo trop longue : ${fmtS(d)} pour une limite de ${L.maxVideoSeconds} s. Elle n'est pas coupée automatiquement : raccourcissez-la avant l'import.</span>`;
      refreshAll();
      return;
    }
  }
  if (!configured()) { status.textContent = "Aperçu uniquement : service vidéo non configuré."; refreshAll(); return; }
  if (!state.me) { status.textContent = "Créez un compte ou connectez-vous pour importer vos fichiers."; openAuth("signup"); refreshAll(); return; }
  state.busy++;
  refreshAll();
  try {
    const info = await upload(kind, file, status);
    state.files[slot][kind] = info;
    status.innerHTML = describe(info);
  } catch (err) {
    status.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  } finally {
    state.busy--;
    refreshAll();
  }
}

function describe(info) {
  if (info.kind === "video") {
    const sound = info.hasAudio ? "son présent" : '<span class="err">aucun son détecté</span>';
    return `<span class="ok">✓ Vidéo vérifiée</span> · ${fmtS(info.durationSec)} · ${Math.round(info.fps)} i/s · ${info.width}×${info.height} · ${sound}`;
  }
  if (info.kind === "image") return `<span class="ok">✓ Image vérifiée</span> · ${info.width}×${info.height}`;
  return `<span class="ok">✓ Audio vérifié</span> · ${fmtS(info.durationSec)}`;
}

const animEls = {
  video: { preview: $("#video-preview"), status: $("#video-status") },
  image: { preview: $("#image-preview"), status: $("#image-status") },
  audio: { preview: $("#audio-preview"), status: $("#audio-status") },
};
$("#video-input").addEventListener("change", (e) => handleFile("anim", "video", e.target.files[0], animEls.video));
$("#image-input").addEventListener("change", (e) => handleFile("anim", "image", e.target.files[0], animEls.image));
$("#audio-input").addEventListener("change", (e) => handleFile("anim", "audio", e.target.files[0], animEls.audio));
const promptImgEls = { preview: $("#p-image-preview"), status: $("#p-image-status") };
$("#p-image-input").addEventListener("change", (e) => handleFile("prompt", "image", e.target.files[0], promptImgEls));
const homeImgEls = { preview: null, status: $("#start-image-status") };
$("#start-image-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("#start-image-label").textContent = f ? f.name.slice(0, 18) : "Image de départ";
  $("#chip-start-image").classList.toggle("has", !!f);
  handleFile("home", "image", f, homeImgEls);
});

// ================= Estimation du coût =================
let estTimer = null;
function estimate(body, el) {
  clearTimeout(estTimer);
  estTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      const owner = state.me?.unlimited;
      el.innerHTML = r.credits
        ? `Coût : <strong>${r.credits} crédit${r.credits > 1 ? "s" : ""}</strong>${r.estimate?.detail ? ` · ${esc(r.estimate.detail)}` : ""}${owner && r.estimate ? ` · ≈ ${fmtUSD(r.estimate.usd)} chez fal` : ""}`
        : "Le nombre de crédits s'affiche après l'import de la vidéo.";
    } catch { el.textContent = ""; }
  }, 200);
}

// ================= Accueil : composer =================
$$("#composer .seg button").forEach((b) => b.addEventListener("click", () => {
  state.homeMode = b.dataset.mode;
  $$("#composer .seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", String(x === b)); });
  refreshAll();
}));
["#prompt", "#opt-aspect", "#opt-duration", "#opt-size"].forEach((s) => $(s).addEventListener("input", refreshAll));

function homeTool() {
  if (state.homeMode === "image") return "image";
  return state.files.home.image ? "animer" : "video";
}
function refreshComposer() {
  const isImg = state.homeMode === "image";
  $("#prompt").placeholder = isImg ? "Décrivez l'image que vous imaginez…" : "Décrivez la vidéo que vous imaginez…";
  $("#opt-size").classList.toggle("hidden", !isImg);
  $("#opt-aspect").classList.toggle("hidden", isImg || !!state.files.home.image);
  $("#opt-duration").classList.toggle("hidden", isImg);
  $("#chip-start-image").classList.toggle("hidden", isImg);
  $("#start-image-status").classList.toggle("hidden", isImg);
  const t = homeTool();
  estimate({ tool: t, duration: $("#opt-duration").value, aspect_ratio: $("#opt-aspect").value, image_size: $("#opt-size").value }, $("#composer-cost"));
  $("#composer-go").disabled = !canGenerate() || !$("#prompt").value.trim() || state.busy > 0 || !!state.jobId;
}
$("#composer-go").addEventListener("click", () => {
  const t = homeTool();
  startJob({
    tool: t, prompt: $("#prompt").value, duration: $("#opt-duration").value, aspect_ratio: $("#opt-aspect").value,
    image_size: $("#opt-size").value, imageId: t === "animer" ? state.files.home.image.id : undefined,
  }, "home");
});

// ================= Mix / Move =================
const ANIM_TEXT = {
  mix: {
    title: "Mix — remplacer la personne d'une vidéo",
    desc: "Votre personnage prend la place de la personne dans la vidéo : même danse, même décor, même musique.",
    how1: "Une vidéo avec une personne bien visible qui danse ou bouge.",
    how3: "L'IA remplace la personne en gardant le décor. La musique d'origine est remise automatiquement.",
  },
  move: {
    title: "Move — faire danser une photo",
    desc: "Votre personnage reprend exactement les mouvements de la vidéo, sur son propre fond, avec la musique d'origine.",
    how1: "La vidéo de danse dont il faut copier les mouvements.",
    how3: "L'IA anime votre photo avec ces mouvements. La musique d'origine est remise automatiquement.",
  },
};
function setupAnim() {
  const t = ANIM_TEXT[state.animTool];
  $("#anim-title").textContent = t.title;
  $("#anim-desc").textContent = t.desc;
  $("#how-1").textContent = t.how1;
  $("#how-3").textContent = t.how3;
}
$$('input[name="audio-mode"]').forEach((r) => r.addEventListener("change", refreshAll));
$("#resolution").addEventListener("change", refreshAll);
$("#fluidite").addEventListener("change", refreshAll);
const audioMode = () => $('input[name="audio-mode"]:checked').value;
$("#make-character").addEventListener("click", () => { state.characterMode = true; });

function refreshAnim() {
  const replace = audioMode() === "replace";
  $("#audio-block").classList.toggle("hidden", !replace);
  const f = state.files.anim;
  estimate({ tool: state.animTool, resolution: $("#resolution").value, fluidite: $("#fluidite").value, videoId: f.video?.id }, $("#anim-cost"));
  $("#anim-go").disabled = !(canGenerate() && f.video && f.image && (!replace || f.audio) && state.busy === 0 && !state.jobId);
}
$("#anim-go").addEventListener("click", () => {
  const f = state.files.anim;
  startJob({
    tool: state.animTool, videoId: f.video.id, imageId: f.image.id,
    audioId: audioMode() === "replace" ? f.audio?.id : null, resolution: $("#resolution").value, fluidite: $("#fluidite").value,
  }, "anim");
});

// ================= Vidéo / Image (prompt) =================
function setupPrompt() {
  const isImg = state.promptTool === "image";
  $("#prompt-title").textContent = isImg ? "Générer une image" : "Générer une vidéo";
  $("#prompt-desc").textContent = isImg
    ? "Décrivez une scène ou un personnage : l'IA crée une image réaliste en quelques secondes."
    : "Décrivez une scène : l'IA crée une vidéo de 5 à 30 secondes (au-delà de 10 s, plusieurs morceaux sont enchaînés). Ajoutez une image de départ pour l'animer.";
  $("#p-aspect-f").classList.toggle("hidden", isImg);
  $("#p-duration-f").classList.toggle("hidden", isImg);
  $("#p-size-f").classList.toggle("hidden", !isImg);
  $("#p-image-block").classList.toggle("hidden", isImg);
  $("#p-character-f").classList.toggle("hidden", !isImg);
  if (isImg && state.characterMode) {
    $("#p-character").checked = true;
    $("#p-size").value = "portrait_16_9";
    state.characterMode = false;
  }
}
["#p-prompt", "#p-aspect", "#p-duration", "#p-size", "#p-character"].forEach((s) => $(s).addEventListener("input", refreshAll));
$("#p-character").addEventListener("change", () => { if ($("#p-character").checked) $("#p-size").value = "portrait_16_9"; refreshAll(); });

function promptToolId() {
  if (state.promptTool === "image") return "image";
  return state.files.prompt.image ? "animer" : "video";
}
function refreshPrompt() {
  const t = promptToolId();
  $("#p-aspect-f").classList.toggle("hidden", state.promptTool === "image" || t === "animer");
  estimate({ tool: t, duration: $("#p-duration").value, aspect_ratio: $("#p-aspect").value, image_size: $("#p-size").value }, $("#p-cost"));
  $("#p-go").textContent = state.promptTool === "image" ? ($("#p-character").checked ? "Créer le personnage" : "Générer l'image") : "Générer la vidéo";
  $("#p-go").disabled = !canGenerate() || !$("#p-prompt").value.trim() || state.busy > 0 || !!state.jobId;
}
$("#p-go").addEventListener("click", () => {
  const t = promptToolId();
  let prompt = $("#p-prompt").value.trim();
  if (t === "image" && $("#p-character").checked) prompt += CHARACTER_SUFFIX;
  startJob({
    tool: t, prompt, duration: $("#p-duration").value, aspect_ratio: $("#p-aspect").value, image_size: $("#p-size").value,
    imageId: t === "animer" ? state.files.prompt.image.id : undefined,
  }, "prompt");
});

function refreshAll() {
  if (!state.status) return;
  refreshComposer();
  if (state.view === "anim") refreshAnim();
  if (state.view === "prompt") refreshPrompt();
}

// ================= Création : suivi réel =================
const dlg = $("#job-dialog");
// Aperçu flou affiché pendant la génération (la vraie vidéo n'existe qu'à la fin).
function previewSource(body, slot) {
  const vid = slot === "anim" ? animEls.video.preview.getAttribute("src") : null;
  const img = slot === "anim" ? animEls.image.preview.getAttribute("src")
    : slot === "prompt" ? promptImgEls.preview.getAttribute("src") : null;
  const shape = body.tool === "image" ? (/landscape/.test(body.image_size) ? "wide" : /square/.test(body.image_size) ? "square" : "")
    : body.aspect_ratio === "16:9" ? "wide" : body.aspect_ratio === "1:1" ? "square" : "";
  return { vid: body.videoId ? vid : null, img: body.imageId ? img : null, shape, prompt: body.prompt || "" };
}
function showPreview(src) {
  const box = $("#job-preview");
  box.className = `job-preview ${src.shape}`.trim();
  box.querySelectorAll("video, img, .blob").forEach((e) => e.remove());
  let el;
  if (src.vid) {
    el = document.createElement("video");
    Object.assign(el, { src: src.vid, muted: true, loop: true, autoplay: true, playsInline: true });
    el.play?.().catch(() => {});
  } else if (src.img) {
    el = document.createElement("img");
    el.src = src.img;
    el.alt = "";
  } else {
    el = document.createElement("span");
    el.className = "blob";
    // Couleurs dérivées du texte : chaque description a son propre aperçu.
    let h = 0;
    for (const c of src.prompt) h = (h * 31 + c.charCodeAt(0)) % 360;
    el.style.setProperty("--c1", `hsl(${h} 80% 60%)`);
    el.style.setProperty("--c2", `hsl(${(h + 140) % 360} 70% 55%)`);
  }
  box.prepend(el);
}

async function startJob(body, slot) {
  showPreview(previewSource(body, slot));
  try {
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    state.jobId = job.id;
    clearSlot(slot); // les fichiers sont consommés par cette création
    $("#job-progress").classList.remove("hidden");
    $("#job-failure").classList.add("hidden");
    $("#job-result").classList.add("hidden");
    $("#tl-final").textContent = tool(job.tool).restoreAudio ? "Réintégration de la musique" : "Finalisation";
    $("#job-tool").textContent = job.toolLabel;
    if (!dlg.open) dlg.showModal();
    render(job);
    poll();
  } catch (err) {
    $("#job-progress").classList.add("hidden");
    $("#job-result").classList.add("hidden");
    $("#job-failure").classList.remove("hidden");
    $("#failure-message").textContent = err.message;
    if (!dlg.open) dlg.showModal();
  }
  refreshAll();
}

function clearSlot(slot) {
  state.files[slot] = {};
  const reset = (inputSel, els) => {
    $(inputSel).value = "";
    if (els?.preview) { els.preview.removeAttribute("src"); els.preview.classList.add("hidden"); }
    if (els?.status) els.status.textContent = "";
  };
  if (slot === "anim") { reset("#video-input", animEls.video); reset("#image-input", animEls.image); reset("#audio-input", animEls.audio); }
  if (slot === "prompt") reset("#p-image-input", promptImgEls);
  if (slot === "home") { reset("#start-image-input", homeImgEls); $("#start-image-label").textContent = "Image de départ"; $("#chip-start-image").classList.remove("has"); }
}

function poll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    if (!state.jobId) return;
    try {
      const job = await api(`/api/jobs/${state.jobId}`);
      render(job);
      if (!["termine", "erreur"].includes(job.state)) poll();
    } catch (err) {
      showFailure(err.message);
    }
  }, 3000);
}

function render(job) {
  rememberToken(job);
  const idx = ORDER.indexOf(job.state);
  $$("#timeline li").forEach((li) => {
    const i = ORDER.indexOf(li.dataset.state);
    const current = job.state === "preparation" ? li.dataset.state === "envoi" : i === idx;
    li.classList.toggle("done", i < idx || job.state === "termine");
    li.classList.toggle("active", current && job.state !== "termine");
  });
  const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
  let detail = `${job.stateLabel} · ${Math.floor(elapsed / 60)} min ${String(elapsed % 60).padStart(2, "0")} s écoulées`;
  if (job.state === "attente" && job.queuePosition != null) detail += ` · position dans la file : ${job.queuePosition}`;
  if (job.segment && ["attente", "generation"].includes(job.state)) detail += ` · morceau ${job.segment.index} sur ${job.segment.total}`;
  $("#progress-detail").textContent = detail;
  if (job.state === "erreur") showFailure(job.error);
  if (job.state === "termine") showResult(job);
}

function showFailure(msg) {
  clearTimeout(state.pollTimer);
  state.jobId = null;
  $("#job-progress").classList.add("hidden");
  $("#job-failure").classList.remove("hidden");
  $("#failure-message").textContent = msg || "Erreur inconnue.";
  if (!dlg.open) dlg.showModal();
  refreshAll();
}

function mediaHtml(job, controls = true) {
  return job.kind === "image"
    ? `<img src="${esc(job.result.url)}" alt="Création : ${esc(job.toolLabel)}">`
    : `<video src="${esc(job.result.url)}" ${controls ? "controls" : "muted"} playsinline preload="metadata"></video>`;
}

function reuseButtons(job) {
  if (job.kind === "image") {
    return `<div class="reuse"><p>Utiliser ce personnage pour reprendre une danse :</p><div class="row">
      <button class="btn sm" type="button" data-reuse="${job.id}" data-to="mix">Dans Mix</button>
      <button class="btn sm" type="button" data-reuse="${job.id}" data-to="move">Dans Move</button>
      <button class="btn ghost sm" type="button" data-reuse="${job.id}" data-to="video">L'animer avec un texte</button></div></div>`;
  }
  if (!tool(job.tool).restoreAudio) {
    return `<div class="reuse"><p>Utiliser cette vidéo comme danse de référence :</p><div class="row">
      <button class="btn sm" type="button" data-reuse="${job.id}" data-to="mix">Dans Mix</button>
      <button class="btn sm" type="button" data-reuse="${job.id}" data-to="move">Dans Move</button></div></div>`;
  }
  return "";
}

function showResult(job) {
  state.currentJob = job;
  clearTimeout(state.pollTimer);
  state.jobId = null;
  $("#job-progress").classList.add("hidden");
  $("#job-result").classList.remove("hidden");
  $("#result-media").innerHTML = mediaHtml(job) + shareButtons(job) + reuseButtons(job);
  $("#result-media").classList.add("reveal");
  $("#download").href = job.result.downloadUrl;
  const notes = [];
  if (job.audioMode) {
    notes.push({ original: "Musique : son d'origine de la vidéo de référence, remis depuis le début (synchronisé).",
      remplacement: "Musique : votre fichier audio, placé depuis le début.", aucun: "Vidéo muette (la référence n'avait pas de son)." }[job.audioMode]);
  }
  if (job.result.durationSec) notes.push(`Durée : ${fmtS(job.result.durationSec)}${job.result.sourceDurationSec ? ` (vidéo de référence : ${fmtS(job.result.sourceDurationSec)})` : ""}`);
  if (job.credits) notes.push(`${job.credits} crédit${job.credits > 1 ? "s" : ""} utilisé${job.credits > 1 ? "s" : ""}.`);
  if (job.segment) notes.push(`Vidéo assemblée à partir de ${job.segment.total} morceaux générés à la suite.`);
  if (job.inferenceSeconds) notes.push(`Temps de calcul chez le fournisseur : ${Math.round(job.inferenceSeconds)} s.`);
  const html = notes.map((n) => `<li>${esc(n)}</li>`);
  for (const w of job.warnings || []) html.push(`<li class="warn">${esc(w)}</li>`);
  html.push(`<li>Disponible dans « Mes créations » pendant ${Math.round(state.status.limits.resultTtlMinutes / 60)} h. Téléchargez-la pour la garder.</li>`);
  $("#result-notes").innerHTML = html.join("");
  if (!dlg.open) dlg.showModal();
  refreshAll();
}

// Réutiliser une création : le personnage généré part dans Mix / Move.
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-reuse]");
  if (!b) return;
  b.disabled = true;
  try {
    const info = await api(`/api/jobs/${b.dataset.reuse}/reuse`, { method: "POST" });
    const to = b.dataset.to;
    if (dlg.open) dlg.close();
    if (info.kind === "image" && (to === "mix" || to === "move")) {
      state.files.anim.image = info;
      animEls.image.preview.src = `/api/jobs/${b.dataset.reuse}/file?t=${tokenOf(b)}`;
      animEls.image.preview.classList.remove("hidden");
      animEls.image.status.innerHTML = `${describe(info)} · personnage généré par l'IA. Ajoutez maintenant la vidéo de danse.`;
    } else if (info.kind === "image") {
      state.files.prompt.image = info;
      promptImgEls.preview.src = `/api/jobs/${b.dataset.reuse}/file?t=${tokenOf(b)}`;
      promptImgEls.preview.classList.remove("hidden");
      promptImgEls.status.innerHTML = describe(info);
    } else {
      state.files.anim.video = info;
      animEls.video.preview.src = `/api/jobs/${b.dataset.reuse}/file?t=${tokenOf(b)}`;
      animEls.video.preview.classList.remove("hidden");
      animEls.video.status.innerHTML = `${describe(info)}. Ajoutez maintenant votre personnage.`;
    }
    location.hash = `#${to}`;
    refreshAll();
  } catch (err) {
    alertInline(b, err.message);
  } finally {
    b.disabled = false;
  }
});
const tokens = new Map();
const tokenOf = (b) => tokens.get(b.dataset.reuse) || "";
function rememberToken(job) { if (job.result) tokens.set(job.id, new URL(job.result.url, location.href).searchParams.get("t")); }
function alertInline(el, msg) {
  const p = document.createElement("p");
  p.className = "error";
  p.textContent = msg;
  el.closest(".reuse, .meta")?.append(p);
}

$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$('[data-action="restart"]').addEventListener("click", () => { dlg.close(); location.hash = "#accueil"; });


// ================= Galerie Explorer =================
function tileHtml(ex) {
  const img = state.manifest[ex.id];
  const ratio = RATIO_CLASS[ex.format] || "ratio-34";
  const ph = img
    ? `<img class="ph ${ratio}" src="${esc(img)}" alt="" loading="lazy">`
    : `<span class="ph ${ratio}" data-bg="${esc(ex.tons.join(","))}"></span>`;
  return `<button type="button" class="tile" data-idea="${esc(ex.id)}">${ph}<span class="badge">${ex.type === "video" ? "Vidéo" : "Image"}</span>
    <span class="cap"><strong>${esc(ex.titre)}</strong><small>${esc(ex.prompt)}</small></span></button>`;
}
let filter = "tout";
function renderGallery() {
  const list = EXEMPLES.filter((e) => filter === "tout" || e.type === filter);
  $("#gallery").innerHTML = list.map(tileHtml).join("");
  $("#home-gallery").innerHTML = EXEMPLES.slice(0, 8).map(tileHtml).join("");
  const missing = EXEMPLES.filter((e) => !state.manifest[e.id]).length;
  $("#gallery-note").textContent = "";
  // Les couleurs des aperçus sont appliquées via CSSOM (compatible avec la politique de sécurité du site).
  $$(".tile span.ph[data-bg]").forEach((el) => { const [a, b] = el.dataset.bg.split(","); el.style.background = `linear-gradient(160deg, ${a}, ${b})`; });
}
$$("#explore-tabs button").forEach((b) => b.addEventListener("click", () => {
  filter = b.dataset.filter;
  $$("#explore-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  renderGallery();
}));

const ideaDlg = $("#idea-dialog");
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-idea]");
  if (!t) return;
  const ex = EXEMPLES.find((x) => x.id === t.dataset.idea);
  state.idea = ex;
  const img = state.manifest[ex.id];
  $("#idea-media").innerHTML = img ? `<img src="${esc(img)}" alt="">` : '<span class="ph"></span>';
  if (!img) $("#idea-media .ph").style.background = `linear-gradient(160deg, ${ex.tons[0]}, ${ex.tons[1]})`;
  $("#idea-type").textContent = ex.type === "video" ? "Idée de vidéo" : "Idée d'image";
  $("#idea-title").textContent = ex.titre;
  $("#idea-prompt").textContent = ex.prompt;
  $("#idea-tool").textContent = ex.type === "video" ? "Générer une vidéo" : "Générer une image";
  $("#idea-format").textContent = SIZE_LABELS[ex.format] || ex.format;
  ideaDlg.showModal();
});
$("#idea-use").addEventListener("click", () => {
  const ex = state.idea;
  ideaDlg.close();
  $("#p-prompt").value = ex.prompt;
  if (ex.type === "video") $("#p-aspect").value = ex.format;
  else { $("#p-size").value = ex.format; $("#p-character").checked = false; }
  location.hash = ex.type === "video" ? "#video" : "#image";
  setTimeout(() => $("#p-prompt").focus(), 50);
});
$("#idea-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.idea.prompt); $("#idea-copy").textContent = "Copié ✓"; }
  catch { $("#idea-copy").textContent = "Copie impossible"; }
  setTimeout(() => ($("#idea-copy").textContent = "Copier"), 1500);
});

// ================= Mes créations =================
async function loadCreations() {
  const box = $("#creations");
  if (!state.me) { $("#creations-note").textContent = "Connectez-vous pour voir vos créations."; box.innerHTML = ""; return; }
  try {
    const { jobs } = await api("/api/jobs");
    jobs.forEach(rememberToken);
    state.lastJobs = jobs;
    $("#creations-note").textContent = jobs.length
      ? `Conservées ${Math.round(state.status.limits.resultTtlMinutes / 60)} h sur le serveur. Téléchargez celles que vous voulez garder.`
      : "Aucune création pour l'instant.";
    box.innerHTML = jobs.map((j) => `<article class="creation">${mediaHtml(j)}<div class="meta">
      <strong>${esc(j.toolLabel)}</strong>${j.params?.prompt ? `<span class="muted">${esc(j.params.prompt.slice(0, 90))}</span>` : ""}
      <div class="row"><a class="btn sm" href="${esc(j.result.downloadUrl)}" download>Télécharger</a></div>${shareButtons(j)}${reuseButtons(j)}</div></article>`).join("");
  } catch (err) {
    $("#creations-note").textContent = err.message;
  }
}

// ================= Mèmes (100 % dans le navigateur) =================
const meme = { img: null, top: 64, bottom: 64 };
const cv = $("#meme-canvas");
const ctx = cv.getContext("2d");
function drawMeme() {
  const w = cv.width;
  let h = cv.height;
  if (meme.img) { h = Math.round((meme.img.height / meme.img.width) * w); cv.height = h; ctx.drawImage(meme.img, 0, 0, w, h); }
  else {
    cv.height = h = 800;
    ctx.fillStyle = "#1b2421"; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#94a59d"; ctx.font = "28px system-ui"; ctx.textAlign = "center";
    ctx.fillText("Choisissez une image", w / 2, h / 2);
  }
  const line = (text, size, y, base) => {
    if (!text) return;
    ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = base;
    ctx.lineWidth = Math.max(4, size / 9); ctx.strokeStyle = "#000"; ctx.fillStyle = "#fff"; ctx.lineJoin = "round";
    const words = text.toUpperCase().split(" ");
    const lines = [];
    let cur = "";
    for (const wd of words) { const t = cur ? `${cur} ${wd}` : wd; if (ctx.measureText(t).width > w - 40 && cur) { lines.push(cur); cur = wd; } else cur = t; }
    lines.push(cur);
    const lh = size * 1.05;
    const startY = base === "top" ? y : y - (lines.length - 1) * lh;
    lines.forEach((l, i) => { ctx.strokeText(l, w / 2, startY + i * lh); ctx.fillText(l, w / 2, startY + i * lh); });
  };
  line($("#meme-top").value, meme.top, 20, "top");
  line($("#meme-bottom").value, meme.bottom, h - 20, "bottom");
}
$("#meme-input").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { meme.img = img; drawMeme(); };
  img.src = URL.createObjectURL(f);
});
["#meme-top", "#meme-bottom"].forEach((s) => $(s).addEventListener("input", drawMeme));
$$("[data-size]").forEach((b) => b.addEventListener("click", () => {
  const [, which, op] = /(top|bottom)([+-])/.exec(b.dataset.size);
  meme[which] = Math.min(140, Math.max(24, meme[which] + (op === "+" ? 8 : -8)));
  drawMeme();
}));
$("#meme-download").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "meme.png";
  a.href = cv.toDataURL("image/png");
  a.click();
});
$("#meme-animate").addEventListener("click", () => {
  if (!meme.img) return;
  if (!state.me) return openAuth("signup");
  cv.toBlob((blob) => {
    const file = new File([blob], "meme.png", { type: "image/png" });
    location.hash = "#move";
    handleFile("anim", "image", file, animEls.image);
  }, "image/png");
});
drawMeme();

init();


// ================= Personnalisation (nom, textes, images des cartes) =================
const CARD_ORDER = ["mix", "move", "video", "image", "memes"];
const CARD_LINK = { mix: "#mix", move: "#move", video: "#video", image: "#image", memes: "#memes" };
const CARD_CLASS = { mix: "t-mix", move: "t-move", video: "t-video", image: "t-image", memes: "t-meme" };
const isAdminUser = () => !!state.me?.unlimited;
// Secondes de vidéo à partir d'un texte pour 1 crédit (tarif fal : 0,07 $/s).
const textSecPerCredit = () => (state.status?.settings?.creditUsd || 0.07) / 0.07;

function applySettings() {
  const s = state.status?.settings;
  if (!s) return;
  document.title = s.appName;
  $("#app-name").textContent = s.appName;
  $("#hero-title").textContent = s.tagline;
  $("#tarifs-sub").textContent = `1 crédit ≈ ${textSecPerCredit().toFixed(1).replace(".", ",").replace(",0", "")} s de vidéo à partir d'un texte. Une image coûte 1 crédit. Sans engagement, annulable à tout moment.`;
  renderToolCards();
}

function renderToolCards() {
  const s = state.status?.settings;
  const grid = $("#tools-grid");
  if (!s || !grid) return;
  const admin = isAdminUser();
  grid.innerHTML = CARD_ORDER.map((id) => {
    const c = s.cards[id];
    return `<a class="tool-card ${CARD_CLASS[id]}${c.image ? " has-img" : ""}" href="${CARD_LINK[id]}" data-card="${id}">
      ${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ""}
      ${admin ? `<span class="card-edit" data-card-pick="${id}" role="button" tabindex="0" title="Changer l'image">🖼 Image</span>` : ""}
      <strong>${esc(c.title)}</strong><small>${esc(c.desc)}</small><span class="go">Essayer →</span></a>`;
  }).join("");
  $$(".tool-card", grid).forEach((el) => {
    const img = s.cards[el.dataset.card].image;
    if (img) el.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,.35) 0%, rgba(0,0,0,.55) 40%, rgba(0,0,0,.92) 100%), url("${img}")`;
  });
}

// Glisser-déposer une image sur une carte (administrateur).
const cardPicker = Object.assign(document.createElement("input"), { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true });
document.body.append(cardPicker);
let pickFor = null;
cardPicker.addEventListener("change", () => { if (cardPicker.files[0] && pickFor) uploadCardImage(pickFor, cardPicker.files[0]); cardPicker.value = ""; });
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-card-pick]");
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  pickFor = b.dataset.cardPick; cardPicker.click();
});
for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, (e) => {
  const zone = e.target.closest?.("[data-card], [data-card-drop]");
  if (!zone || !isAdminUser()) return;
  e.preventDefault(); zone.classList.add("drag-on");
});
document.addEventListener("dragleave", (e) => e.target.closest?.("[data-card], [data-card-drop]")?.classList.remove("drag-on"));
document.addEventListener("drop", (e) => {
  const zone = e.target.closest?.("[data-card], [data-card-drop]");
  if (!zone || !isAdminUser()) return;
  e.preventDefault(); zone.classList.remove("drag-on");
  const file = e.dataTransfer.files[0];
  if (file) uploadCardImage(zone.dataset.card || zone.dataset.cardDrop, file);
});

async function uploadCardImage(id, file, note = (m) => toast(m)) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return note("Image refusée : JPEG, PNG ou WebP uniquement.");
  if (file.size > state.status.limits.maxImageMB * 1048576) return note(`Image trop lourde (maximum ${state.status.limits.maxImageMB} Mo).`);
  note("Envoi de l'image…");
  try {
    const r = await api(`/api/admin/cards/${id}/image`, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
    state.status = r.status; applySettings(); if (state.view === "reglages") renderSettingsForm();
    note("Image enregistrée ✓");
  } catch (err) { note(err.message); }
}

function toast(msg) {
  let t = $("#toast");
  if (!t) { t = Object.assign(document.createElement("div"), { id: "toast", className: "toast" }); t.setAttribute("role", "status"); document.body.append(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 3500);
}

async function renderSettingsForm() {
  if (isAdminUser() && state.status.creditExamples?.[0]?.length < 3) {
    try { state.status = await (await fetch("/api/status")).json(); } catch { /* garde l'ancien état */ }
  }
  if (!isAdminUser()) { $("#set-error").textContent = "Réservé à l'administrateur. Connectez-vous avec le compte administrateur."; return; }
  const s = state.status.settings;
  $("#set-name").value = s.appName;
  $("#set-tagline").value = s.tagline;
  $("#set-credit").value = s.creditUsd;
  $("#card-editors").innerHTML = CARD_ORDER.map((id) => {
    const c = s.cards[id];
    return `<fieldset class="card-editor" data-editor="${id}">
      <legend>${esc(c.title)}</legend>
      <div class="ce-grid">
        <div class="ce-img" data-card-drop="${id}">
          ${c.image ? `<img src="${esc(c.image)}" alt="">` : `<span>Glissez une image ici</span>`}
        </div>
        <div class="ce-fields">
          <label class="field">Étiquette <input type="text" data-k="tag" maxlength="20" value="${esc(c.tag)}"></label>
          <label class="field">Titre <input type="text" data-k="title" maxlength="40" value="${esc(c.title)}"></label>
          <label class="field">Description <input type="text" data-k="desc" maxlength="120" value="${esc(c.desc)}"></label>
          <label class="field">Texte pour générer l'image avec l'IA <textarea data-k="prompt" rows="2" maxlength="600">${esc(c.prompt)}</textarea></label>
          <div class="row">
            <button class="btn sm ghost" type="button" data-ce-pick="${id}">Choisir une image</button>
            <button class="btn sm ghost" type="button" data-ce-gen="${id}">Générer avec l'IA</button>
            ${c.image ? `<button class="btn sm ghost" type="button" data-ce-del="${id}">Retirer l'image</button>` : ""}
          </div>
          <p class="fine" data-ce-note="${id}"></p>
        </div>
      </div></fieldset>`;
  }).join("");
  previewCredits();
}

function previewCredits() {
  const st = state.status;
  const v = Number($("#set-credit").value);
  if (!(v > 0)) { $("#set-preview").innerHTML = ""; $("#set-margin").textContent = ""; return; }
  // Recalcul à partir du coût fal réel de chaque exemple (même formule que le serveur).
  $("#set-preview").innerHTML = (st.creditExamples || []).map(([t, , usd]) => {
    const n = Math.max(1, Math.ceil(usd / v - 1e-9));
    return `<li>${esc(t)} : <strong>${n} crédit${n > 1 ? "s" : ""}</strong></li>`;
  }).join("");
  const pro = st.plans.pro, bas = st.plans.basique;
  const costPro = pro.credits * v, costBas = bas.credits * v;
  $("#set-margin").textContent = `Si un abonné utilise tous ses crédits, il vous coûte au maximum chez fal : Basique ${costBas.toFixed(2).replace(".", ",")} $ (il paie ${bas.month} $), Pro ${costPro.toFixed(2).replace(".", ",")} $ (il paie ${pro.month} $). Stripe prend aussi des frais (environ 1,5 % + 0,25 € par paiement avec une carte européenne).`
    + (costPro > pro.month * 0.9 || costBas > bas.month * 0.9 ? " ⚠ Attention : avec cette valeur, vous pouvez perdre de l'argent." : "");
}
$("#set-credit").addEventListener("input", previewCredits);

$("#card-editors").addEventListener("click", async (e) => {
  const pick = e.target.closest("[data-ce-pick]"), gen = e.target.closest("[data-ce-gen]"), del = e.target.closest("[data-ce-del]");
  if (pick) { pickFor = pick.dataset.cePick; cardPicker.click(); }
  if (del) {
    try { const r = await api(`/api/admin/cards/${del.dataset.ceDel}/image`, { method: "DELETE" }); state.status = r.status; applySettings(); renderSettingsForm(); }
    catch (err) { toast(err.message); }
  }
  if (gen) generateCardImage(gen.dataset.ceGen, gen);
});

async function generateCardImage(id, btn) {
  const note = (m) => { const el = $(`[data-ce-note="${id}"]`); if (el) el.textContent = m; };
  const prompt = $(`[data-editor="${id}"] [data-k="prompt"]`).value.trim();
  if (!prompt) return note("Écrivez d'abord le texte de l'image.");
  btn.disabled = true;
  note("Génération de l'image par l'IA… (quelques secondes)");
  try {
    let job = await api("/api/jobs", { method: "POST", body: JSON.stringify({ tool: "image", prompt, image_size: "portrait_4_3" }) });
    while (!["termine", "erreur"].includes(job.state)) {
      await new Promise((r) => setTimeout(r, 2500));
      job = await api(`/api/jobs/${job.id}`);
    }
    if (job.state === "erreur") throw new Error(job.error || "La génération a échoué.");
    const r = await api(`/api/admin/cards/${id}/image-from-job/${job.id}`, { method: "POST" });
    state.status = r.status; applySettings(); renderSettingsForm();
    note("Image générée et enregistrée ✓");
    $(`[data-ce-note="${id}"]`).textContent = "Image générée et enregistrée ✓";
  } catch (err) { note(err.message); btn.disabled = false; }
}

$("#brand-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#set-error").textContent = ""; $("#set-ok").textContent = "";
  const cards = {};
  $$("[data-editor]").forEach((fs) => { cards[fs.dataset.editor] = Object.fromEntries($$("[data-k]", fs).map((i) => [i.dataset.k, i.value])); });
  try {
    const r = await api("/api/admin/settings", { method: "POST", body: JSON.stringify({
      appName: $("#set-name").value, tagline: $("#set-tagline").value, creditUsd: $("#set-credit").value, cards,
    }) });
    state.status = r.status; applySettings(); renderPlans(); renderSettingsForm();
    $("#set-ok").textContent = "Enregistré ✓ Le site est à jour.";
  } catch (err) { $("#set-error").textContent = err.message; }
});


// ================= Générer toutes les images manquantes (administrateur) =================
let imagesTimer = null;
function drawImagesBar(st) {
  const bars = $$("[data-images-bar]");
  const show = isAdminUser() && configured() && (st.running || st.missing > 0 || st.errors?.length);
  bars.forEach((b) => b.classList.toggle("hidden", !show));
  if (!show) return;
  let html;
  if (st.running) {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    html = `<div><strong>Génération des images : ${st.done} / ${st.total}</strong><small>${esc(st.current || "")}</small></div>
      <div class="bar"><span data-w="${pct}"></span></div>`;
  } else {
    html = `<div><strong>${st.missing} image${st.missing > 1 ? "s" : ""} manquante${st.missing > 1 ? "s" : ""} sur le site</strong>
      <small>${st.missingCards} carte${st.missingCards > 1 ? "s" : ""} d'outils et ${st.missingGallery} inspiration${st.missingGallery > 1 ? "s" : ""}. Coût estimé chez fal : ≈ ${fmtUSD(st.estimateUsd)}.</small>
      ${st.errors?.length ? `<small class="err">Échecs : ${st.errors.map(esc).join(" · ")}</small>` : ""}</div>
      ${st.missing ? `<button class="btn" type="button" data-images-go>Générer toutes les images</button>` : ""}`;
  }
  bars.forEach((b) => { b.innerHTML = html; $$(".bar span[data-w]", b).forEach((s) => { s.style.width = `${s.dataset.w}%`; }); });
}
async function refreshImagesBar() {
  if (!isAdminUser() || !configured()) { drawImagesBar({ missing: 0 }); return; }
  try {
    const st = await api("/api/admin/images");
    drawImagesBar(st);
    clearTimeout(imagesTimer);
    if (st.running) imagesTimer = setTimeout(refreshImagesBar, 2500);
    else if (st.finishedAt && st.finishedAt !== refreshImagesBar.seen) { refreshImagesBar.seen = st.finishedAt; await reloadImages(); }
  } catch { /* ignoré : barre d'administration uniquement */ }
}
async function reloadImages() {
  try { state.manifest = await (await fetch("galerie/manifest.json", { cache: "no-store" })).json(); } catch { /* garde l'ancien */ }
  try { state.status = await (await fetch("/api/status")).json(); } catch { /* garde l'ancien */ }
  applySettings(); renderGallery();
  if (state.view === "reglages") renderSettingsForm();
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-images-go]");
  if (!b) return;
  b.disabled = true;
  try { drawImagesBar(await api("/api/admin/images", { method: "POST" })); refreshImagesBar.seen = null; imagesTimer = setTimeout(refreshImagesBar, 2500); }
  catch (err) { toast(err.message); b.disabled = false; }
});


// ================= Publier sur les réseaux (YouTube, TikTok, Facebook, Instagram…) =================
// Sans autorisation spéciale des plateformes : partage natif du téléphone/PC, ou téléchargement + page d'envoi officielle.
const PLATFORMS = {
  youtube: { label: "YouTube", url: "https://www.youtube.com/upload", video: true, tip: "Choisissez la chaîne en haut à droite (photo de profil → Changer de compte) avant d'envoyer." },
  tiktok: { label: "TikTok", url: "https://www.tiktok.com/upload", video: true, tip: "Sur téléphone, le bouton « Partager » est le plus simple : il ouvre directement l'application TikTok." },
  facebook: { label: "Facebook", url: "https://business.facebook.com/latest/composer", video: false, tip: "Dans Meta Business Suite, cochez la ou les pages Facebook et le compte Instagram où publier." },
  instagram: { label: "Instagram", url: "https://www.instagram.com/", video: false, tip: "Cliquez sur « Créer » (+) puis choisissez le fichier." },
};
function shareButtons(job) {
  if (!job.result) return "";
  const isVideo = job.result.mime?.startsWith("video/");
  const list = Object.entries(PLATFORMS).filter(([, p]) => isVideo || !p.video);
  return `<div class="share"><p>Publier sur les réseaux :</p><div class="row">
    <button class="btn sm" type="button" data-share="${job.id}">Partager…</button>
    ${list.map(([id, p]) => `<button class="btn ghost sm" type="button" data-post="${id}" data-job="${job.id}">${esc(p.label)}</button>`).join("")}
  </div><p class="fine" data-share-note="${job.id}"></p></div>`;
}
const jobById = (id) => (state.lastJobs || []).find((j) => j.id === id) || (state.currentJob?.id === id ? state.currentJob : null);
function shareNote(id, msg) { $$(`[data-share-note="${id}"]`).forEach((el) => { el.textContent = msg; }); }

document.addEventListener("click", async (e) => {
  const sh = e.target.closest("[data-share]");
  const po = e.target.closest("[data-post]");
  if (!sh && !po) return;
  const id = (sh || po).dataset.share || po.dataset.job;
  const job = jobById(id);
  if (!job?.result) return shareNote(id, "Création introuvable : rechargez la page.");
  if (sh) {
    sh.disabled = true;
    shareNote(id, "Préparation du fichier…");
    try {
      const res = await fetch(job.result.downloadUrl);
      if (!res.ok) throw new Error("Fichier expiré ou introuvable.");
      const blob = await res.blob();
      const name = (/filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "") || [])[1] || "creation.mp4";
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: state.status.settings?.appName || "" });
        shareNote(id, "");
      } else {
        shareNote(id, "Ce navigateur ne permet pas le partage direct. Utilisez les boutons des réseaux à côté.");
      }
    } catch (err) {
      shareNote(id, err.name === "AbortError" ? "" : err.message);
    } finally { sh.disabled = false; }
    return;
  }
  const p = PLATFORMS[po.dataset.post];
  // 1. Télécharge la vidéo  2. ouvre la page d'envoi officielle de la plateforme.
  const a = Object.assign(document.createElement("a"), { href: job.result.downloadUrl, download: "" });
  document.body.append(a); a.click(); a.remove();
  window.open(p.url, "_blank", "noopener");
  shareNote(id, `Fichier téléchargé. Sur la page ${p.label} qui s'ouvre, choisissez-le dans « Téléchargements ». ${p.tip}`);
});
