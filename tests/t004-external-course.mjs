import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Module, createRequire } from 'node:module'
import { resolve } from 'node:path'
import { chromium } from 'patchright'
import { newCenterHtml, homeworkHtml, previewHtml, catalogHref, homeworkHref } from './helpers/t004-school.mjs'

// 仅隔离存储和Electron资源边界；runner、登录、扫描、检测、二维码均使用生产实现。
const state={held:false,accountId:'external-all',scope:'all',workMode:'answer',writes:0}
globalThis.__t004External=state
const boundary={
  electron:'export const app={getVersion:()=>"test"}; export class Notification {static isSupported(){return false}}',
  './store':`const s=globalThis.__t004External; export const listAccounts=()=>[{local_id:s.accountId,name:'脱敏学生',username:'fixture',password:'fixture',display_mode:'headless',work_mode:s.workMode,course_scope:s.scope,answer_round_limit:1}]; export const getSettings=()=>({account_parallel:1,course_parallel:2}); export const getWriteback=()=>[]; export const getExtractWriteback=()=>[]; export const saveWriteback=items=>{s.writes+=items.length}; export const saveExtractWriteback=items=>{s.writes+=items.length}; export const patchAccount=()=>{}; export class ExtractWritebackSaveError extends Error {}; export const isReferenceHashProtected=()=>false; export const protectReferenceHash=()=>{throw Error('本回归禁止写题库')}`,
  './pool':`const s=globalThis.__t004External; export const slots={setLimit(){}}; export const acquire=async()=>{s.held=true;return {ok:true,context:s.ctx}}; export const release=async()=>{if(s.held){s.held=false;await s.ctx.close()}}; export const isHeld=()=>s.held; export const markVerify=()=>{}; export const markOccupied=()=>{}; export const browserWindowVisible=()=>false; export const toolbarBrowserCount=()=>Number(s.held); export const averageBrowserMemoryBytes=()=>0; export const browserMemoryStatus=()=> 'idle'; export const getContext=()=>s.ctx`,
}
const built=await build({entryPoints:['electron/runner.ts'],bundle:true,platform:'node',format:'cjs',external:['patchright'],write:false,plugins:[{name:'local-boundaries',setup(plugin){
  plugin.onResolve({filter:/^(electron|[.]\/(?:store|pool))$/},args=>({path:args.path,namespace:'boundary'}))
  plugin.onLoad({filter:/.*/,namespace:'boundary'},args=>({contents:boundary[args.path],loader:'js'}))
}}]})
const mod=new Module(resolve('.playwright/t004-external.cjs'))
mod.filename=resolve('.playwright/t004-external.cjs')
mod.paths=createRequire(resolve('package.json')).resolve.paths('patchright')
mod._compile(built.outputFiles[0].text,mod.filename)
const runner=mod.exports
const browser=await chromium.launch({headless:true,channel:process.env.KAIDA_TEST_BROWSER?'chromium':'chrome',executablePath:process.env.KAIDA_TEST_BROWSER})
const message='新答题界面暂时不支持，等后续开发'
const courses=['before','external','after'].map(id=>({ref:'ref-'+id,name:'同名课程',catalog:catalogHref(id),popup:homeworkHref(id),external:id==='external'}))
async function waitUntil(predicate,description){
  const end=Date.now()+6000
  while(Date.now()<end){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,25))}
  throw Error(description)
}
try {
  for(const {scope,workMode} of [{scope:'all',workMode:'answer'},{scope:'selected',workMode:'answer'},{scope:'all',workMode:'extract'}]){
    state.scope=scope
    state.workMode=workMode
    state.accountId='external-'+scope+'-'+workMode
    const ctx=await browser.newContext()
    state.ctx=ctx
    const requests={homework:[],preview:[],thirdPartyTop:0,answers:0,writes:0}
    await ctx.route('**/*',route=>{
      const req=route.request(),url=new URL(req.url())
      if(req.method()!=='GET'){requests.writes++;return route.abort()}
      if(url.hostname==='sou.aihaoke.net'){
        if(req.isNavigationRequest()&&req.frame().parentFrame()===null)requests.thirdPartyTop++
        return route.abort()
      }
      let body
      if(url.hostname==='learning.shou.org.cn')body='<script>location.href="https://aiedu.shou.org.cn/learning"</script>'
      else if(url.hostname==='aiedu.shou.org.cn')body=newCenterHtml({courses,emptySwitch:true})
      else if(/HomeWorkNew.aspx/i.test(url.pathname)){
        const id=url.searchParams.get('courseopenid');requests.homework.push(id)
        body=homeworkHtml({courseId:id,online:id==='after'&&workMode==='answer'?[{name:'后续作业',id:'todo'}]:[]})
      }else if(url.pathname==='/study/assignment-preview.aspx'){
        requests.preview.push(url.searchParams.get('courseopenid'))
        body=previewHtml().replace('hidden>微信扫码验证','hidden style="width:200px;height:200px;background:white">微信扫码验证')
      }else{requests.answers++;return route.abort()}
      return route.fulfill({contentType:'text/html',body})
    })
    const portal=await ctx.newPage()
    await portal.goto('https://aiedu.shou.org.cn/learning')
    const run=runner.loginAndRefresh([state.accountId])
    const student=()=>runner.snapshot().students.find(row=>row.local_id===state.accountId)
    try{
      if(scope==='selected'){
        await waitUntil(()=>student()?.awaitingCourseSelection,'混合课程未到选课阶段')
        const keys=student().courses.filter(course=>course.key.startsWith('course:')).map(course=>course.key)
        assert.equal(runner.setSelectedCourses(state.accountId,keys).ok,true)
        assert.equal(student().courses.find(course=>course.key.startsWith('unsupported:'))?.status,message,'未选择第三方课也必须保留原因')
        assert.equal(runner.startSelectedCourseExecution().ok,true)
      }
      if(workMode==='answer') await waitUntil(()=>runner.getQrSnapshot(state.accountId).ok,'第三方课程阻塞后续正常作业二维码')
      else await run
      const view=student(),external=view.courses.find(course=>course.key.startsWith('unsupported:'))
      assert.equal(view.courses.length,3)
      assert.equal(external?.status,message)
      assert.deepEqual(external.groups,[])
      assert.equal(view.courses[0].status,'无作业')
      if(workMode==='answer'){
        assert.equal(view.courses[2].groups[0].rows[0].name,'后续作业')
        assert.equal(runner.getQrSnapshot(state.accountId).snapshot.homeworkName,'后续作业')
      }else{
        assert.equal(view.account,'round_ended')
        assert.equal(view.extractTotalCourses,2,'第三方课不得算入支持的提取课程')
        assert.equal(view.extractCompletedCourses,2)
      }
      assert.ok(requests.homework.includes('before')&&requests.homework.includes('after'))
      assert.equal(requests.homework.includes('external'),false)
      assert.deepEqual(requests.preview,workMode==='answer'?['after']:[])
      assert.equal(requests.thirdPartyTop,0)
      assert.equal(requests.answers,0)
      assert.equal(requests.writes,0)
      assert.equal(state.writes,0)
    }finally{
      await runner.stopStudent(state.accountId)
      await run
      assert.equal(student().account,'stopped')
      assert.equal(student().slot,'released')
      assert.equal(student().needsVerify,false)
      assert.equal(student().verified,false)
      assert.equal(runner.isRunning(),false)
      assert.equal(ctx.pages().length,0)
      await ctx.close()
    }
    console.log('PASS 第三方课程跳过且支持课程继续执行、停止清理 '+scope+' '+workMode)
  }
}finally{await runner.stopStudent(state.accountId);await browser.close()}
