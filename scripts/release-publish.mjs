import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

throw new Error('当前项目已禁用 GitHub Release/Tag/OTA/安装包上传；请使用 npm run package 生成本地构建')

const repo = 'zmjza/SmartAnswerPod'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const config = await readFile(path.join(root, 'electron-builder.yml'), 'utf8')
const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
const version = pkg.version
const target = `v${version}`
const notesAt = process.argv.indexOf('--notes')
const notes = notesAt >= 0 ? process.argv[notesAt + 1]?.trim() : ''
if (!/^\d+\.\d+\.\d+$/.test(version) || !notes) throw new Error('需要有效 SemVer 版本及 --notes 更新说明')
if (!changelog.includes(`## ${version}`)) throw new Error(`CHANGELOG 缺少 ## ${version}`)
if (!config.includes('identity: "-"')) throw new Error('macOS 必须使用 ad-hoc 签名')
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error('拒绝使用环境变量 Token')
const keychain = spawnSync('security', ['find-generic-password', '-s', 'gh:github.com'], { stdio: 'ignore' })
if (keychain.status !== 0) throw new Error('macOS Keychain 中未找到 gh:github.com 凭据项')
const auth = spawnSync('gh', ['auth', 'status', '--hostname', 'github.com'], { stdio: 'ignore' })
if (auth.status !== 0) throw new Error('GitHub CLI 未登录')
const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8' }).trim()
const api = (method, endpoint, body) => new Promise((resolve, reject) => {
  const req = httpsRequest(new URL(`https://api.github.com${endpoint}`), { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'kaida-release-publisher' } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = text ? JSON.parse(text) : undefined } catch { data = text }
      if ((res.statusCode ?? 500) >= 400) reject(new Error(`GitHub API ${res.statusCode}: ${data?.message ?? data}`)); else resolve(data)
    })
  }); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end()
})
const upload = (releaseId, filePath) => new Promise((resolve, reject) => {
  const name = path.basename(filePath); stat(filePath).then(info => {
    const req = httpsRequest(new URL(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`), { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'User-Agent': 'kaida-release-publisher' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let data; try { data = text ? JSON.parse(text) : undefined } catch { data = text }
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`上传 ${name} 失败：${data?.message ?? data}`)); else resolve(data)
      })
    }); req.setTimeout(20 * 60 * 1000, () => req.destroy(new Error(`上传 ${name} 超时`))); req.on('error', reject); createReadStream(filePath).on('error', reject).pipe(req)
  }).catch(reject)
})
async function uploadWithRetry(releaseId, filePath) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await upload(releaseId, filePath) }
    catch (error) { if (attempt === 3) throw error; console.log(`上传 ${path.basename(filePath)} 失败，${attempt}/3 重试`); await new Promise(resolve => setTimeout(resolve, attempt * 3000)) }
  }
}
async function sha256(filePath) { const hash = createHash('sha256'); hash.update(await readFile(filePath)); return hash.digest('hex') }
async function verifyManifest(filePath, artifactNames) {
  const text = await readFile(filePath, 'utf8')
  if (!text.includes(`version: ${version}`) || artifactNames.some(name => !text.includes(`- url: ${name}`))) throw new Error(`更新清单内容不匹配：${path.basename(filePath)}`)
  for (const name of artifactNames) {
    const match = text.match(new RegExp(`- url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s+sha512: ([^\\n]+)\\n\\s+size: (\\d+)`))
    const local = await readFile(path.join(path.dirname(filePath), name))
    const sha512 = createHash('sha512').update(local).digest('base64')
    if (!match || match[1] !== sha512 || Number(match[2]) !== local.byteLength) throw new Error(`更新清单校验失败：${name}`)
  }
}
async function waitUploaded(assetId) {
  for (let i = 0; i < 120; i++) {
    const asset = await api('GET', `/repos/${repo}/releases/assets/${assetId}`)
    if (asset.state === 'uploaded' && asset.digest) return asset
    if (asset.state !== 'starter') throw new Error(`资产 ${asset.name} 状态异常：${asset.state}`)
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
  throw new Error(`资产处理超时：${assetId}`)
}
const buildRoot = await mkdtemp(path.join(os.tmpdir(), `kaida-${version}-`))
const platforms = [
  { args: ['--mac', 'dmg', 'zip', '--arm64'], dir: path.join(buildRoot, 'mac-arm64'), manifest: 'latest-mac.yml', files: [`kaida-auto-quiz-${version}-macOS.dmg`, `kaida-auto-quiz-${version}-macOS.zip`] },
  { args: ['--win', 'nsis', '--x64'], dir: path.join(buildRoot, 'win-x64'), manifest: 'latest.yml', files: [`kaida-auto-quiz-${version}-Windows.exe`] },
]
const main = async () => {
  const relevant = ['package.json', 'package-lock.json', 'electron-builder.yml', 'electron', 'src', 'build']
  const status = spawnSync('git', ['status', '--porcelain', '--', ...relevant], { encoding: 'utf8' })
  if (status.status !== 0 || status.stdout.trim()) throw new Error('发布前要求本次源码和打包配置已提交')
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
  if (build.status !== 0) throw new Error('应用源码构建失败')
  for (const platform of platforms) {
    const browserDir = path.join(buildRoot, platform.args[0] === '--mac' ? 'browser-mac-arm64' : 'browser-win-x64')
    const browser = spawnSync('node', [path.join(root, 'scripts/prepare-browsers.mjs'), platform.args[0] === '--mac' ? 'mac-arm64' : 'win-x64', browserDir], { stdio: 'inherit' })
    if (browser.status !== 0) throw new Error(`${platform.args[0]} Chromium 运行时准备失败`)
    const result = spawnSync('npm', ['exec', '--', 'electron-builder', ...platform.args, `-c.directories.output=${platform.dir}`, '--publish', 'never'], { stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'true', KAIDA_BROWSER_DIR: path.relative(root, browserDir) } })
    if (result.status !== 0) throw new Error(`${platform.args[0]} 安装包构建失败`)
    const revision = (await readdir(browserDir)).find(name => /^chromium-\d+$/.test(name))
    if (!revision) throw new Error(`${platform.args[0]} Chromium 版本目录缺失`)
    const resources = platform.args[0] === '--mac'
      ? path.join(platform.dir, 'mac-arm64', '开大智达舱.app', 'Contents', 'Resources')
      : path.join(platform.dir, 'win-unpacked', 'resources')
    const executable = platform.args[0] === '--mac'
      ? path.join(resources, 'browsers', revision, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
      : path.join(resources, 'browsers', revision, 'chrome-win64', 'chrome.exe')
    await access(executable, constants.R_OK)
  }
  const files = platforms.flatMap(platform => [...platform.files, platform.manifest].map(name => path.join(platform.dir, name)))
  const blockmaps = files.filter(file => /\.(dmg|zip|exe)$/.test(file)).map(file => `${file}.blockmap`)
  files.push(...blockmaps)
  for (const file of files) await access(file, constants.R_OK)
  for (const platform of platforms) await verifyManifest(path.join(platform.dir, platform.manifest), platform.files)
  const push = spawnSync('git', ['push', 'origin', 'HEAD:main'], { stdio: 'inherit' })
  if (push.status !== 0) throw new Error('GitHub main 分支推送失败')
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const taggedCommit = spawnSync('gh', ['api', `repos/${repo}/commits/${target}`, '--jq', '.sha'], { encoding: 'utf8' })
  const releaseCommit = taggedCommit.status === 0 ? taggedCommit.stdout.trim() : head
  if (taggedCommit.status === 0) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', releaseCommit, head])
    if (ancestor.status !== 0) throw new Error(`Tag ${target} 不属于当前发布提交历史`)
    if (releaseCommit !== head) console.log(`复用已有 Tag ${target}：${releaseCommit}（当前 HEAD：${head}，Tag 提交为已审核应用提交）`)
  }
  let release
  try { release = await api('GET', `/repos/${repo}/releases/tags/${target}`) }
  catch (error) {
    if (!(error instanceof Error && error.message.startsWith('GitHub API 404'))) throw error
    release = await api('POST', `/repos/${repo}/releases`, { tag_name: target, target_commitish: 'main', name: `开大智达舱 ${version}`, body: notes, draft: true, prerelease: false })
  }
  if (!release.draft) throw new Error(`Release ${target} 已发布，拒绝覆盖`)
  const names = new Set(files.map(file => path.basename(file)))
  for (const asset of release.assets ?? []) if (names.has(asset.name)) await api('DELETE', `/repos/${repo}/releases/assets/${asset.id}`)
  for (const file of files) {
    const uploaded = await uploadWithRetry(release.id, file)
    const complete = await waitUploaded(uploaded.id)
    const actual = await sha256(file)
    if (complete.digest !== `sha256:${actual}`) throw new Error(`远端 SHA-256 不一致：${path.basename(file)}`)
    console.log(`已上传并校验 ${path.basename(file)}`)
  }
  const refreshed = await api('GET', `/repos/${repo}/releases/${release.id}`)
  const expected = files.map(file => path.basename(file)).sort()
  const actual = (refreshed.assets ?? []).filter(asset => asset.state === 'uploaded').map(asset => asset.name).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error('远端资产集合不完整或包含错误文件')
  const published = await api('PATCH', `/repos/${repo}/releases/${release.id}`, { draft: false })
  if (published.draft) throw new Error('Release 仍是草稿状态')
  const remoteRoot = path.join(buildRoot, 'remote-assets')
  await mkdir(remoteRoot)
  const download = spawnSync('gh', ['release', 'download', target, '--repo', repo, '--dir', remoteRoot], { stdio: 'inherit' })
  if (download.status !== 0) throw new Error('远端 Release 资产下载失败')
  for (const file of files) {
    const remote = path.join(remoteRoot, path.basename(file))
    if ((await stat(file)).size !== (await stat(remote)).size || await sha256(file) !== await sha256(remote)) throw new Error(`远端资产重新下载校验失败：${path.basename(file)}`)
  }
  await rm(buildRoot, { recursive: true, force: true })
  console.log(`发布完成：https://github.com/${repo}/releases/tag/${target}`)
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
