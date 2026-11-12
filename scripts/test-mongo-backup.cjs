const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const {optionsFrom, dockerArguments, pruneBackups, verifyFile} = require('./mongo-backup.cjs')

async function main() {
    const dev = optionsFrom(['backup', '--env', 'dev', '--keep', '3'])
    assert.equal(dev.keep, 3)
    assert.equal(dev.environment, 'dev')
    assert.throws(() => optionsFrom(['backup', '--env', 'prod', '--keep', '0']))
    assert.throws(() => optionsFrom(['restore', '--env', 'prod']))
    assert.throws(() => optionsFrom(['backup', '--env', 'production']))
    const docker = dockerArguments('dev', ['mongodump', '--db', 'immoweb_dev', '--archive', '--gzip'])
    assert(docker.includes('compose.dev.yaml') || docker.some(arg => arg.endsWith('compose.dev.yaml')))
    assert(docker.includes('immoweb_dev'))

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-backup-test-'))
    try {
        for(let i = 0; i < 3; ++i) {
            const name = 'immoweb_dev-2026-11-0' + (i + 1) + 'T00-00-00-000Z-aaaaaaaaaaaa.archive.gz'
            const archive = path.join(dir, name)
            const data = Buffer.from('test archive ' + i)
            fs.writeFileSync(archive, data)
            fs.writeFileSync(archive + '.json', JSON.stringify({
                database: 'immoweb_dev',
                sha256: crypto.createHash('sha256').update(data).digest('hex'),
                bytes: data.length
            }))
        }
        pruneBackups(dir, 'immoweb_dev', 2)
        const archiveNames = fs.readdirSync(dir).filter(name => name.endsWith('.archive.gz'))
        assert.equal(archiveNames.length, 2)
        const archive = path.join(dir, archiveNames[0])
        await verifyFile(archive, 'immoweb_dev')
        await assert.rejects(verifyFile(archive, 'immoweb_prod'), /database does not match/)
        fs.appendFileSync(archive, 'tamper')
        await assert.rejects(verifyFile(archive, 'immoweb_dev'), /size mismatch/)
        console.log('PASS: validated arguments, environment isolation, rotation, integrity and tampering')
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
