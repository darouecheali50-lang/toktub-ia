// Comptes clients : inscription, connexion (mot de passe haché scrypt), sessions par cookie, crédits.
import crypto from "node:crypto";

const SESSION_DAYS = 30;
const COOKIE = "ds_session";
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function createAccounts({ db, cfg }) {
  const attempts = new Map(); // ip -> { count, until }

  const clientIp = (req) => {
    if (cfg.trustProxy && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
    return req.socket.remoteAddress || "?";
  };
  const isAdmin = (u) => cfg.adminEmails.includes(u.email);

  function publicUser(u) {
    return {
      id: u.id, email: u.email, credits: isAdmin(u) ? null : u.credits, unlimited: isAdmin(u),
      plan: u.plan || null, interval: u.interval || null, subscriptionStatus: u.subscriptionStatus || null,
      canManageBilling: !!u.stripeCustomer,
    };
  }

  function throttle(req) {
    const ip = clientIp(req);
    const a = attempts.get(ip);
    if (a && a.count >= 10 && a.until > Date.now()) throw httpError("Trop d'essais. Réessayez dans 15 minutes.", 429);
    return {
      fail() {
        const next = a && a.until > Date.now() ? a : { count: 0, until: Date.now() + 15 * 60 * 1000 };
        next.count++;
        attempts.set(ip, next);
      },
      ok() { attempts.delete(ip); },
    };
  }

  function validate(email, password) {
    email = String(email || "").trim().toLowerCase();
    password = String(password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) throw httpError("Adresse e-mail invalide.");
    if (password.length < 8 || password.length > 200) throw httpError("Le mot de passe doit contenir au moins 8 caractères.");
    return { email, password };
  }

  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString("hex");
    db.data.sessions[token] = { userId, exp: Date.now() + SESSION_DAYS * 864e5 };
    await db.save();
    return token;
  }

  function cookieHeader(req, token, maxAgeSec) {
    const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
  }

  async function signup(req, body) {
    const t = throttle(req);
    const { email, password } = validate(body.email, body.password);
    if (db.data.emails[email]) { t.fail(); throw httpError("Un compte existe déjà avec cette adresse. Connectez-vous."); }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt)).toString("hex");
    const id = crypto.randomBytes(12).toString("hex");
    const user = { id, email, salt, hash, credits: cfg.freeCredits, createdAt: Date.now() };
    db.data.users[id] = user;
    db.data.emails[email] = id;
    const token = await newSession(id);
    return { user, cookie: cookieHeader(req, token, SESSION_DAYS * 86400) };
  }

  async function login(req, body) {
    const t = throttle(req);
    const email = String(body.email || "").trim().toLowerCase();
    const user = db.data.users[db.data.emails[email]];
    const given = await scrypt(String(body.password || ""), user ? user.salt : "x".repeat(32));
    if (!user || !crypto.timingSafeEqual(given, Buffer.from(user.hash, "hex"))) { t.fail(); throw httpError("E-mail ou mot de passe incorrect.", 401); }
    t.ok();
    const token = await newSession(user.id);
    return { user, cookie: cookieHeader(req, token, SESSION_DAYS * 86400) };
  }

  function tokenOf(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || "");
    return m ? m[1] : null;
  }

  function current(req) {
    const token = tokenOf(req);
    const s = token && db.data.sessions[token];
    if (!s) return null;
    if (s.exp < Date.now()) { delete db.data.sessions[token]; db.save(); return null; }
    return db.data.users[s.userId] || null;
  }

  async function logout(req) {
    const token = tokenOf(req);
    if (token) { delete db.data.sessions[token]; await db.save(); }
    return cookieHeader(req, "", 0);
  }

  // Débite des crédits ; renvoie une fonction de remboursement (en cas d'échec de la génération).
  async function charge(user, amount) {
    if (isAdmin(user)) return async () => {};
    if (user.credits < amount) {
      throw httpError(`Crédits insuffisants : cette création demande ${amount} crédit${amount > 1 ? "s" : ""}, il vous en reste ${user.credits}. Choisissez un abonnement.`, 402);
    }
    user.credits -= amount;
    await db.save();
    let refunded = false;
    return async () => { if (refunded) return; refunded = true; user.credits += amount; await db.save(); };
  }

  async function refundTo(userId, amount) {
    const u = db.data.users[userId];
    if (!u || isAdmin(u)) return;
    u.credits += amount;
    await db.save();
  }

  const findByCustomer = (customerId) => Object.values(db.data.users).find((u) => u.stripeCustomer === customerId) || null;

  return { signup, login, logout, current, publicUser, charge, refundTo, isAdmin, findByCustomer, cookieName: COOKIE };
}
