import fs from 'node:fs'
import path from 'node:path'

const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')

// 1. Reset root cordis.patch.yml to []
const rootPatchPath = path.join(dshHome, 'cordis.patch.yml')
fs.writeFileSync(rootPatchPath, '[]\n', 'utf8')
console.log('Reset ' + rootPatchPath)

// 2. Clean package.json bundles in web profile
const pkgJsonPath = path.join(dshHome, 'profiles', 'web', 'package.json')
if (fs.existsSync(pkgJsonPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8').replace(/^\uFEFF/, ''))
  if (pkg.dsh?.profile?.bundles) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => !b.includes('better-deepseek'))
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('Cleaned bundles in ' + pkgJsonPath)
}

// 3. Write cordis.patch.yml in web profile
const webPatchPath = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
const patchContent = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

- insert:
    - id: better-deepseek
      name: '@deepseek-ai/dsh-better-deepseek'
      config:
        enableCors: true
`
fs.writeFileSync(webPatchPath, patchContent, 'utf8')
console.log('Configured ' + webPatchPath)
