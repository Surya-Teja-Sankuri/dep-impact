import { parseChangelog } from './parser.js'
import { fetchChangelog } from './fetcher.js'
import 'dotenv/config'

const fetched = await fetchChangelog(
  'axios',
  'https://github.com/axios/axios',
  '0.27.2',
  '1.0.0'
)

const result = await parseChangelog(
  'axios',
  '0.27.2',
  '1.0.0',
  fetched.content
)

console.log('Strategy used:', result.strategy)
console.log('Version range:', result.versionRange)
console.log('Breaking changes found:', result.breakingChanges.length)
console.log(JSON.stringify(result.breakingChanges, null, 2))