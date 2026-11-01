// Test du serveur MCP remede : poignée de main + appels d'outils via JSON-RPC sur stdio.
import { spawn } from 'node:child_process'

const proc = spawn('node', ['index.ts'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  stdio: ['pipe', 'pipe', 'pipe'],
})
proc.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`))

let buffer = ''
const pending = new Map()
let nextId = 1
proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line === '') continue
    const msg = JSON.parse(line)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
})

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, (msg) => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result))
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => reject(new Error(`timeout ${method}`)), 15000)
  })
}

function notification(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

const toolsToTest = [
  { name: 'mot', arguments: { mot: 'sérénité' } },
  { name: 'mot', arguments: { mot: '-abilité' } },
  { name: 'rimes', arguments: { mot: 'amour', qualite: 2, limite: 8 } },
  { name: 'synonymes', arguments: { mot: 'maison' } },
  { name: 'antonymes', arguments: { mot: 'rapide' } },
  { name: 'definir', arguments: { mot: 'château' } },
  { name: 'conjuguer', arguments: { verbe: 'chanter' } },
  { name: 'homophones', arguments: { mot: 'vers' } },       // liste réelle sur base enrichie, « Aucun… » sur base officielle
  { name: 'famille', arguments: { mot: 'roue' } },          // idem : dégradation propre attendue dans les deux cas
  { name: 'rechercher', arguments: { requete: 'phenom', limite: 6 } },
  { name: 'aleatoire', arguments: {} },
  { name: 'mot', arguments: { mot: '-onyme' } },
  { name: 'mot', arguments: { mot: 'zzzqxy' } },
]

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  })
  console.log('✓ initialize — serveur:', init.serverInfo.name, init.serverInfo.version)
  notification('notifications/initialized', {})

  const listed = await request('tools/list', {})
  console.log('✓ tools/list —', listed.tools.map((t) => t.name).join(', '))

  const allTexts = []
  for (const call of toolsToTest) {
    const t0 = Date.now()
    const res = await request('tools/call', call)
    const text = res.content?.[0]?.text ?? '(vide)'
    allTexts.push(text)
    const preview = text.split('\n').slice(0, 5).join(' | ').slice(0, 220)
    console.log(`\n✓ ${call.name}(${JSON.stringify(call.arguments)}) en ${Date.now() - t0}ms`)
    console.log(`  ${preview}${text.includes('introuvable') ? ' [attendu: non trouvé]' : ''}`)
  }
  const dirty = allTexts.filter((t) => /<reference|<\/?[ib]>|&#\d+;|&#x[0-9a-f]+;/i.test(t))
  if (dirty.length > 0) {
    console.error(`\n✗ ${dirty.length} réponse(s) avec résidu HTML : ${dirty[0].slice(0, 150)}`)
    process.exitCode = 1
  } else {
    console.log('\n✓ aucun résidu HTML dans les réponses')
  }
  console.log('\n=== TOUS LES TESTS PASSENT ===')
} catch (err) {
  console.error('ÉCHEC:', err.message)
  process.exitCode = 1
} finally {
  proc.kill()
}
