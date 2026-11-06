// Vérifie que l'intégration fal envoie exactement les requêtes documentées
// (fetch simulé : aucun appel réseau).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFalProvider } from "../src/providers/fal.js";

function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responses.shift();
    return new Response(r.body == null ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { fn, calls };
}

const MODEL = "fal-ai/wan/v2.2-14b/animate/move";

test("soumission : URL de file d'attente, authentification et en-têtes de conservation", async () => {
  const m = mockFetch([{ body: { request_id: "abc", status_url: "https://queue.fal.run/fal-ai/wan/requests/abc/status", response_url: "https://queue.fal.run/fal-ai/wan/requests/abc", cancel_url: "https://queue.fal.run/fal-ai/wan/requests/abc/cancel", queue_position: 0 } }]);
  const p = createFalProvider({ key: "KEY123", fileTtlSeconds: 3600, fetchImpl: m.fn });
  const task = await p.submit(MODEL, { video_url: "v", image_url: "i", resolution: "480p" });
  assert.equal(task.request_id, "abc");
  const c = m.calls[0];
  assert.equal(c.url, "https://queue.fal.run/fal-ai/wan/v2.2-14b/animate/move");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Key KEY123");
  assert.equal(c.init.headers["X-Fal-Object-Lifecycle-Preference"], '{"expiration_duration_seconds":3600}');
  assert.equal(c.init.headers["X-Fal-Store-IO"], "0");
});

test("suivi : utilise les URL renvoyées et transmet les erreurs du fournisseur", async () => {
  const task = { status_url: "https://queue.fal.run/x/y/requests/1/status", response_url: "https://queue.fal.run/x/y/requests/1", cancel_url: "https://queue.fal.run/x/y/requests/1/cancel" };
  const m = mockFetch([
    { status: 202, body: { status: "IN_QUEUE", queue_position: 3 } },
    { status: 200, body: { status: "COMPLETED", error: "boom", error_type: "runner_error" } },
    { status: 401, body: { detail: "Invalid key" } },
    { status: 200, body: { seed: 1 } },
    { status: 200, body: { video: { url: "https://v3b.fal.media/files/out.mp4" } } },
  ]);
  const p = createFalProvider({ key: "K", fileTtlSeconds: 60, fetchImpl: m.fn });
  assert.equal((await p.status(task)).queue_position, 3);
  assert.equal((await p.status(task)).error, "boom");
  await assert.rejects(p.status(task), /HTTP 401.*Clé API fal invalide.*Invalid key/);
  await assert.rejects(p.result(task), /aucun fichier/);
  assert.equal((await p.result(task)).videoUrl, "https://v3b.fal.media/files/out.mp4");
  assert.equal(m.calls[0].url, task.status_url);
  assert.equal(m.calls[3].url, task.response_url);
});

test("refus de paramètres (422) : message clair", async () => {
  const m = mockFetch([{ status: 422, body: { detail: [{ msg: "image_url: invalid" }] } }]);
  const p = createFalProvider({ key: "K", fileTtlSeconds: 60, fetchImpl: m.fn });
  await assert.rejects(p.submit(MODEL, {}), /HTTP 422.*refusés par le modèle.*image_url: invalid/);
});

test("annulation : PUT sur cancel_url", async () => {
  const m = mockFetch([{ status: 202, body: { status: "CANCELLATION_REQUESTED" } }]);
  const p = createFalProvider({ key: "K", fileTtlSeconds: 60, fetchImpl: m.fn });
  await p.cancel({ cancel_url: "https://queue.fal.run/x/y/requests/1/cancel" });
  assert.equal(m.calls[0].init.method, "PUT");
});

test("solde fal épuisé (403) : message clair en français", async () => {
  const m = mockFetch([{ status: 403, body: { detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." } }]);
  const p = createFalProvider({ key: "K", fileTtlSeconds: 60, fetchImpl: m.fn });
  await assert.rejects(p.submit(MODEL, {}), /Solde fal\.ai épuisé.*fal\.ai\/dashboard\/billing/);
});
