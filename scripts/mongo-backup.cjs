#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const {spawn} = require('node:child_process')
const {pipeline} = require('node:stream/promises')

const ROOT = path.resolve(__dirname, '..')
const PROD_ENV_FILE = path.join(ROOT, 'deploy/config.prod.env')
const DB_NAMES = {dev: 'immoweb_dev', prod: 'immoweb_prod'}
const DEFAULT_KEEP = 14

function optionsFrom(argv) {
    const [action, ...args] = argv
    if(!['backup', 'verify', 'restore'].includes(action)) throw new Error('Choose backup, verify or restore. See README for usage.')
    const options = {}
    for(let index = 0; index < args.length; ++index) {
        const flag = args[index]
        if(!['--env', '--dir', '--file', '--keep', '--confirm'].includes(flag) || index + 1 >= args.length) {
            throw new Error('Unknown or incomplete argument: ' + flag)
        }
        if(options[flag] !== undefined) throw new Error('Repeated argument: ' + flag)
        options[flag] = args[++index]
    }
    if(!DB_NAMES[options['--env']]) throw new Error('Specify --env dev or --env prod.')
    if(action === 'backup' && (options['--file'] || options['--confirm'])) throw new Error('Invalid backup argument.')
    if(action !== 'backup' && (options['--dir'] || options['--keep'])) throw new Error('Invalid argument for ' + action)
    if(action !== 'backup' && !options['--file']) throw new Error('--file is required for ' + action)
    if(action === 'verify' && options['--confirm']) throw new Error('--confirm is only valid for restore.')
    const keep = options['--keep'] == null ? DEFAULT_KEEP : Number(options['--keep'])
    if(!Number.isSafeInteger(keep) || keep < 1 || keep > 1000) throw new Error('--keep must be between 1 and 1000.')
    return {action, environment: options['--env'], directory: options['--dir'], file: options['--file'], keep, confirm: options['--confirm']}
}

function readProdConfig() {
    if(!fs.existsSync(PROD_ENV_FILE)) throw new Error('Missing deploy/config.prod.env.')
    const values = {}
    for(const line of fs.readFileSync(PROD_ENV_FILE, 'utf8').split(/\r?\n/)) {
        const text = line.trim()
        if(!text || text.startsWith('#')) continue
        const at = text.indexOf('=')
        if(at < 0) continue
        const key = text.slice(0, at).trim()
        let value = text.slice(at + 1).trim()
        if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
        values[key] = value
    }
    return values
}

function resolveDirectory(opts) {
    if(opts.environment === 'prod') {
        if(opts.directory) throw new Error('Production directory must be set using PROD_BACKUPS_PATH, not --dir.')
        const value = readProdConfig().PROD_BACKUPS_PATH
        if(!value || !path.isAbsolute(value)) throw new Error('Set PROD_BACKUPS_PATH to an existing absolute host directory.')
        if(!fs.existsSync(value) || !fs.statSync(value).isDirectory()) throw new Error('Production backup directory does not exist: ' + value)
        const real = fs.realpathSync(value)
        if(real === ROOT || real.startsWith(ROOT + path.sep)) throw new Error('Production backups must be outside the repository.')
        fs.accessSync(real, fs.constants.R_OK | fs.constants.W_OK)
        return real
    }
    const directory = path.resolve(opts.directory || path.join(ROOT, 'backups/dev'))
    fs.mkdirSync(directory, {recursive: true, mode: 0o700})
    if(!fs.statSync(directory).isDirectory()) throw new Error('Backup path is not a directory.')
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK)
    return directory
}

function dockerArguments(environment, command) {
    const args = ['compose']
    if(environment === 'prod') args.push('--env-file', PROD_ENV_FILE)
    args.push('-f', path.join(ROOT, environment === 'prod' ? 'compose.prod.yaml' : 'compose.dev.yaml'))
    args.push('exec', '-T', 'mongodb', ...command)
    return args
}

function runDocker(environment, command, input, output) {
    return new Promise(async (resolve, reject) => {
        const child = spawn('docker', dockerArguments(environment, command), {cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe']})
        let stderr = ''
        child.stderr.on('data', chunk => {stderr = (stderr + chunk.toString()).slice(-2000)})
        const result = new Promise((done, fail) => {
            child.once('error', fail)
            child.once('close', (code, signal) => code === 0 ? done() : fail(new Error('MongoDB command failed (' + (signal || code) + '): ' + stderr.trim())))
        })
        try {
            const copy = input ? pipeline(input, child.stdin) : output ? pipeline(child.stdout, output) : Promise.resolve()
            if(!input) child.stdin.end()
            if(input) child.stdout.resume()
            await Promise.all([result, copy])
            resolve()
        } catch(error) {
            child.kill()
            reject(error)
        }
    })
}

function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const stream = fs.createReadStream(file)
        stream.on('error', reject)
        stream.on('data', chunk => hash.update(chunk))
        stream.on('end', () => resolve(hash.digest('hex')))
    })
}

