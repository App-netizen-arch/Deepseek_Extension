import fs from 'node:fs'
import path from 'node:path'

const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const pkgJsonPath = path.join(dshHome, 'profiles', 'web', 'package.json')

if (fs.existsSync(pkgJsonPath)) {
  const content = fs.readFileSync(pkgJsonPath, 'utf8').replace(/^\uFEFF/, '')
  const parsed = JSON.parse(content)
  fs.writeFileSync(pkgJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
  console.log('Successfully sanitized and formatted ' + pkgJsonPath)
} else {
  console.log('File does not exist: ' + pkgJsonPath)
}
