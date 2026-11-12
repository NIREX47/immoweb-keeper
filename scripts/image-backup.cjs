#!/usr/bin/env node
'use strict'

// Production image archives are separate from MongoDB backups.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const {spawn} = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const CONFIG = path.join(ROOT, 'deploy/config.prod.env')
const DEFAULT_KEEP = 14

function readConfig(file = CONFIG) {
    const values = {}
    for(const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if(!trimmed || trimmed.startsWith('#')) continue
        const at = trimmed.indexOf('=')
        if(at < 1) continue
        let value = trimmed.slice(at + 1).trim()
        if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        values[trimmed.slice(0, at).trim()] = value
    }
    return values
}

function checkedDirectory(value, name) {
    if(!value || !path.isAbsolute(value)) throw new Error(name + ' must be an absolute directory.')
    if(!fs.statSync(value).isDirectory()) throw new Error(name + ' is not a directory.')
    const real = fs.realpathSync(value)
    fs.accessSync(real, fs.constants.R_OK)
    return real
}

function pathInside(parent, child) {
    const relative = path.relative(parent, child)
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function tar(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('tar', args, {stdio: ['ignore', 'ignore', 'pipe']})
        let errorText = ''
        child.stderr.on('data', chunk => {errorText = (errorText + chunk.toString()).slice(-1500)})
        child.once('error', reject)
        child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error('tar failed (' + (signal || code) + '): ' + errorText.trim())))
    })
}

function hashFile(file) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file)
        const hash = crypto.createHash('sha256')
        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

async function verifyImageBackup(file) {
    if(!file.endsWith('.tar.gz')) throw new Error('Expected an image archive ending in .tar.gz')
    const stat = fs.statSync(file)
    if(!stat.isFile() || stat.size === 0) throw new Error('Image archive is empty or invalid')
    const manifest = JSON.parse(fs.readFileSync(file + '.json', 'utf8'))
    if(manifest.type !== 'immoweb-images' || manifest.bytes !== stat.size) throw new Error('Image archive metadata mismatch')
    if(manifest.sha256 !== await hashFile(file)) throw new Error('Image archive checksum mismatch')
    await tar(['-tzf', file])
    return manifest
}

function pruneImageBackups(dir, keep) {
    const archives = fs.readdirSync(dir).filter(name => /^images-[0-9TZ-]+-[0-9a-f]{12}\.tar\.gz$/.test(name)).sort().reverse()
    for(const name of archives.slice(keep)) {
        const file = path.join(dir, name)
        if(!fs.existsSync(file + '.json')) continue
        fs.rmSync(file)
        fs.rmSync(file + '.json')
    }
}

async function createImageBackup({imagesPath, backupDir, keep = DEFAULT_KEEP}) {
    if(!Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw new Error('keep must be between 1 and 1000')
    const images = checkedDirectory(imagesPath, 'PROD_IMAGES_PATH')
    const backups = checkedDirectory(backupDir, 'PROD_BACKUPS_PATH')
    fs.accessSync(backups, fs.constants.W_OK)
    if(pathInside(images, backups)) throw new Error('Backup directory must not be inside the images directory')
    if(pathInside(ROOT, backups)) throw new Error('Backup directory must be outside the source repository')
    if(pathInside(backups, images)) throw new Error('Image directory must not be inside the backup directory')

    const lock = path.join(backups, '.images.backup.lock')
    let lockFd
    try {lockFd = fs.openSync(lock, 'wx', 0o600)}
    catch(error) {
        if(error.code === 'EEXIST') throw new Error('An image backup is already running or left a lock: ' + lock)
        throw error
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(backups, 'images-' + stamp + '-' + crypto.randomBytes(6).toString('hex') + '.tar.gz')
    const temp = file + '.part'
    const manifestTemp = file + '.json.part'
    try {
        // Private default permissions apply to archives made by tar as well.
        const originalUmask = process.umask(0o077)
        try { await tar(['-czf', temp, '-C', images, '.']) }
        finally {process.umask(originalUmask)}
        const bytes = fs.statSync(temp).size
        if(!bytes) throw new Error('Empty image archive')
        const sha256 = await hashFile(temp)
        fs.writeFileSync(manifestTemp, JSON.stringify({
            type: 'immoweb-images', createdAt: new Date().toISOString(), bytes, sha256
        }, null, 2) + '\n', {flag: 'wx', mode: 0o600})
        fs.renameSync(temp, file)
        fs.renameSync(manifestTemp, file + '.json')
        await verifyImageBackup(file)
        pruneImageBackups(backups, keep)
        console.log('PASS: verified image archive ' + file)
        return file
    } finally {
        fs.rmSync(temp, {force: true})
        fs.rmSync(manifestTemp, {force: true})
        fs.closeSync(lockFd)
        fs.rmSync(lock, {force: true})
    }
}

async function main(argv = process.argv.slice(2)) {
    if(argv[0] === 'verify' && argv.length === 2) {
        await verifyImageBackup(path.resolve(argv[1]))
        console.log('PASS: image archive verified')
        return
    }
    if(argv[0] !== 'backup' || argv.length > 2 || (argv.length === 2 && !/^\d+$/.test(argv[1]))) {
        throw new Error('Use: image-backup.cjs backup [keep-count] or verify /absolute/path/file.tar.gz')
    }
    const config = readConfig()
    const keep = argv[1] == null ? DEFAULT_KEEP : Number(argv[1])
    await createImageBackup({imagesPath: config.PROD_IMAGES_PATH, backupDir: config.PROD_BACKUPS_PATH, keep})
}

if(require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1})
module.exports = {createImageBackup, verifyImageBackup, pruneImageBackups, readConfig, pathInside}