async function verifyFile(file, dbName) {
    if(!file.endsWith('.archive.gz') || !fs.statSync(file).isFile()) throw new Error('Expected an existing .archive.gz file.')
    const metadata = JSON.parse(fs.readFileSync(file + '.json', 'utf8'))
    if(metadata.database !== dbName) throw new Error('Backup database does not match target ' + dbName)
    const bytes = fs.statSync(file).size
    if(bytes <= 0 || bytes !== metadata.bytes) throw new Error('Backup size mismatch.')
    const digest = await hashFile(file)
    if(digest !== metadata.sha256) throw new Error('Backup checksum mismatch.')
    return {metadata, bytes}
}

function pruneBackups(directory, dbName, keep) {
    const prefix = dbName + '-'
    const backups = fs.readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isFile() && entry.name.startsWith(prefix) && /^immoweb_(?:dev|prod)-[0-9TZ-]+-[0-9a-f]{12}\.archive\.gz$/.test(entry.name))
        .map(entry => entry.name)
        .sort().reverse()
    for(const name of backups.slice(keep)) {
        const file = path.join(directory, name)
        // Only prune completed archives that have their matching manifest.
        if(!fs.existsSync(file + '.json')) continue
        fs.unlinkSync(file)
        fs.unlinkSync(file + '.json')
    }
}

async function backup(opts) {
    const dbName = DB_NAMES[opts.environment]
    const dir = resolveDirectory(opts)
    const lock = path.join(dir, '.' + dbName + '.backup.lock')
    let lockFd
    try {
        lockFd = fs.openSync(lock, 'wx', 0o600)
    } catch(error) {
        if(error.code === 'EEXIST') throw new Error('A backup lock already exists: ' + lock + '. Check for an active backup before removing it.')
        throw error
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, dbName + '-' + stamp + '-' + crypto.randomBytes(6).toString('hex') + '.archive.gz')
    const temp = file + '.part'
    const manifestTemp = file + '.json.part'
    try {
        const out = fs.createWriteStream(temp, {flags: 'wx', mode: 0o600})
        await runDocker(opts.environment, ['mongodump', '--db', dbName, '--archive', '--gzip'], null, out)
        const bytes = fs.statSync(temp).size
        if(bytes <= 0) throw new Error('Database dump is empty.')
        const sha256 = await hashFile(temp)
        fs.writeFileSync(manifestTemp, JSON.stringify({
            database: dbName, createdAt: new Date().toISOString(), bytes, sha256,
            format: 'mongodump --archive --gzip'
        }, null, 2) + '\n', {flag: 'wx', mode: 0o600})
        fs.renameSync(temp, file)
        fs.renameSync(manifestTemp, file + '.json')
        await verifyFile(file, dbName)
        pruneBackups(dir, dbName, opts.keep)
        console.log('Backup created and verified: ' + file)
        console.log('Size: ' + bytes + ' bytes; SHA-256: ' + sha256)
    } finally {
        for(const candidate of [temp, manifestTemp]) {
            try {fs.rmSync(candidate, {force: true})} catch(error) {console.error('Failed to remove temporary file:', candidate, error.message)}
        }
        fs.closeSync(lockFd)
        fs.rmSync(lock, {force: true})
    }
}

async function main() {
    const opts = optionsFrom(process.argv.slice(2))
    const dbName = DB_NAMES[opts.environment]
    if(opts.action === 'backup') return backup(opts)
    const file = path.resolve(opts.file)
    const result = await verifyFile(file, dbName)
    console.log('Verified backup for ' + dbName + ': ' + file + ' (' + result.bytes + ' bytes)')
    if(opts.action === 'verify') return
    if(opts.confirm !== 'RESTORE_' + dbName) throw new Error('Restore refused. Supply --confirm RESTORE_' + dbName + ' to authorize overwriting existing database documents.')
    console.log('Restoring ' + dbName + '. Existing matching collections will be overwritten.')
    await runDocker(opts.environment, ['mongorestore', '--archive', '--gzip', '--drop', '--nsInclude=' + dbName + '.*'], fs.createReadStream(file), null)
    console.log('Restore completed: ' + dbName)
}

if(require.main === module) {
    main().catch(error => {
        console.error('Backup operation failed:', error.message)
        process.exitCode = 1
    })
}

module.exports = {optionsFrom, dockerArguments, pruneBackups, verifyFile}
