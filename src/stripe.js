// Abonnements Stripe, appels REST documentés :
// - POST /v1/checkout/sessions (mode=subscription, line_items, success_url, cancel_url,
//   client_reference_id, customer / customer_email, subscription_data[metadata])
//   https://docs.stripe.com/api/checkout/sessions/create
// - POST /v1/billing_portal/sessions (customer, return_url)
//   https://docs.stripe.com/api/customer_portal/sessions/create
// - Webhooks : en-tête Stripe-Signature « t=…,v1=… », HMAC-SHA256 de « t.corps_brut » avec le secret whsec_…
//   Événements : checkout.session.completed, invoice.paid, customer.subscription.updated / deleted
//   https://docs.stripe.com/subscriptions/webhooks
// - Depuis l'API 2025-03-31.basil, l'abonnement d'une facture est dans invoice.parent.subscription_details
//   https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects
import crypto from "node:crypto";

const API = "https://api.stripe.com/v1";
// Version d'API fixée : forme des objets vérifiée (invoice.parent.subscription_details).
const STRIPE_VERSION = "2025-03-31.basil";
const EVENTS = ["checkout.session.completed", "invoice.paid", "customer.subscription.updated", "customer.subscription.deleted"];
const TOLERANCE_SEC = 300;
const httpError = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Encode un objet imbriqué au format application/x-www-form-urlencoded de Stripe (a[b][0][c]=…).
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function verifySignature(rawBody, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const v1 = [];
  let t = null;
  for (const item of String(header).split(",")) {
    const [k, val] = item.split("=");
    if (k === "t") t = Number(val);
    if (k === "v1") v1.push(val);
  }
  if (!t || !v1.length || Math.abs(now - t) > TOLERANCE_SEC) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
}

