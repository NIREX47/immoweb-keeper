
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const source = fs.readFileSync(
  'server/routine/src/routine.js', 'utf8'
)

const start = source.indexOf('async function parseEstatePage(')
const end = source.indexOf(
  '\n// async function parseEstatePage(', start
)

assert(start >= 0 && end > start, 'Functie niet gevonden')

async function testStatus(status) {
  let requests = 0

  const parseEstatePage = vm.runInNewContext(
    '(' + source.slice(start, end).trim() + ')',
    {
      needle: async () => {
        requests++
        return { statusCode: status, body: '' }
      }
    }
  )

  await assert.rejects(
    () => parseEstatePage('TEST123'),
    err => status === 500
      ? err.message.includes('HTTP 500')
      : err.stopScan === true &&
        err.message.includes(`HTTP ${status}`)
  )

  assert.equal(requests, 1)

  console.log(`TEST GESLAAGD: HTTP ${status}`)
}

;(async () => {
  await testStatus(403)
  await testStatus(429)
  await testStatus(500)
  console.log('ALLE TESTS GESLAAGD')
})().catch(err => {
  console.error('TEST MISLUKT:', err)
  process.exitCode = 1
})
