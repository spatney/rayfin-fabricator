// A stand-in for rayfin-local that speaks host contract 1, for Fabricator's
// supervisor tests (services/local_backend/tests.rs). What `serve` does comes
// from `<project>/fake-mode`: ok, fatal, already-serving, crash, crash-once,
// config-restart, ignore-stdin or analysis-fails-once (its first run then reports
// a data model change it couldn't analyze, as live reload does, and keeps
// running). Each start is counted in `<project>/starts` and its arguments saved
// in `<project>/args-<start>.json`.
'use strict'
const fs = require('fs')
const http = require('http')
const path = require('path')

const args = process.argv.slice(2)
const words = []
let project = '.'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-C') project = args[++i]
  else if (args[i] === '--sign-in-as') i++
  else if (!args[i].startsWith('-')) words.push(args[i])
}
project = path.resolve(project)
const [command, sub, name] = words

if (args.includes('--version')) {
  console.log('rayfin-local 9.9.9-fake')
} else if (command === 'version') {
  const sdk = { supported: '>=1.36.0 <1.37.0', tested: '1.36.2' }
  console.log(JSON.stringify({ version: '9.9.9-fake', contract: 1, sdk }))
} else if (command === 'secret') {
  secret()
} else if (command === 'serve') {
  serve()
} else {
  console.error(`error: unrecognized subcommand '${command}'`)
  process.exitCode = 2
}

function secret() {
  const file = path.join(project, 'secrets.json')
  const secrets = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (sub === 'list') {
    const source = secrets.API_KEY ? 'local' : 'none'
    console.log(JSON.stringify({ secrets: [{ name: 'API_KEY', declared: true, description: null, source }] }))
  } else if (sub === 'set') {
    fs.writeFileSync(path.join(project, 'secret-args.json'), JSON.stringify(args))
    let value = ''
    process.stdin.on('data', (chunk) => (value += chunk))
    process.stdin.on('end', () => {
      if (!value) {
        console.error(`error: The value of ${name} is empty; nothing was saved.`)
        process.exitCode = 1
        return
      }
      secrets[name] = value
      fs.writeFileSync(file, JSON.stringify(secrets))
    })
  } else if (sub === 'delete') {
    delete secrets[name]
    fs.writeFileSync(file, JSON.stringify(secrets))
  }
}

