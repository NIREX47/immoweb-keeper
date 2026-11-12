const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {spawn} = require('node:child_process')

if(process.env.GITHUB_ACTIONS !== 'true') {
    console.error('Refusing to run server smoke test outside disposable GitHub Actions runner')
    process.exit(2)
}

const serverFolder = path.resolve(__dirname, '../server')
const port = '15119'
const env = {
    ...process.env,
    MONGODB_URL: 'mongodb://127.0.0.1:27017',
    MONGODB_DATABASE: 'immoweb_dev',
    JWT_SECRET: 'throwaway-smoke-test-secret',
    PORT: port,
    SHOULD_SERVE_IMAGES: 'false',
    NODE_ENV: 'test'
}
const child = spawn(process.execPath, ['src/index.js'], {cwd: serverFolder, env, stdio: ['ignore', 'pipe', 'pipe']})
let output = ''
child.stdout.on('data', chunk => {output += chunk.toString()})
child.stderr.on('data', chunk => {output += chunk.toString()})
const base = 'http://127.0.0.1:' + port

async function jsonCall(query, variables, token) {
    const response = await fetch(base + '/graphql/', {
        method: 'POST',
        headers: {'content-type': 'application/json', ...(token ? {authentication: token} : {})},
        body: JSON.stringify({query, variables}),
        signal: AbortSignal.timeout(10000)
    })
    assert.equal(response.status, 200, 'GraphQL HTTP ' + response.status + ': ' + await response.text())
    const result = await response.json()
    assert(!result.errors, JSON.stringify(result.errors))
    return result.data
}

async function main() {
    for(let attempt = 0; attempt < 100; attempt++) {
        if(child.exitCode !== null) throw new Error('Server exited before ready: ' + output)
        try {
            const result = await fetch(base + '/health', {signal: AbortSignal.timeout(1000)})
            if(result.status === 200) break
        } catch(error) {}
        if(attempt === 99) throw new Error('Server did not start: ' + output)
        await new Promise(resolve => setTimeout(resolve, 200))
    }
    const username = 'integration-test-' + process.pid
    await jsonCall('mutation($name: String!, $password: String!) { register(name: $name, password: $password) { name } }', {name: username, password: 'integration-only'})
    const login = await jsonCall('mutation($name: String!, $password: String!) { login(name: $name, password: $password) }', {name: username, password: 'integration-only'})
    assert(login.login)
    const data = await jsonCall('query { routineStatus { schedule { enabled cronExpression postalCodes propertyTypes } lastRun { status } } routineRuns(limit: 2, postalCodes: [8670], propertyType: HOUSE) { status coverage { postalCode status totalFound listingsSeen coverageComplete } } }', null, login.login)
    assert.equal(data.routineStatus.schedule.enabled, false, 'Test scheduler unexpectedly enabled')
    assert(data.routineRuns.some(item => item.coverage.some(c => c.listingsSeen === 2 && c.totalFound === 3)))
    console.log('PASS: server healthy, register/login, authenticated GraphQL and partial coverage')
}

main().catch(error => {
    console.error('SMOKE TEST FAILED:', error.stack || error)
    console.error('Server output: ' + output.slice(-6000))
    process.exitCode = 1
}).finally(() => {
    child.kill('SIGTERM')
})
