import { scanProject } from '../scanner/index.js'
import { fetchChangelog } from '../changelog/fetcher.js'
import { parseChangelog } from '../changelog/parser.js'
import { scoreRisk } from './index.js'
import 'dotenv/config'

// step 1 — scan
const usageMap = await scanProject(
  'axios',
  'D:/personal/projects/testing-folder'
)

// step 2 — fetch changelog
const fetched = await fetchChangelog(
  'axios',
  'https://github.com/axios/axios',
  '0.27.2',
  '1.0.0'
)

// step 3 — parse
const parsed = await parseChangelog(
  'axios',
  '0.27.2',
  '1.0.0',
  fetched.content
)

// step 4 — score
const result = scoreRisk(
  usageMap,
  parsed,
  '0.27.2',
  '1.0.0'
)

console.log('Overall risk:', result.overall)
console.log('Files affected:', result.totalFilesAffected)
console.log('Files scanned:', result.totalFilesScanned)
console.log('Strategy:', result.strategy)
console.log(JSON.stringify(result.files, null, 2))