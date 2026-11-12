const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {buildSchema, parse, validate} = require('../server/node_modules/graphql')

const schemaText = fs.readFileSync(path.join(__dirname, '../server/src/graphql/schema.graphql'), 'utf8')
const schema = buildSchema(schemaText)
const routineAdmin = fs.readFileSync(path.join(__dirname, '../client/src/components/RoutineAdmin.jsx'), 'utf8')

const gqlBlocks = [...routineAdmin.matchAll(/gql\`([\s\S]*?)\`/g)].map(match => match[1])
assert(gqlBlocks.length >= 3, 'Routine administration GraphQL queries not found')

for(const query of gqlBlocks) {
    const errors = validate(schema, parse(query))
    assert.equal(errors.length, 0, errors.map(err => err.message).join('\n'))
}
for(const field of ['status', 'totalFound', 'listingsSeen', 'coverageComplete']) {
    assert(schema.getType('RoutineCoverage').getFields()[field], 'Missing schema field: ' + field)
}
console.log('PASS: RoutineAdmin GraphQL queries match backend schema')
