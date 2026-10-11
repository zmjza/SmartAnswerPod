import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Module, createRequire } from 'node:module'
import { resolve } from 'node:path'
import { chromium } from 'patchright'
import { oldCenterHtml, homeworkHtml, catalogHref, homeworkHref } from './helpers/t004-school.mjs'

// 只隔离本机存储和Electron资源边界；课程扫描、检测和runner均运行生产实现。
const state = { held: false, closed: false, stop: null }
globalThis.__t004Runner = state
const boundary = {
  electron: 'export const app={getVersion:()=>"test"}; export class Notification { static isSupported(){return false} }',
  './store': `export const listAccounts=()=>[{local_id:'one',name:'脱敏学生',username:'fixture-user',password:'fixture-password',display_mode:'headless',work_mode:'extract',course_scope:'selected',answer_round_limit:1}]; export const getSettings=()=>({account_parallel:1,course_parallel:1}); export const getWriteback=()=>[]; export const getExtractWriteback=()=>[]; export const saveWriteback=()=>{}; export const saveExtractWriteback=()=>{}; export const patchAccount=()=>{}; export class ExtractWritebackSaveError extends Error {}`,
  './pool': `const s=globalThis.__t004Runner; export const slots={setLimit(){}}; export const acquire=async()=>{s.held=true;return {ok:true,context:s.ctx}}; export const release=async()=>{s.held=false}; export const isHeld=()=>s.held; export const markVerify=()=>{}; export const markOccupied=()=>{}; export const browserWindowVisible=()=>false; export const toolbarBrowserCount=()=>Number(s.held); export const averageBrowserMemoryBytes=()=>0; export const browserMemoryStatus=()=> 'idle'; export const getContext=()=>s.ctx`,
}
boundary['./store'] += 'export const isReferenceHashProtected=()=>false; export const protectReferenceHash=()=>{throw Error("本回归禁止写题库")};'
boundary['./store'] = boundary['./store'].replace("local_id:'one'", "local_id:globalThis.__t004Runner.accountId||'one'")
const built = await build({ entryPoints:['electron/runner.ts'],bundle:true,platform:'node',format:'cjs',external:['patchright'],write:false,plugins:[{name:'local-boundaries',setup(plugin){
  plugin.onResolve({filter:/^(electron|[.]\/(?:store|pool))$/},args=>({path:args.path,namespace:'boundary'}))
  plugin.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:boundary[args.path],loader:'js'}))
}}] })
const mod = new Module(resolve('.playwright/t004-runner.cjs'))
mod.filename=resolve('.playwright/t004-runner.cjs')
mod.paths=createRequire(resolve('package.json')).resolve.paths('patchright')
mod._compile(built.outputFiles[0].text,mod.filename)
const runner=mod.exports
const browser=await chromium.launch({headless:true,channel:process.env.KAIDA_TEST_BROWSER?'chromium':'chrome',executablePath:process.env.KAIDA_TEST_BROWSER})
const ctx=await browser.newContext()
state.ctx=ctx
await ctx.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname
  const body=path==='/scenter'?oldCenterHtml({courses:[{name:'脱敏课程',href:catalogHref('c1')}]}):path.toLowerCase().endsWith('learncatalognew.aspx')?`<a id="courseHomeWorkNew" href="${homeworkHref('c1')}">形考作业</a>`:homeworkHtml()
  return route.fulfill({contentType:'text/html',body})
})
const portal = await ctx.newPage()
ctx.on('page',page=>{
  const close=page.close.bind(page)
  page.close=async(...args)=>{
    await close(...args)
    if(!state.closed){state.closed=true;state.stop=runner.stopStudent('one')}
  }
})
let timer
try {
  for (const fail of [true,false]) {
    const id=fail?'qr-failure':'qr-success'
    state.accountId=id
    runner.snapshot()
    await portal.setContent('<div id="dl_qrCodeCheck" style="width:200px;height:200px">微信扫码验证<div id="qrCode" style="width:100px;height:100px"></div></div>')
    let captured=false, finishScreenshot
    const pendingScreenshot=new Promise((resolve,reject)=>{finishScreenshot=()=>fail?reject(Error('截图期间页面已关闭')):resolve(Buffer.from('internal-qr'))})
    const locator=portal.locator.bind(portal)
    portal.locator=(selector,...args)=>selector==='#dl_qrCodeCheck'?{screenshot:()=>{captured=true;return pendingScreenshot}}:locator(selector,...args)
    const waiting=runner.waitForVerify(id,portal,'qr-gone',{courseName:'脱敏课程',homeworkName:'脱敏作业'})
    try {
      for(let i=0;i<100&&!captured;i++) await portal.waitForTimeout(10)
      assert.equal(captured,true)
      await runner.stopStudent(id)
      finishScreenshot()
      await waiting
      const student=runner.snapshot().students[0]
      assert.equal(student.account,'stopped','截图结果不能覆盖停止终态')
      assert.equal(student.slot,'released')
      assert.equal(student.needsVerify,false)
      assert.equal(student.verified,false)
      assert.equal(runner.getQrSnapshot(id).ok,false)
      assert.equal(runner.isRunning(),false)
    } finally { portal.locator=locator }
  }
  state.accountId='qr-refresh'
  runner.snapshot()
  await portal.setContent('<div id="dl_qrCodeCheck" style="width:200px;height:200px">微信扫码验证<button>刷新</button></div>')
  let firstCapture=false, finishFirstCapture
  const firstScreenshot=new Promise(resolve=>{finishFirstCapture=()=>resolve(Buffer.from('old-qr'))})
  const qrLocator=portal.locator.bind(portal)
  portal.locator=(selector,...args)=>selector==='#dl_qrCodeCheck'?{screenshot:()=>{
    if(firstCapture) return Promise.resolve(Buffer.from('new-qr'))
    firstCapture=true
    return firstScreenshot
  }}:qrLocator(selector,...args)
  const waiting=runner.waitForVerify('qr-refresh',portal,'qr-gone',{courseName:'脱敏课程',homeworkName:'脱敏作业'})
  try {
    for(let i=0;i<100&&!firstCapture;i++) await portal.waitForTimeout(10)
    assert.equal(firstCapture,true)
    const refreshed=await runner.refreshQrSnapshot('qr-refresh')
    assert.equal(refreshed.ok,true)
    finishFirstCapture()
    await portal.waitForTimeout(50)
    const current=runner.getQrSnapshot('qr-refresh')
    assert.equal(current.ok,true)
    assert.equal(current.snapshot.version,refreshed.snapshot.version,'晚到的旧截图不能覆盖新刷新版本')
    assert.equal(current.snapshot.image,refreshed.snapshot.image)
  } finally {
    portal.locator=qrLocator
    await runner.stopStudent('qr-refresh')
    await waiting
  }
  console.log('T004 晚到的旧二维码截图不覆盖刷新版本检查通过')
  state.accountId=undefined
  console.log('T004 二维码截图成功和失败期间停止检查通过')
  const run=runner.loginAndRefresh(['one'])
  await Promise.race([run,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('检测最后close期间停止后runner仍创建等待器')),3000)})])
  await state.stop
  const student=runner.snapshot().students[0]
  assert.equal(state.closed,true)
  assert.equal(student.account,'stopped')
  assert.equal(student.awaitingCourseSelection,false)
  assert.equal(student.slot,'released')
  assert.equal(runner.isRunning(),false)
  console.log('T004 runner检测最后close期间停止检查通过')
} finally {
  clearTimeout(timer)
  await runner.stopStudent('one')
  await browser.close()
}
