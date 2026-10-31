#!/usr/bin/env node
/**
 * Serveur MCP « Remède » — dictionnaire français hors-ligne.
 *
 * Données : Remède 1.4.0 (https://github.com/camarm-dev/remede), ~845 000 mots :
 * définitions, exemples, synonymes, antonymes, étymologies, pluriels,
 * phonèmes (IPA), conjugaisons et rimes.
 *
 * Base SQLite locale ouverte en lecture seule — aucun accès réseau.
 * La colonne phoneme_rev (phonème inversé, indexée) permet les requêtes
 * de rimes par suffixe phonétique en quelques millisecondes.
 */
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const DEFAULT_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'remede.db')

function openDatabase(file: string) {
  try {
    return new DatabaseSync(file, { readOnly: true })
  } catch {
    console.error(`[remede-mcp] Base du dictionnaire introuvable ou illisible : ${file}`)
    console.error('[remede-mcp] Installez-la avec « npm run setup », ou pointez REMEDE_DB vers un remede.db valide.')
    process.exit(1)
  }
}

const db = openDatabase(process.env.REMEDE_DB ?? DEFAULT_DB)
db.exec('PRAGMA case_sensitive_like = ON')

type Example = { content: string, sources: string | string[] }
type Definition = {
  gender: string
  nature: string
  explanations: (string | string[])[]
  examples: Example[]
}
type WordDoc = {
  synonyms: string[]
  antonyms: string[]
  etymologies: string[]
  definitions: Definition[]
  plurals: { label: string, singular: string, plural: string }[]
  sources: string[]
  phoneme: string
  pronunciation: { audio: string, credits: string } | null
  conjugations: Record<string, Record<string, Record<string, string>>> | null
}
type WordMeta = {
  word: string
  phoneme: string
  nature: string
  syllables: number
  min_syllables: number
  max_syllables: number
  elidable: number
  feminine: number
}

const sourcesById = new Map<string, { label: string, url: string }>()
for (const row of db.prepare('SELECT identifier, label, url FROM sources').all() as { identifier: string, label: string, url: string }[]) {
  sourcesById.set(row.identifier, { label: row.label, url: row.url })
}

const stmtDoc = db.prepare('SELECT document FROM dictionary WHERE word = ?')
const stmtMeta = db.prepare('SELECT word, phoneme, nature, syllables, min_syllables, max_syllables, elidable, feminine FROM dictionary WHERE word = ?')
const stmtSearch = db.prepare("SELECT word FROM dictionary WHERE indexed LIKE ? ESCAPE '\\' ORDER BY lower(word) ASC LIMIT ? OFFSET ?")
const stmtVariants = db.prepare('SELECT word, document FROM dictionary WHERE indexed = ? ORDER BY lower(word) ASC')
const stmtRandom = db.prepare("SELECT word FROM dictionary WHERE nature != 'VER' AND nature != '' ORDER BY RANDOM() LIMIT 1")

/** Normalisation identique à l'app Remède : minuscules, sans accents, - et ' deviennent espaces. */
function normalize(query: string): string {
  return query
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[-''ʼ]/g, ' ')
    .trim()
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c)
}

/** Cherche le document d'un mot, insensible à la casse et aux accents. */
function lookup(word: string): { word: string, doc: WordDoc } | null {
  const parse = (raw: string): WordDoc | null => {
    const parsed: unknown = JSON.parse(raw)
    // ~4 200 entrées de la base valent « false » (échecs de parsing Remède) — traitées comme absentes.
    return parsed !== null && typeof parsed === 'object' ? parsed as WordDoc : null
  }
  const direct = stmtDoc.get(word) as { document: string } | undefined
  if (direct) {
    const doc = parse(direct.document)
    if (doc) return { word, doc }
  }
  const variants = stmtVariants.all(normalize(word)) as { word: string, document: string }[]
  for (const variant of variants) {
    const target = word.toLowerCase()
    if (variant.word.toLowerCase() !== target) continue
    const doc = parse(variant.document)
    if (doc) return { word: variant.word, doc }
  }
  for (const variant of variants) {
    const doc = parse(variant.document)
    if (doc) return { word: variant.word, doc }
  }
  return null
}

function suggestions(word: string): string[] {
  const prefix = normalize(word).slice(0, Math.max(3, normalize(word).length - 2))
  if (prefix.length < 2) return []
  return (stmtSearch.all(escapeLike(prefix) + '%', 5, 0) as { word: string }[]).map((r) => r.word)
}

function notFound(word: string): string {
  const near = suggestions(word)
  return near.length > 0
    ? `Mot « ${word} » introuvable dans le dictionnaire. Mots proches : ${near.join(', ')}.`
    : `Mot « ${word} » introuvable dans le dictionnaire.`
}

