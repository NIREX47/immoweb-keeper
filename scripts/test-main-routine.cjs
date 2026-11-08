
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const source = fs.readFileSync('server/routine/src/routine.js', 'utf8')
const start = source.indexOf('async function mainRoutine()')
const end = source.indexOf('function readMaxEstatesPerSearch()', start)

assert(start >= 0 && end > start, 'mainRoutine niet gevonden')

const attempted = []
const coverage = []
const savedTotals = []
let exitCode = null

const blocked = new Error('HTTP 429')
blocked.stopScan = true

const context = {
  loadConfig: async () => {},
  loadTargets: async () => ({
    postalCodes: [8670, 8400],
    propertyTypes: ['HOUSE']
  }),
  readMaxEstatesPerSearch: () => 100,
  processQuery: async (postalCode) => {
    attempted.push(postalCode)
    throw blocked
  },
  saveCoverage: async (record) => coverage.push(record),
  saveRoutineTotals: async (totals) => savedTotals.push(totals),
  console: { error: () => {}, log: () => {} },
  process: {
    exit: (code) => {
      exitCode = code
      throw new Error('SIMULATED_EXIT')
    }
  }
}

const mainRoutine = vm.runInNewContext(
  '(' + source.slice(start, end).trim() + ')',
  context
)

;(async () => {
  await assert.rejects(
    () => mainRoutine(),
    err => err.message === 'SIMULATED_EXIT'
  )

  assert.deepEqual(attempted, [8670])
  assert.equal(coverage.length, 1)
  assert.equal(coverage[0].status, 'failed')
  assert.equal(savedTotals.length, 1)
  assert.equal(exitCode, 1)

  console.log('TEST GESLAAGD: blokkering stopt alle postcodes')
  console.log('TEST GESLAAGD: postcode geregistreerd als failed')
  console.log('TEST GESLAAGD: totalen opgeslagen')
  console.log('TEST GESLAAGD: foutcode 1')
})().catch(err => {
  console.error('TEST MISLUKT:', err)
  process.exitCode = 1
})
