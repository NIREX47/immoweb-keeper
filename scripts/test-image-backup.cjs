const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {createImageBackup, verifyImageBackup} = require('./image-backup.cjs')

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'immoweb-image-backup-test-'))
    const images = path.join(root, 'images')
    const backups = path.join(root, 'backups')
    fs.mkdirSync(path.join(images, '900001'), {recursive: true})
    fs.mkdirSync(backups)
    const original = Buffer.from('example-pixel-data-for-testing')
    fs.writeFileSync(path.join(images, '900001', 'original.jpg'), original)
    try {
        const first = await createImageBackup({imagesPath: images, backupDir: backups, keep: 1})
        assert.equal((await verifyImageBackup(first)).type, 'immoweb-images')
        const second = await createImageBackup({imagesPath: images, backupDir: backups, keep: 1})
        assert.equal(fs.existsSync(second), true)
        assert.equal(fs.existsSync(first), false, 'Old image backups should be pruned after verification')
        const archives = fs.readdirSync(backups).filter(name => name.endsWith('.tar.gz'))
        assert.equal(archives.length, 1)
        fs.appendFileSync(second, 'CORRUPT')
        await assert.rejects(verifyImageBackup(second), /mismatch/)
        assert.equal(fs.readFileSync(path.join(images, '900001', 'original.jpg')).equals(original), true)
        console.log('PASS: image backup archive, manifest, retention, corruption detection and source safety')
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
}
main().catch(error => {console.error(error);process.exitCode = 1})