function flattenExplanation(explanation: string | string[]): string {
  return clean(Array.isArray(explanation) ? explanation.join(' — ') : explanation)
}

/** Entités nommées héritées du HTML du Wiktionnaire. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', oelig: 'œ',
}

function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}

/**
 * Les documents Remède héritent du HTML du Wiktionnaire : balises <reference>, <i>, <b>,
 * entités &#160; (espace insécable)… Pour un modèle de langage, on sert du texte :
 * les balises sont retirées en conservant leur contenu (le gras wiktionnairien marque
 * la segmentation morphologique, pas une emphase), les entités sont décodées et
 * les espaces insécables deviennent des espaces simples.
 */
function clean(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

function fmtDefinition(d: Definition, index: number): string {
  const parts: string[] = []
  const tags = [d.nature, d.gender].filter((t) => t && t.trim() !== '')
  parts.push(`${index}. ${tags.length > 0 ? `(${tags.join(', ')}) ` : ''}${d.explanations.map((e) => flattenExplanation(e)).join(' ')}`)
  for (const example of d.examples ?? []) {
    parts.push(`   › ${clean(example.content)}`)
  }
  return parts.join('\n')
}

function fmtWordHeader(word: string, doc: WordDoc, meta: WordMeta | undefined): string {
  const nature = meta && meta.nature !== '' ? ` (${meta.nature})` : ''
  let syllabes = ''
  if (meta) {
    if (meta.min_syllables === meta.max_syllables) {
      syllabes = ` — ${meta.min_syllables} syllabe${meta.min_syllables > 1 ? 's' : ''}`
    } else if (meta.min_syllables > 0) {
      syllabes = ` — ${meta.min_syllables} à ${meta.max_syllables} syllabes`
    }
  }
  return `# ${word}${nature}\n\nPrononciation : ${doc.phoneme}${syllabes}`
}

/* ------------------------------------------------------------- outils ---- */

const zMot = z.string().min(1).describe('Le mot à chercher (accentuation libre)')
const server = new McpServer({ name: 'remede', version: '1.4.0' })

  server.registerTool('mot', {
    title: 'Fiche complète d\'un mot',
    description: 'Renvoie la fiche complète d\'un mot français du dictionnaire Remède : définitions numérotées avec exemples, synonymes, antonymes, étymologies, pluriels, prononciation phonétique (IPA) et sources.',
    inputSchema: { mot: zMot },
  }, async ({ mot }) => {
    const found = lookup(mot.trim())
    if (!found) return { content: [{ type: 'text', text: notFound(mot) }] }
    const { word, doc } = found
    const meta = stmtMeta.get(word) as WordMeta | undefined
    const out: string[] = [fmtWordHeader(word, doc, meta)]

    out.push('\n## Définitions')
    doc.definitions.forEach((d, i) => out.push(fmtDefinition(d, i + 1)))

    if (doc.synonyms.length > 0) out.push(`\n## Synonymes\n${doc.synonyms.join(', ')}`)
    if (doc.antonyms.length > 0) out.push(`\n## Antonymes\n${doc.antonyms.join(', ')}`)
    if (doc.etymologies.length > 0) out.push(`\n## Étymologie\n${doc.etymologies.map(clean).join('\n')}`)
    if (doc.plurals.length > 0) {
      out.push(`\n## Pluriels\n${doc.plurals.map((p) => `${clean(p.label)} : ${clean(p.singular)} → ${clean(p.plural)}`).join('\n')}`)
    }
    if (doc.conjugations && Object.keys(doc.conjugations).length > 0) {
      out.push(`\n## Conjugaison\nCe mot est un verbe — utilisez l'outil « conjuguer » pour le tableau complet (${Object.keys(doc.conjugations).length} modes).`)
    }
    if (doc.pronunciation?.audio) out.push(`\nAudio : ${doc.pronunciation.audio}`)
    const sources = doc.sources.map((id) => sourcesById.get(id)).filter((s) => s !== undefined)
    if (sources.length > 0) out.push(`\nSources : ${sources.map((s) => `${s.label} (${s.url})`).join(' ; ')}`)
    return { content: [{ type: 'text', text: out.join('\n') }] }
  })

  server.registerTool('definir', {
    title: 'Définitions d\'un mot',
    description: 'Renvoie uniquement les définitions d\'un mot français, avec domaines et exemples d\'usage. Réponse compacte.',
    inputSchema: { mot: zMot },
  }, async ({ mot }) => {
    const found = lookup(mot.trim())
    if (!found) return { content: [{ type: 'text', text: notFound(mot) }] }
    const { word, doc } = found
    const body = doc.definitions.map((d, i) => fmtDefinition(d, i + 1)).join('\n')
    return { content: [{ type: 'text', text: `${word} (${doc.phoneme})\n${body}` }] }
  })

  server.registerTool('synonymes', {
    title: 'Synonymes d\'un mot',
    description: 'Renvoie la liste des synonymes d\'un mot français.',
    inputSchema: { mot: zMot },
  }, async ({ mot }) => {
    const found = lookup(mot.trim())
    if (!found) return { content: [{ type: 'text', text: notFound(mot) }] }
    if (found.doc.synonyms.length === 0) return { content: [{ type: 'text', text: `Aucun synonyme répertorié pour « ${found.word} ».` }] }
    return { content: [{ type: 'text', text: `Synonymes de « ${found.word} » : ${found.doc.synonyms.join(', ')}` }] }
  })

  server.registerTool('antonymes', {
    title: 'Antonymes d\'un mot',
    description: 'Renvoie la liste des antonymes (contraires) d\'un mot français.',
    inputSchema: { mot: zMot },
  }, async ({ mot }) => {
    const found = lookup(mot.trim())
    if (!found) return { content: [{ type: 'text', text: notFound(mot) }] }
    if (found.doc.antonyms.length === 0) return { content: [{ type: 'text', text: `Aucun antonyme répertorié pour « ${found.word} ».` }] }
    return { content: [{ type: 'text', text: `Antonymes de « ${found.word} » : ${found.doc.antonyms.join(', ')}` }] }
  })

  server.registerTool('rimes', {
    title: 'Rimes d\'un mot',
    description: 'Cherche les mots qui riment avec un mot français, par suffixe phonétique (IPA). Exemple : les rimes de « amour » en qualité 2 se terminent par le son /uʁ/. Par défaut, toutes natures et genres de rimes confondus.',
    inputSchema: {
      mot: zMot,
      qualite: z.number().int().min(1).max(10).default(3).describe('Nombre de phonèmes finals partagés (qualité de la rime). 1 = pauvre, 3 = suffisante, 4+ = riche'),
      syllabes_min: z.number().int().min(0).max(15).default(0).describe('Nombre minimal de syllabes des mots qui riment (0 = indifférent)'),
      syllabes_max: z.number().int().min(0).max(15).default(0).describe('Nombre maximal de syllabes des mots qui riment (0 = indifférent)'),
      feminines: z.boolean().default(false).describe('true = uniquement les rimes féminines (finissant par un e caduc sonore)'),
      elisions: z.boolean().default(false).describe('true = inclure les mots élidables dont une syllabe peut disparaître (ex. « arbre » → « arbre-à »)'),
      nature: z.array(z.enum(['NOM', 'VER', 'ADJ', 'ADV', 'PRE', 'CON', 'PRO', 'AUX', 'ONO'])).default([]).describe('Filtrer par nature grammaticale (vide = toutes)'),
      limite: z.number().int().min(1).max(100).default(50).describe('Nombre maximal de résultats'),
      page: z.number().int().min(0).default(0).describe('Page de résultats (50 rimes par page par défaut)'),
    },
  }, async ({ mot, qualite, syllabes_min, syllabes_max, feminines, elisions, nature, limite, page }) => {
    const trimmed = mot.trim()
    let meta = stmtMeta.get(trimmed) as WordMeta | undefined
    if (!meta) {
      const found = lookup(trimmed)
      if (found) meta = stmtMeta.get(found.word) as WordMeta | undefined
    }
    if (!meta) return { content: [{ type: 'text', text: notFound(mot) }] }
    const phonemes = [...meta.phoneme]
    const suffix = phonemes.slice(-Math.min(qualite, phonemes.length)).join('')
    const revSuffix = [...suffix].reverse().join('')

    const clauses = ['phoneme_rev LIKE ? ESCAPE \'\\\'']
    const params: unknown[] = [escapeLike(revSuffix) + '%']
    clauses.push('? = 0 OR max_syllables >= ?')
    params.push(syllabes_max, syllabes_min)
    clauses.push('? = 0 OR min_syllables <= ? OR (elidable = 1 AND ? = 1 AND min_syllables - 1 <= ?)')
    params.push(syllabes_min, syllabes_max, elisions ? 1 : 0, syllabes_max)
    clauses.push('feminine = 1 OR ? = 0')
    params.push(feminines ? 1 : 0)
    if (nature.length > 0) {
      const natureClauses = nature.map((n) => 'nature LIKE ?')
      params.push(...nature.map((n) => `%${n}%`))
      clauses.push(`(${natureClauses.join(' OR ')})`)
    }
    const where = clauses.map((c) => `(${c})`).join(' AND ')

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM dictionary WHERE ${where}`).get(...params) as { n: number }).n
    const rows = db.prepare(`SELECT word, phoneme, feminine, elidable FROM dictionary WHERE ${where} ORDER BY lower(word) ASC LIMIT ? OFFSET ?`)
      .all(...params, limite, page * limite) as { word: string, phoneme: string, feminine: number, elidable: number }[]

    if (total === 0) {
      return { content: [{ type: 'text', text: `Aucune rime trouvée pour « ${meta.word} » (son /${suffix}/, qualité ${qualite}).` }] }
    }
    const lines = rows.map((r) => {
      const marks = [r.feminine === 1 ? 'fém.' : '', r.elidable === 1 ? 'élidable' : ''].filter(Boolean).join(', ')
      return `- ${r.word} /${r.phoneme}/${marks ? ` (${marks})` : ''}`
    })
    const header = `${total} rime${total > 1 ? 's' : ''} pour « ${meta.word} » — son final /${suffix}/ (qualité ${qualite}), affichage ${page * limite + 1}–${page * limite + rows.length} :`
    return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }] }
  })

  server.registerTool('rechercher', {
    title: 'Rechercher des mots',
    description: 'Recherche par préfixe dans 845 000 mots français (insensible à la casse et aux accents). Utile pour compléter un mot ou explorer le vocabulaire.',
    inputSchema: {
      requete: z.string().min(1).describe('Début du mot cherché'),
      limite: z.number().int().min(1).max(100).default(20).describe('Nombre maximal de résultats'),
      page: z.number().int().min(0).default(0).describe('Page de résultats'),
    },
  }, async ({ requete, limite, page }) => {
    const normalized = normalize(requete)
    if (normalized === '') return { content: [{ type: 'text', text: 'Requête vide après normalisation.' }] }
    const rows = stmtSearch.all(escapeLike(normalized) + '%', limite, page * limite) as { word: string }[]
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `Aucun mot ne commence par « ${requete} ».` }] }
    }
    return { content: [{ type: 'text', text: rows.map((r) => r.word).join(', ') }] }
  })

  server.registerTool('aleatoire', {
    title: 'Mot au hasard',
    description: 'Renvoie un mot français au hasard, avec sa fiche complète.',
    inputSchema: {},
  }, async () => {
    const row = stmtRandom.get() as { word: string } | undefined
    if (!row) return { content: [{ type: 'text', text: 'Erreur : tirage impossible.' }] }
    const found = lookup(row.word)
    if (!found) return { content: [{ type: 'text', text: row.word }] }
    const meta = stmtMeta.get(found.word) as WordMeta | undefined
    const out = [fmtWordHeader(found.word, found.doc, meta), '\n## Définitions']
    found.doc.definitions.forEach((d, i) => out.push(fmtDefinition(d, i + 1)))
    if (found.doc.synonyms.length > 0) out.push(`\n## Synonymes\n${found.doc.synonyms.join(', ')}`)
    return { content: [{ type: 'text', text: out.join('\n') }] }
  })

  server.registerTool('conjuguer', {
    title: 'Conjuguer un verbe',
    description: 'Renvoie le tableau de conjugaison complet d\'un verbe français : indicatif, subjonctif, conditionnel, impératif et participe, à tous les temps et personnes.',
    inputSchema: { verbe: zMot },
  }, async ({ verbe }) => {
    const found = lookup(verbe.trim())
    if (!found) return { content: [{ type: 'text', text: notFound(verbe) }] }
    const conj = found.doc.conjugations
    if (!conj || Object.keys(conj).length === 0) {
      return { content: [{ type: 'text', text: `« ${found.word} » n'est pas un verbe conjugué dans le dictionnaire.` }] }
    }
    const out: string[] = [`# Conjugaison de « ${found.word} »`]
    for (const [mode, temps] of Object.entries(conj)) {
      out.push(`\n## ${mode}`)
      for (const [tempsNom, formes] of Object.entries(temps)) {
        out.push(`**${tempsNom}** : ${Object.entries(formes).map(([sujet, forme]) => `${sujet} ${clean(forme)}`).join(' ; ')}`)
      }
    }
    return { content: [{ type: 'text', text: out.join('\n') }] }
  })

  async function main() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
    console.error(`[remede-mcp] prêt — base: ${process.env.REMEDE_DB ?? DEFAULT_DB}`)
  }
  main().catch((err) => {
    console.error('[remede-mcp] erreur fatale:', err)
    process.exit(1)
  })
