#!/usr/bin/env node
/**
 * Installation du dictionnaire Remède pour le serveur MCP.
 *
 * 1. Télécharge la base SQLite (≈ 719 Mo) depuis l'API officielle Remède
 *    (https://api-remede.camarm.fr/download?variant=remede) si absente.
 * 2. Vérifie l'intégrité du fichier (en-tête SQLite, nombre de mots).
 * 3. Crée les index de recherche et la colonne `phoneme_rev` (phonème inversé)
 *    qui permet les requêtes de rimes par suffixe phonétique en quelques ms.
 *
 * Le script est idempotent : relancer ne fait rien si tout est déjà en place.
 *
 * Options :
 *   --variant remede|remede.en    variante officielle (défaut : remede)
 *   --out <chemin>                fichier cible (défaut : data/remede.db du dépôt)
 *   --url <url>                   source alternative (miroir) du fichier SQLite
 *   --min-words <n>               seuil de complétude (défaut : 700000 ; la base
 *                                 anglaise remede.en en contient moins)
 *   --skip-download               ne télécharge pas : applique la migration à une
 *                                 base déjà téléchargée ou obtenue par un autre moyen
 */
import { DatabaseSync } from 'node:sqlite'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
function argOf(flag, fallback) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const REPO = path.dirname(fileURLToPath(import.meta.url))
const variant = argOf('--variant', 'remede')
const out = path.resolve(argOf('--out', path.join(REPO, 'data', 'remede.db')))
const urlOverride = argOf('--url', null)
const minWords = parseInt(argOf('--min-words', '700000'), 10)
const skipDownload = args.includes('--skip-download')
const sourceUrl = urlOverride ?? `https://api-remede.camarm.fr/download?variant=${variant}`

function log(msg) { console.error(msg) }

/** Vérifie qu'un fichier est une base Remède complète et migrée. */
function isReady(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) return { ok: false, reason: 'absente ou tronquée' }
  const header = Buffer.alloc(16)
  const fd = fs.openSync(file, 'r')
  fs.readSync(fd, header, 0, 16, 0)
  fs.closeSync(fd)
  if (!header.toString('latin1').startsWith('SQLite format 3')) return { ok: false, reason: "ce n'est pas une base SQLite" }
  try {
    const db = new DatabaseSync(file, { readOnly: true })
    const n = db.prepare('SELECT COUNT(*) AS n FROM dictionary').get().n
    const hasRev = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('dictionary') WHERE name = 'phoneme_rev'").get().n
    const hasIndex = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_phoneme_rev'").get().n
    db.close()
    if (n < minWords) return { ok: false, reason: `incomplète (${n} mots)`, n }
    return { ok: hasRev === 1 && hasIndex >= 1, reason: `${n} mots`, n, migrated: hasRev === 1 }
  } catch (e) {
    return { ok: false, reason: `illisible (${e.message})` }
  }
}

/**
 * Téléchargement avec vérification TLS désactivée : le certificat de
 * api-remede.camarm.fr était expiré au moment de l'écriture de ce script
 * (oct. 2026) et le serveur ignore les requêtes de plage (reprise impossible).
 */
function download(url, file) {
  return new Promise((resolve, reject) => {
    const request = (target, redirects) => {
      if (redirects > 5) return reject(new Error('trop de redirections'))
      log(`Téléchargement de ${target}…`)
      https.get(target, { rejectUnauthorized: false }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return request(new URL(res.headers.location, target).toString(), redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const total = Number(res.headers['content-length']) || 0
        const stream = fs.createWriteStream(file)
        let received = 0
        let lastPct = -1
        res.on('data', (chunk) => {
          received += chunk.length
          if (total > 0) {
            const pct = Math.floor((received / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct
              log(`  ${pct}% (${(received / 1e6).toFixed(0)} Mo / ${(total / 1e6).toFixed(0)} Mo)`)
            }
          }
        })
        res.pipe(stream)
        stream.on('finish', () => stream.close(resolve))
        stream.on('error', reject)
      }).on('error', reject)
    }
    request(url, 0)
  })
}

/** Ajoute les index et la colonne phoneme_rev si absents. */
function migrate(file) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = OFF')
    db.exec('CREATE INDEX IF NOT EXISTS idx_word ON dictionary(word)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_indexed ON dictionary(indexed)')
    const hasRev = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('dictionary') WHERE name = 'phoneme_rev'").get().n
    if (hasRev === 0) {
      db.exec('ALTER TABLE dictionary ADD COLUMN phoneme_rev TEXT')
      // Fonction scalaire : inversion de chaîne pour l'index de rimes par suffixe.
      db.function('remede_rev', (s) => [...s].reverse().join(''))
      const t0 = Date.now()
      db.exec('UPDATE dictionary SET phoneme_rev = remede_rev(phoneme)')
      log(`Colonne phoneme_rev remplie en ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_phoneme_rev ON dictionary(phoneme_rev)')
    db.exec('PRAGMA journal_mode = DELETE')
  } finally {
    db.close()
  }
}

const t0 = Date.now()
log(`Cible : ${out}`)
const state = isReady(out)
if (state.ok) {
  log(`Déjà installé et migré (${state.reason}). Rien à faire.`)
  process.exit(0)
}

if (!skipDownload) {
  if (fs.existsSync(out)) log(`Base existante ignorée (${state.reason}) — nouveau téléchargement.`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) log(`Nouvelle tentative (${attempt}/3) dans quelques secondes…`)
    try {
      await download(sourceUrl, out)
      break
    } catch (e) {
      log(`Échec du téléchargement : ${e.message}`)
      fs.rmSync(out, { force: true })
      if (attempt === 3) {
        console.error(
          'Impossible de joindre la source (le serveur Remède est parfois instable).\n' +
          '  - réessayez plus tard :            npm run setup\n' +
          '  - base obtenue autrement ?         node setup.mjs --skip-download\n' +
          '  - miroir disponible ?              node setup.mjs --url <URL du fichier .db>'
        )
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 5000 * attempt))
    }
  }
} else if (!fs.existsSync(out)) {
  console.error(`--skip-download : aucune base trouvée à migrer sur ${out}`)
  process.exit(1)
}

const check = isReady(out)
if (!check.n) {
  console.error(`Échec : la base est invalide (${check.reason}).`)
  if (!skipDownload) fs.rmSync(out, { force: true })
  process.exit(1)
}
log(`Base vérifiée : ${check.reason}.`)

if (!state.migrated) {
  log('Application des index (une fois, peut prendre ~1 min)…')
  await migrate(out)
}

const final = isReady(out)
if (!final.ok) {
  console.error(`Échec de la migration (${final.reason}).`)
  process.exit(1)
}
log(`Installation terminée en ${((Date.now() - t0) / 1000).toFixed(0)} s — ${final.reason}, index de rimes prêts.`)
