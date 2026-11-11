const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const source = fs.readFileSync('server/routine/src/routine.js', 'utf8')
const start = source.indexOf('async function processQuery(')
const end = source.indexOf('async function processPage(', start)
assert(start >= 0 && end > start, 'processQuery function not found')

async function runScenario({total, limit, pages, expectedComplete}) {
    const saved = []
    const db = {
        collection: () => ({
            findOne: async () => null,
            find: () => ({toArray: async () => []}),
            updateMany: async () => ({})
        })
    }
    const context = {
        db,
        todayAsDate: new Date('2026-11-11T12:00:00Z'),
        RESULTS_PER_PAGE: 30,
        _: {
            range: (a, b) => Array.from({length: b - a}, (_, i) => a + i),
            uniq: values => [...new Set(values)],
            difference: (a, b) => a.filter(value => !b.includes(value))
        },
        buildURLFromQuery: () => 'https://example.test/results',
        parseResultsPage: async () => ({normalizedQueryURL: 'https://example.test/results', totalResultCount: total}),
        processPage: async (url, page, collectOnly, lastRunDate, estateLimit) => {
            const codes = pages[page - 1].slice(0, estateLimit)
            saved.push(...codes)
            return {immowebCodes: codes, newEstateCount: 0, updatedEstateCount: 0, shouldContinue: true}
        },
        console: {info: () => {}}
    }
    const processQuery = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', context)
    const result = await processQuery(8670, 'HOUSE', limit)
    assert.equal(result.coverageComplete, expectedComplete)
    assert.equal(result.listingsSeen, new Set(saved.map(String)).size)
    assert.equal(result.totalFound, total)
}

;(async () => {
    await runScenario({total: 3, limit: 2, pages: [[1, 2]], expectedComplete: false})
    await runScenario({total: 3, limit: null, pages: [[1, 2, 3]], expectedComplete: true})
    await runScenario({total: 3, limit: null, pages: [[1, 1, 2]], expectedComplete: false})
    console.log('PASS: limited, complete and duplicate listing coverage')
})().catch(error => {
    console.error(error)
    process.exitCode = 1
})
