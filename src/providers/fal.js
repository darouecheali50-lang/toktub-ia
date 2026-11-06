// Intégration fal.ai — uniquement des éléments documentés officiellement :
// - Envoi de fichiers : SDK @fal-ai/client, fal.storage.upload(Blob, { lifecycle })
//   https://fal.ai/docs/api-reference/client-libraries/javascript/storage.md
// - File d'attente REST : POST https://queue.fal.run/{endpoint_id}, puis status_url / response_url / cancel_url
//   renvoyées par la soumission. https://fal.ai/docs/documentation/model-apis/inference/queue.md
// - Statuts : IN_QUEUE (queue_position), IN_PROGRESS, COMPLETED (+ error / error_type en cas d'échec).
// - En-têtes : X-Fal-Object-Lifecycle-Preference, X-Fal-Store-IO.
//   https://fal.ai/docs/documentation/model-apis/media-expiration.md
// - Suppression d'un fichier CDN : POST https://rest.fal.ai/storage/files/delete
//   https://fal.ai/docs/documentation/model-apis/fal-cdn.md
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const QUEUE_BASE = "https://queue.fal.run";

export class ProviderError extends Error {
  constructor(message, { retryable = false, details } = {}) {
    super(message);
    this.retryable = retryable;
    this.details = details;
  }
}

export function createFalProvider({ key, fileTtlSeconds, fetchImpl = fetch }) {
  const authHeaders = { Authorization: `Key ${key}` };
  let sdk = null;

  async function getSdk() {
    if (sdk) return sdk;
    let mod;
    try {
      mod = await import("@fal-ai/client");
    } catch {
      throw new ProviderError("Le module @fal-ai/client n'est pas installé sur le serveur. Lancez « npm install ».");
    }
    mod.fal.config({ credentials: key });
    sdk = mod.fal;
    return sdk;
  }

  async function falJson(url, init = {}) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { ...authHeaders, ...(init.headers || {}) } });
    } catch (e) {
      throw new ProviderError(`Impossible de joindre fal.ai (${e.message}).`, { retryable: true });
    }
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    return { res, body };
  }

  return {
    name: "fal.ai",

    async uploadFile(filePath, mimeType) {
      const fal = await getSdk();
      const blob = await fs.openAsBlob(filePath, { type: mimeType });
      try {
        return await fal.storage.upload(blob, { lifecycle: { expiresIn: fileTtlSeconds } });
      } catch (e) {
        throw new ProviderError(`Échec de l'envoi du fichier vers fal.ai : ${describeSdkError(e)}`);
      }
    },

    async submit(model, input) {
      const { res, body } = await falJson(`${QUEUE_BASE}/${model}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fal-Object-Lifecycle-Preference": JSON.stringify({ expiration_duration_seconds: fileTtlSeconds }),
          "X-Fal-Store-IO": "0",
        },
        body: JSON.stringify(input),
      });
      if (!res.ok || !body?.request_id) {
        throw new ProviderError(httpErrorMessage(res.status, body, "création de la tâche"), { details: body });
      }
      return body; // { request_id, status_url, response_url, cancel_url, queue_position }
    },

    async status(task) {
      const { res, body } = await falJson(task.status_url);
      if (res.status === 404) throw new ProviderError("Tâche introuvable chez fal.ai.");
      if (!res.ok && res.status !== 202) {
        throw new ProviderError(httpErrorMessage(res.status, body, "suivi de la tâche"), { retryable: res.status >= 500 });
      }
      return body; // { status, queue_position?, error?, error_type?, metrics? }
    },

    async result(task) {
      const { res, body } = await falJson(task.response_url);
      if (!res.ok) throw new ProviderError(httpErrorMessage(res.status, body, "récupération du résultat"), { details: body });
      const videoUrl = body?.video?.url || null;
      const imageUrl = body?.images?.[0]?.url || null;
      if (!videoUrl && !imageUrl) throw new ProviderError("fal.ai n'a renvoyé aucun fichier.", { details: body });
      if (body?.has_nsfw_concepts?.[0]) throw new ProviderError("Le filtre de sécurité de fal.ai a bloqué ce résultat.");
      return { videoUrl, imageUrl, raw: body };
    },

    async download(url, dest) {
      let res;
      try { res = await fetchImpl(url); } catch (e) {
        throw new ProviderError(`Téléchargement de la vidéo générée impossible (${e.message}).`);
      }
      if (!res.ok || !res.body) throw new ProviderError(`Téléchargement de la vidéo générée impossible (HTTP ${res.status}).`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    },

    async cancel(task) {
      if (!task?.cancel_url) return;
      await falJson(task.cancel_url, { method: "PUT" }).catch(() => {});
    },

    // Suppression « au mieux » : nécessite une clé avec la permission assets:write.
    // Sinon les fichiers expirent automatiquement (FAL_FILE_TTL_SECONDS).
    async deleteFile(fileUrl) {
      if (!fileUrl) return false;
      const { res } = await falJson("https://rest.fal.ai/storage/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: fileUrl }),
      }).catch(() => ({ res: { ok: false } }));
      return !!res.ok;
    },
  };
}

function httpErrorMessage(status, body, step) {
  const detail = typeof body?.detail === "string" ? body.detail
    : Array.isArray(body?.detail) ? body.detail.map((d) => d.msg || JSON.stringify(d)).join(" ; ")
    : body?.error || "";
  const hint = {
    401: "Clé API fal invalide ou expirée (FAL_KEY).",
    403: "Accès refusé par fal.ai : vérifiez les permissions de la clé, le modèle autorisé ou le solde de crédits.",
    422: "Paramètres ou fichiers refusés par le modèle.",
    429: "Trop de requêtes chez fal.ai, réessayez plus tard.",
  }[status] || "";
  if (/exhausted balance|insufficient balance|top up/i.test(detail)) {
    return "Solde fal.ai épuisé : votre compte fal n'a plus de crédit. Rechargez-le sur fal.ai/dashboard/billing, puis réessayez.";
  }
  return `Erreur fal.ai pendant la ${step} (HTTP ${status}). ${hint} ${detail}`.trim();
}

function describeSdkError(e) {
  if (e?.status) return `HTTP ${e.status} ${typeof e.body?.detail === "string" ? e.body.detail : e.message || ""}`.trim();
  return e?.message || String(e);
}
