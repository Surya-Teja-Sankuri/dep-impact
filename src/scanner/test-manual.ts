import { scanProject } from './index.js'
import path from 'path'

const result = await scanProject(
  'axios',
  'D:/personal/projects/testing-folder'  // your test project path
)

console.log(JSON.stringify(result, null, 2))