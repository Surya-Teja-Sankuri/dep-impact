import { fetchChangelog } from './fetcher.js'
import 'dotenv/config'

const result = await fetchChangelog(
  'axios',
  'https://github.com/axios/axios',
  '0.27.2',
  '1.0.0'
)

console.log('Source:', result.source)
console.log('Content length:', result.content.length)
console.log('First 500 chars:\n', result.content.slice(0, 500))