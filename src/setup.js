// Configuration initiale depuis la page (uniquement sur l'ordinateur lui-même, tant que la clé n'est pas définie).
// La clé est écrite dans .env côté serveur ; elle n'est jamais renvoyée au navigateur.
import fs from "node:fs";
import path from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function setupAllowed(req, cfg) {
  if (cfg.falKey) return false;
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) return false;
  return LOOPBACK.has(req.socket.remoteAddress);
}

function setLine(text, name, value) {
  const re = new RegExp(`^${name}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.replace(/\s*$/, "")}\n${name}=${value}\n`;
}

// Contenu actuel du fichier d'environnement ; à défaut le modèle .env.example ; à défaut un fichier vide
// (en ligne, le modèle peut manquer : les fichiers commençant par un point ne sont pas toujours envoyés).
function readEnvText(cfg, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const example = path.join(cfg.root, ".env.example");
  return fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "";
}

export function writeEnv(cfg, entries) {
  const file = cfg.envFile || path.join(cfg.root, ".env");
  let text = readEnvText(cfg, file);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.replace(/\r\n/g, "\n");
  for (const [k, v] of Object.entries(entries)) text = setLine(text, k, v);
  fs.writeFileSync(file, text.replace(/\n/g, eol), { mode: 0o600 });
}

export function saveSetup(cfg, { falKey, adminEmail }) {
  const key = String(falKey || "").trim();
  const email = String(adminEmail || "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_\-:.]{16,300}$/.test(key)) throw Object.assign(new Error("Cette clé ne ressemble pas à une clé fal (elle commence en général par « fal_sk_ »). Recopiez-la avec le bouton Copy de fal.ai."), { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw Object.assign(new Error("Adresse e-mail invalide."), { status: 400 });
  const file = cfg.envFile || path.join(cfg.root, ".env");
  let text = readEnvText(cfg, file);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  text = text.replace(/\r\n/g, "\n");
  text = setLine(text, "FAL_KEY", key);
  if (email) text = setLine(text.replace(/^APP_ACCESS_CODE=.*\n?/m, ""), "ADMIN_EMAILS", email);
  fs.writeFileSync(file, text.replace(/\n/g, eol), { mode: 0o600 });
  cfg.falKey = key;
  if (email && !cfg.adminEmails.includes(email)) cfg.adminEmails.push(email);
}
