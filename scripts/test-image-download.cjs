
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const os = require('node:os')
const http = require('node:http')
const https = require('node:https')
const assert = require('node:assert/strict')

const source = fs.readFileSync(
    'server/routine/src/routine.js', 'utf8'
)

const start = source.indexOf('async function downloadFile(')
const end = source.indexOf('\n/**', start)

assert(start >= 0 && end > start, 'Downloadfunctie niet gevonden')

const fakeHttps = {
    get: (url, options, callback) => {
        return http.get(url.replace('https:', 'http:'), options, callback)
    }
}

const downloadFile = vm.runInNewContext(
    '(' + source.slice(start, end).trim() + ')',
    {
        require: (name) => {
            if (name === 'node:stream/promises')
                return require(name)
            if (name === 'node:crypto')
                return require(name)
            throw Error('Unexpected dependency: ' + name)
        },
        https: fakeHttps,
        fs,
        Path: path,
        AbortController,
        setTimeout: (fn, ms) => setTimeout(fn, ms === 60000 ? 200 : ms),
        clearTimeout
    }
)

;(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-test-'))

    const server = http.createServer((req, res) => {
        if (req.url === '/hang') return
        if (req.url === '/ok') {
            res.writeHead(200)
            res.end('fictieve afbeelding')
        } else if (req.url === '/blocked') {
            res.writeHead(429)
            res.end('Geblokkeerd')
        } else {
            res.writeHead(500)
            res.end('Serverfout')
        }
    })

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

    const base = `https://127.0.0.1:${server.address().port}`

    try {
        const stalled = path.join(dir, 'timeout.jpg')

await assert.rejects(
    () => downloadFile(base + '/hang', stalled),
    err => err.name === 'AbortError' || /abort/i.test(err.message)
)

assert.equal(fs.existsSync(stalled), false)
console.log('TEST GESLAAGD: vastgelopen download afgebroken')
        const output = path.join(dir, 'foto.jpg')

        await downloadFile(base + '/ok', output)
        assert.equal(fs.readFileSync(output, 'utf8'), 'fictieve afbeelding')
        console.log('TEST GESLAAGD: afbeelding opgeslagen')

        const blocked = path.join(dir, 'blocked.jpg')
        await assert.rejects(
            () => downloadFile(base + '/blocked', blocked),
            err => err.stopScan === true
        )
        assert.equal(fs.existsSync(blocked), false)
        console.log('TEST GESLAAGD: HTTP 429 herkend')

        const failed = path.join(dir, 'failed.jpg')
        await assert.rejects(() => downloadFile(base + '/error', failed))
        assert.equal(fs.existsSync(failed), false)
        console.log('TEST GESLAAGD: mislukte download opgeruimd')

        assert.equal(
            fs.readdirSync(dir).some(name => name.endsWith('.part')),
            false
        )
        console.log('TEST GESLAAGD: geen tijdelijke bestanden')

    } finally {
        await new Promise(resolve => server.close(resolve))
        fs.rmSync(dir, { recursive: true, force: true })
    }
})().catch(err => {
    console.error('TEST MISLUKT:', err)
    process.exitCode = 1
})