export function createBilling({ cfg, db, accounts, fetchImpl = fetch }) {
  // Le paiement est possible dès que la clé et les prix existent ; le webhook (site en ligne)
  // sert aux renouvellements. En local, le premier paiement est confirmé au retour de Stripe.
  const enabled = () => !!(cfg.stripe.secretKey && Object.values(cfg.stripe.prices).every(Boolean));

  async function stripe(path, params, method = "POST", key = cfg.stripe.secretKey) {
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        ...(method === "POST" ? { body: formEncode(params).toString() } : {}),
      });
    } catch (e) {
      throw httpError(`Impossible de joindre Stripe (${e.message}).`, 502);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(`Erreur Stripe (HTTP ${res.status}) : ${body?.error?.message || "inconnue"}`, 502);
    return body;
  }

  async function checkout(user, plan, interval, origin) {
    if (!enabled()) throw httpError("Paiement non configuré sur ce serveur.", 503);
    const p = cfg.plans[plan];
    if (!p || !["month", "year"].includes(interval)) throw httpError("Formule inconnue.");
    const price = cfg.stripe.prices[`${plan}_${interval}`];
    const base = cfg.publicUrl || origin;
    const session = await stripe("/checkout/sessions", {
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: `${base}/#compte?paiement=ok&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/#tarifs`,
      client_reference_id: user.id,
      ...(user.stripeCustomer ? { customer: user.stripeCustomer } : { customer_email: user.email }),
      metadata: { user_id: user.id, plan, interval },
      subscription_data: { metadata: { user_id: user.id, plan, interval } },
      locale: "fr",
      allow_promotion_codes: "true",
    });
    return session.url;
  }

  async function portal(user, origin) {
    if (!enabled()) throw httpError("Paiement non configuré sur ce serveur.", 503);
    if (!user.stripeCustomer) throw httpError("Aucun abonnement à gérer.");
    const s = await stripe("/billing_portal/sessions", { customer: user.stripeCustomer, return_url: `${cfg.publicUrl || origin}/#compte` });
    return s.url;
  }

  // Crédits attribués à chaque facture payée : mensuel = crédits du mois ; annuel = 12 mois d'un coup.
  // Les crédits d'abonnement ne se cumulent pas d'une période à l'autre (remise au niveau de la formule).
  async function handleEvent(event) {
    if (db.data.events[event.id]) return "déjà traité";
    const obj = event.data?.object || {};
    let result = "ignoré";

    if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
      const user = db.data.users[obj.client_reference_id || obj.metadata?.user_id];
      if (user) {
        user.stripeCustomer = obj.customer || user.stripeCustomer;
        user.stripeSubscription = obj.subscription || user.stripeSubscription;
        user.plan = obj.metadata?.plan || user.plan;
        user.interval = obj.metadata?.interval || user.interval;
        result = "client lié";
      }
    }

    if (event.type === "invoice.paid") {
      const meta = obj.parent?.subscription_details?.metadata || obj.subscription_details?.metadata || {};
      const user = db.data.users[meta.user_id] || accounts.findByCustomer(obj.customer);
      const plan = cfg.plans[meta.plan || user?.plan];
      if (user && plan && obj.id && db.data.events[`invoice:${obj.id}`]) result = "facture déjà créditée";
      else if (user && plan) {
        if (obj.id) db.data.events[`invoice:${obj.id}`] = Date.now();
        const interval = meta.interval || user.interval || "month";
        const grant = plan.credits * (interval === "year" ? 12 : 1);
        user.credits = Math.max(user.credits || 0, grant);
        user.plan = meta.plan || user.plan;
        user.interval = interval;
        user.stripeCustomer = obj.customer || user.stripeCustomer;
        user.subscriptionStatus = "active";
        result = `crédits : ${user.credits}`;
      }
    }

    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const user = db.data.users[obj.metadata?.user_id] || accounts.findByCustomer(obj.customer);
      if (user) {
        user.subscriptionStatus = event.type.endsWith("deleted") ? "canceled" : obj.status;
        if (event.type.endsWith("deleted")) { user.plan = null; user.interval = null; }
        result = `statut : ${user.subscriptionStatus}`;
      }
    }

    db.data.events[event.id] = Date.now();
    await db.save();
    return result;
  }

  // Retour du client après paiement : on relit la session chez Stripe (source de vérité) et on attribue
  // les crédits de la première période. Idempotent avec le webhook invoice.paid (même facture).
  async function confirm(user, sessionId) {
    if (!enabled()) throw httpError("Paiement non configuré sur ce serveur.", 503);
    if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId))) throw httpError("Session de paiement invalide.");
    const session = await stripe(`/checkout/sessions/${sessionId}`, null, "GET");
    if (session.client_reference_id !== user.id) throw httpError("Ce paiement ne correspond pas à votre compte.", 403);
    if (session.status !== "complete" || session.payment_status !== "paid") return { confirmed: false };
    const meta = session.metadata || {};
    await handleEvent({ id: `checkout:${session.id}`, type: "checkout.session.completed", data: { object: session } });
    const invoiceKey = session.invoice ? `invoice:${session.invoice}` : `checkout-credit:${session.id}`;
    if (!db.data.events[invoiceKey]) {
      const plan = cfg.plans[meta.plan];
      if (plan) {
        user.credits = Math.max(user.credits || 0, plan.credits * (meta.interval === "year" ? 12 : 1));
        user.subscriptionStatus = "active";
      }
      db.data.events[invoiceKey] = Date.now();
      await db.save();
    }
    return { confirmed: true };
  }

  // Branchement depuis la page « Mon compte » (administrateur) : vérifie la clé, crée les 4 prix,
  // et le webhook si le site a une adresse publique en https.
  async function setup(secretKey, publicUrl) {
    const key = String(secretKey || "").trim();
    if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key)) throw httpError("Ce n'est pas une clé secrète Stripe (elle commence par « sk_test_ » ou « sk_live_ »).");
    const prices = {};
    for (const [id, p] of Object.entries(cfg.plans)) {
      for (const interval of ["month", "year"]) {
        const price = await stripe("/prices", {
          currency: "usd",
          unit_amount: Math.round(p[interval] * 100),
          recurring: { interval },
          product_data: { name: `Danse Studio ${p.label} (${interval === "month" ? "mensuel" : "annuel"})` },
          lookup_key: `danse_studio_${id}_${interval}`,
          transfer_lookup_key: "true",
        }, "POST", key);
        prices[`${id}_${interval}`] = price.id;
      }
    }
    let webhookSecret = "";
    const url = String(publicUrl || "").replace(/\/$/, "");
    if (/^https:\/\//.test(url)) {
      const ep = await stripe("/webhook_endpoints", { url: `${url}/api/stripe/webhook`, enabled_events: EVENTS, api_version: STRIPE_VERSION }, "POST", key);
      webhookSecret = ep.secret || "";
    }
    return { key, prices, webhookSecret, live: key.includes("_live_") };
  }

  async function webhook(rawBody, signature) {
    if (!verifySignature(rawBody, signature, cfg.stripe.webhookSecret)) throw httpError("Signature Stripe invalide.", 400);
    let event;
    try { event = JSON.parse(rawBody); } catch { throw httpError("Événement illisible."); }
    return handleEvent(event);
  }

  return { enabled, checkout, portal, webhook, handleEvent, confirm, setup, webhookReady: () => !!cfg.stripe.webhookSecret };
}
