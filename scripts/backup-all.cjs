#!/usr/bin/env node
'use strict'

// Run both backup jobs in sequence. Requires an already-running production DB
// and a persistent backup directory configured in deploy/config.prod.env.
const path = require('node:path')
const {spawnSync} = require('node:child_process')

if(process.argv.length !== 2) {
    console.error('Usage: node scripts/backup-all.cjs')
    process.exit(2)
}
const root = path.resolve(__dirname, '..')
const scripts = [
    ['MongoDB', 'mongo-backup.cjs', 'backup', '--env', 'prod'],
    ['images', 'image-backup.cjs', 'backup']
]
for(const [label, script, ...args] of scripts) {
    console.log('Backing up ' + label + '...')
    const result = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
        cwd: root, stdio: 'inherit'
    })
    if(result.error || result.status !== 0) {
        console.error('Backup run FAILED at ' + label + ': ' + (result.error?.message || 'exit ' + (result.signal || result.status)))
        process.exit(1)
    }
}
console.log('PASS: both database and image backups completed and verified.')
