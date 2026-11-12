const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const source = fs.readFileSync('server/src/services/routineScheduler.js', 'utf8')
const start = source.indexOf('async function startRoutine(trigger) {')
const end = source.indexOf('function getActiveRun()', start)
assert(start >= 0 && end > start, 'Missing startRoutine implementation')
const startRoutine = vm.runInNewContext('(' + source.slice(start, end).trim() + '\n)', {
    process: {env: {NODE_ENV: 'production', ROUTINE_EXECUTION_ENABLED: 'false'}},
    activeRun: null
})

const scheduleStart = source.indexOf('function configureScheduledTask(schedule) {')
const scheduleEnd = source.indexOf('async function getOrCreateSchedule()', scheduleStart)
assert(scheduleStart >= 0 && scheduleEnd > scheduleStart)
let scheduledCount = 0
const configureScheduledTask = vm.runInNewContext('(' + source.slice(scheduleStart, scheduleEnd).trim() + '\n)', {
    stopScheduledTask: () => {},
    process: {env: {NODE_ENV: 'production', ROUTINE_EXECUTION_ENABLED: 'false'}},
    console: {info: () => {}},
    cron: {schedule: () => {scheduledCount++}},
    TIMEZONE: 'Europe/Brussels'
})
configureScheduledTask({enabled: true, cronExpression: '0 4 * * 1'})
assert.equal(scheduledCount, 0, 'Production schedule should remain disabled')
assert.rejects(() => startRoutine('manual'), /Production scan execution disabled/)
    .then(() => console.log('PASS: production manual/scheduled scanner execution requires explicit opt-in'))
    .catch(error => {console.error(error); process.exitCode = 1})