function serve() {
  const modeFile = path.join(project, 'fake-mode')
  const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok'
  const startsFile = path.join(project, 'starts')
  const starts = (fs.existsSync(startsFile) ? Number(fs.readFileSync(startsFile, 'utf8')) : 0) + 1
  fs.writeFileSync(startsFile, String(starts))
  fs.writeFileSync(path.join(project, `args-${starts}.json`), JSON.stringify(args))
  const token = process.env.RAYFIN_LOCAL_CONTROL_TOKEN || ''
  const line = (type, fields) => JSON.stringify({ v: 1, type, time: new Date().toISOString(), ...fields }) + '\n'
  const emit = (type, fields) => process.stdout.write(line(type, fields))
  // Exit only once stdout has taken the last event: pipes are asynchronous on POSIX.
  const stop = (reason, code) => process.stdout.write(line('stopped', { reason, exitCode: code }), () => process.exit(code))
  const fatal = (code, message, details) => {
    emit('error', { code, message, hint: null, fatal: true, details })
    stop('error', 1)
  }

  emit('starting', { pid: process.pid, version: '9.9.9-fake', project: { root: project, name: path.basename(project) } })
  if (token.length < 32) return fatal('config-invalid', 'The control token is too short.', null)
  if (mode === 'fatal') {
    const losses = ['Note.title (3 values)']
    emit('schema', { result: 'refused', changes: ['changed Note'], losses, message: null, live: false })
    return fatal('schema-refused', 'The change would delete data: Note.title (3 values).', { losses })
  }
  if (mode === 'already-serving') {
    const details = { pid: 999999, appUrl: 'http://localhost:5173/', apiUrl: 'http://localhost:7171' }
    return fatal('already-serving', 'rayfin-local serve is already running this project.', details)
  }
  if (mode !== 'ignore-stdin') {
    process.stdin.on('end', () => stop('stdin-closed', 0))
    process.stdin.resume()
  } else {
    setInterval(() => {}, 1000)
  }
  process.stderr.write(`fake stderr with ${token}\n`)

  let apiUrl = ''
  let identity = { kind: 'developer', user: null }
  const users = []
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake')
      if (url.pathname === '/rayfin.config.json') return send(res, 200, { apiUrl, publishableKey: 'pk_fake' })
      if (url.pathname === '/graphql') {
        const auth = req.headers.authorization || null
        return send(res, 200, { auth, key: req.headers['x-publishable-key'] || null })
      }
      const prefix = '/.rayfin-local/control'
      if (!url.pathname.startsWith(prefix + '/')) return send(res, 404, { error: { code: 'not-found', message: 'No such route.' } })
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(res, 401, { error: { code: 'unauthorized', message: 'Bad control token.' } })
      }
      const body = raw ? JSON.parse(raw) : {}
      const route = `${req.method} ${decodeURIComponent(url.pathname.slice(prefix.length))}`
      if (route === 'GET /users') return send(res, 200, { users })
      if (route === 'POST /users') {
        if (users.some((u) => u.username === body.username)) {
          return send(res, 409, { error: { code: 'user-exists', message: `${body.username} exists.`, hint: 'Pick another username.' } })
        }
        const email = body.username.includes('@') ? body.username : null
        const signIn = body.password ? ['password'] : []
        const user = { id: users.length + 1, username: body.username, email, createdAt: '2026-10-30T00:00:00Z', signIn, developer: false }
        users.push(user)
        return send(res, 201, user)
      }
      if (route.startsWith('DELETE /users/')) {
        const index = users.findIndex((u) => u.username === route.slice('DELETE /users/'.length))
        if (index < 0) return send(res, 404, { error: { code: 'user-not-found', message: 'No such user.' } })
        users.splice(index, 1)
        res.writeHead(204)
        return res.end()
      }
      if (route === 'GET /identity') return send(res, 200, identity)
      if (route === 'PUT /identity') {
        identity = { kind: body.kind, user: body.kind === 'user' ? users.find((u) => u.username === body.user) || null : null }
        return send(res, 200, identity)
      }
      if (route === 'POST /token') {
        return send(res, 200, { accessToken: `access-${body.user || 'developer'}`, tokenType: 'Bearer', expiresIn: 3600, user: null })
      }
      if (route === 'GET /entities') return send(res, 200, { entities: [{ name: 'Note', rows: 2 }] })
      if (route === 'GET /entities/Note/rows') {
        const columns = [{ name: 'id', type: 'int', key: true }, { name: 'title', type: 'string', key: false }]
        return send(res, 200, { columns, rows: [{ id: 1, title: 'a', query: url.search }], total: 2 })
      }
      if (route === 'DELETE /entities/Note/rows') return send(res, 200, { deleted: 2 })
      if (route === 'POST /data/reset') return send(res, 200, { ok: true })
      if (route === 'POST /reload') {
        const schema = { v: 1, type: 'schema', result: body.forceSchema ? 'applied' : 'unchanged', changes: [], losses: [], message: null, live: true }
        return send(res, 200, { schema, config: null })
      }
      return send(res, 404, { error: { code: 'not-found', message: `No ${route}.` } })
    })
  })
  server.listen(0, '127.0.0.1', () => {
    apiUrl = `http://127.0.0.1:${server.address().port}`
    emit('analysis', { ok: true, sdk: { version: '1.36.2', supported: true }, entities: ['Note'], storageFolders: [], message: null })
    emit('schema', { result: 'applied', changes: ['added Note'], losses: [], message: null, live: false })
    emit('log', { source: 'vite', level: 'info', line: `token check ${token}` })
    emit('ready', {
      appUrl: null,
      apiUrl,
      embedUrl: null,
      portalUrl: `${apiUrl}/.rayfin-local/portal`,
      dataDir: path.join(project, '.rayfin-local'),
      signInAs: { kind: 'developer' },
      sdk: { version: '1.36.2', supported: true },
      features: { data: { enabled: true, entities: ['Note'] } }
    })
    if (mode === 'crash' || (mode === 'crash-once' && starts === 1)) setTimeout(() => process.exit(3), 100)
    if (mode === 'analysis-fails-once' && starts === 1) {
      const message = 'The data package packages/data has not been built.'
      emit('analysis', { ok: false, sdk: { version: '1.36.2', supported: true }, entities: [], storageFolders: [], message })
    }
    if (mode === 'config-restart' && starts === 1) {
      setTimeout(() => emit('config-changed', { applied: false, restartRequired: true, what: ['frontend'], message: 'The frontend moved.' }), 100)
    }
  })
}
