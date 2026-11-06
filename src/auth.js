// Protection des routes coûteuses : code d'accès privé (APP_ACCESS_CODE)
// envoyé dans l'en-tête X-Access-Code, comparaison à temps constant,
// et blocage temporaire après trop d'essais erronés.
import crypto from "node:crypto";

export function createAuth(cfg) {
  const attempts = new Map(); // ip -> { count, until }
  const WINDOW = 15 * 60 * 1000;
  const MAX_FAILS = 8;

  const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xf = req.headers["x-forwarded-for"];
      if (xf) return String(xf).split(",")[0].trim();
    }
    return req.socket.remoteAddress || "?";
  }

  // Renvoie null si autorisé, sinon { status, message }.
  function check(req) {
    if (!cfg.accessCode) return { status: 503, message: "Service vidéo non configuré." };
    const ip = clientIp(req);
    const a = attempts.get(ip);
    if (a && a.count >= MAX_FAILS && a.until > Date.now()) {
      return { status: 429, message: "Trop d'essais de code erronés. Réessayez dans 15 minutes." };
    }
    const given = req.headers["x-access-code"] || "";
    if (given && crypto.timingSafeEqual(digest(given), digest(cfg.accessCode))) {
      attempts.delete(ip);
      return null;
    }
    const next = a && a.until > Date.now() ? a : { count: 0, until: Date.now() + WINDOW };
    next.count++;
    attempts.set(ip, next);
    return { status: 401, message: given ? "Code d'accès incorrect." : "Code d'accès requis." };
  }

  return { check };
}
