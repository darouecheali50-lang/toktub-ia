// Petite base de données JSON (comptes, sessions, crédits).
// Écriture atomique (fichier temporaire + renommage), sérialisée.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "db.json");
  let data = { users: {}, sessions: {}, emails: {}, events: {} };
  if (fs.existsSync(file)) {
    try { data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch { throw new Error(`Base de données illisible : ${file}. Restaurez une sauvegarde ou supprimez ce fichier.`); }
  }
  let chain = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(data);
    chain = chain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, snapshot, { mode: 0o600 });
      await fsp.rename(tmp, file);
    }).catch((e) => console.error("Sauvegarde de la base impossible :", e.message));
    return chain;
  };
  return { data, save, flush: () => chain };
}
