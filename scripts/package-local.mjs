import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const root = process.cwd()
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const packagePath = path.join(root, 'package.json')
const packageSource = await readFile(packagePath, 'utf8')
const builderVersion = /^\d+\.\d+$/.test(version) ? `${version}.0` : version
const outputRoot = path.join(root, 'release', version)
const platforms = [
  {
    name: 'mac-arm64',
    browser: 'mac-arm64',
    args: ['--mac', 'dmg', 'zip', '--arm64'],
    files: [`kaida-auto-quiz-${version}-macOS.dmg`, `kaida-auto-quiz-${version}-macOS.dmg.blockmap`, `kaida-auto-quiz-${version}-macOS.zip`, `kaida-auto-quiz-${version}-macOS.zip.blockmap`, 'latest-mac.yml'],
  },
  {
    name: 'win-x64',
    browser: 'win-x64',
    args: ['--win', 'nsis', '--x64'],
    files: [`kaida-auto-quiz-${version}-Windows.exe`, `kaida-auto-quiz-${version}-Windows.exe.blockmap`, 'latest.yml'],
  },
]

function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) throw new Error(`${command} 执行失败：${result.status ?? 'signal'}`)
}

async function normalizeArtifacts(outputDir, files) {
  if (builderVersion === version) return
  for (const file of files) {
    if (file === 'latest-mac.yml' || file === 'latest.yml') continue
    const internal = file.replace(version, builderVersion)
    await rename(path.join(outputDir, internal), path.join(outputDir, file))
  }
  for (const manifest of ['latest-mac.yml', 'latest.yml']) {
    const manifestPath = path.join(outputDir, manifest)
    try {
      const source = await readFile(manifestPath, 'utf8')
      await writeFile(manifestPath, source.replaceAll(builderVersion, version), 'utf8')
    } catch {
      // The platform builder may omit a manifest when publishing is disabled.
    }
  }
}

const main = async () => {
  await mkdir(outputRoot, { recursive: true })
  run('npm', ['run', 'build'])
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `kaida-package-${version}-`))
  try {
    if (builderVersion !== version) {
      const packageJson = JSON.parse(packageSource)
      packageJson.version = builderVersion
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')
    }
    for (const platform of platforms) {
      const browserDir = path.join(tempRoot, `browser-${platform.name}`)
      const outputDir = path.join(outputRoot, platform.name)
      await mkdir(outputDir, { recursive: true })
      run(process.execPath, ['scripts/prepare-browsers.mjs', platform.browser, browserDir])
      run('npm', [
        'exec', '--', 'electron-builder', ...platform.args,
        `-c.directories.output=${outputDir}`, '--publish', 'never',
      ], {
        KAIDA_BROWSER_DIR: path.relative(root, browserDir),
        CSC_IDENTITY_AUTO_DISCOVERY: 'true',
      })
      await normalizeArtifacts(outputDir, platform.files)
      for (const file of platform.files) await access(path.join(outputDir, file), constants.R_OK)
      console.log(`已生成 ${platform.name}：${outputDir}`)
    }
  } finally {
    if (builderVersion !== version) await writeFile(packagePath, packageSource, 'utf8')
    await rm(tempRoot, { recursive: true, force: true })
  }
  console.log(`本地分发包已生成：${outputRoot}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
