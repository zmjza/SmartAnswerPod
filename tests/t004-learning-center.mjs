import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Module, createRequire } from 'node:module'
import { resolve } from 'node:path'
import { chromium } from 'patchright'
import { newCenterHtml, oldCenterHtml, homeworkHtml, previewHtml, catalogHref, homeworkHref, externalHref } from './helpers/t004-school.mjs'

const built = await build({ stdin: { contents: "export * from './electron/detect.ts'; export * from './electron/login.ts'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', external: ['patchright'], write: false })
const mod = new Module(resolve('.playwright/t004-modules.cjs'))
mod.filename = resolve('.playwright/t004-modules.cjs')
mod.paths = createRequire(resolve('package.json')).resolve.paths('patchright')
mod._compile(built.outputFiles[0].text, mod.filename)
const { listCourses, detectCourse, loginIam } = mod.exports
const browser = await chromium.launch({ headless: true, channel: process.env.KAIDA_TEST_BROWSER ? 'chromium' : 'chrome', executablePath: process.env.KAIDA_TEST_BROWSER })
let checks = 0
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name) }
const sample = (id, overrides = {}) => ({ ref: 'opaque-' + id, name: '课程 ' + id, catalog: catalogHref(id), popup: homeworkHref(id), ...overrides })
async function setup({ courses = [sample('c1')], home = false, center = {}, homework = {}, preview = {}, old = false } = {}) {
  const ctx = await browser.newContext()
  const requests = []
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url())
    requests.push(u.pathname)
    if(u.hostname === 'sou.aihaoke.net') return route.abort()
    if(u.hostname === 'learning.shou.org.cn') {
      if(!old) return route.fulfill({ contentType: 'text/html', body: `<script>location.href=${JSON.stringify('https://aiedu.shou.org.cn/' + (home ? '' : 'learning'))}</script>` })
      return route.fulfill({ contentType: 'text/html', body: oldCenterHtml({ courses: courses.map(c => ({name:c.name,href:c.catalog})) }) })
    }
    if(u.hostname === 'aiedu.shou.org.cn') return route.fulfill({ contentType: 'text/html', body: newCenterHtml({ courses, ...center, home: u.pathname === '/' }) })
    if(u.pathname.toLowerCase().endsWith('/learncatalognew.aspx')) return route.fulfill({ contentType: 'text/html', body: `<a id="courseHomeWorkNew" href="${homeworkHref(u.searchParams.get('courseOpenId'))}">形考作业</a>` })
    if(u.pathname.toLowerCase().endsWith('/homeworknew.aspx')) return route.fulfill({ contentType: 'text/html', body: homeworkHtml(homework) })
    if(u.pathname.includes('assignment-preview')) return route.fulfill({ contentType: 'text/html', body: previewHtml(preview) })
    return route.fulfill({ contentType: 'text/html', body: '<p>未知页面</p>' })
  })
  const page = await ctx.newPage()
  page.setDefaultTimeout(1500)
  await page.goto(old ? 'https://learning.shou.org.cn/scenter' : 'https://aiedu.shou.org.cn/' + (home ? '' : 'learning'))
  return { ctx, page, requests }
}
const scan = (page, signal) => listCourses(page, 'test-student', 'idle', signal)
const detect = (page, href, extra = {}) => detectCourse({ portal:page,href,key:'course:c1:m',courseName:'课程 c1',local_id:'test-student',slot:'idle',index:1,total:1,...extra })
const login = (page) => loginIam({page,local_id:'test-student',username:'fixture-user',password:'fixture-password',slot:'idle',onNeedVerify:async()=>{throw Error('不应验证')}})
async function timely(task, ms = 4000) {
  let timer
  task.catch(() => {})
  try { return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('已就绪页面未被接受')),ms)})]) }
  finally { clearTimeout(timer) }
}
try {
  await check('第三方课程复用同iframe及同src时加载完成仍正常跳过', async () => {
    const {ctx,page}=await setup({courses:[sample('external1',{external:true}),sample('external2',{external:true,reuseExternalFrame:true}),sample('after')],center:{delay:150}})
    try {
      const listed=await timely(scan(page),3000)
      assert.equal(listed.length,3)
      assert.ok(listed.slice(0,2).every(course=>course.unsupportedReason==='新答题界面暂时不支持，等后续开发'))
      assert.notEqual(listed[0].key,listed[1].key)
      assert.equal(listed[2].key,'course:after:m')
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('本次第三方iframe与加载提示并存仍跳过且后续普通课继续', async () => {
    const {ctx,page}=await setup({courses:[sample('before'),sample('external',{external:true,externalLoading:true}),sample('after')],center:{delay:150}})
    const controller=new AbortController()
    const task=scan(page,controller.signal)
    try {
      const listed=await timely(task,3000)
      assert.deepEqual(listed.filter(c=>!c.unsupportedReason).map(c=>c.key),['course:before:m','course:after:m'])
      assert.equal(listed[1].unsupportedReason,'新答题界面暂时不支持，等后续开发')
      assert.equal(ctx.pages().length,1)
    } finally { controller.abort(); await task.catch(()=>{}); await ctx.close() }
  })
  await check('本次第三方iframe与加载失败并存仍跳过且后续普通课继续', async () => {
    const {ctx,page}=await setup({courses:[sample('before'),sample('external',{external:true,externalError:true}),sample('after')],center:{delay:150}})
    const controller=new AbortController()
    const task=scan(page,controller.signal)
    try {
      const listed=await timely(task,3000)
      assert.deepEqual(listed.filter(c=>!c.unsupportedReason).map(c=>c.key),['course:before:m','course:after:m'])
      assert.equal(listed[1].unsupportedReason,'新答题界面暂时不支持，等后续开发')
      assert.equal(ctx.pages().length,1)
    } finally { controller.abort(); await task.catch(()=>{}); await ctx.close() }
  })
  await check('第三方切普通课时旧iframe保留100ms不能误跳新课', async () => {
    const {ctx,page}=await setup({courses:[sample('external',{external:true}),sample('after')],center:{delay:350}})
    const controller=new AbortController()
    const task=scan(page,controller.signal)
    try {
      await page.waitForFunction(()=>document.documentElement.dataset.actions?.includes('course:opaque-after'))
      await page.waitForTimeout(100)
      assert.equal(await page.locator('[aria-label="课程学习空间"] iframe').count(),1,'切课期间保留上一课iframe')
      assert.equal(await page.locator('[data-learning-course-ref="opaque-after"]').getAttribute('data-learning-course-card-active'),'true')
      const listed=await timely(task,3000)
      assert.equal(listed[0].unsupportedReason,'新答题界面暂时不支持，等后续开发')
      assert.deepEqual(listed[1],{name:'课程 after',href:homeworkHref('after'),key:'course:after:m'})
      assert.equal(ctx.pages().length,1)
    } finally { controller.abort(); await task.catch(()=>{}); await ctx.close() }
  })
  await check('第三方课程明确标记跳过，同名身份独立且继续后续课程', async () => {
    const courses=[sample('before',{name:'同名课'}),sample('external1',{name:'同名课',external:true}),sample('external2',{name:'同名课',external:true,externalSrc:'https://other-learning.example/course/auth'}),sample('after',{name:'同名课'})]
    const {ctx,page,requests}=await setup({courses,center:{emptySwitch:true}})
    const controller=new AbortController()
    const task=scan(page,controller.signal)
    try {
      const listed=await timely(task,3000)
      assert.equal(listed.length,4)
      assert.equal(listed[0].key,'course:before:m')
      assert.equal(listed[3].key,'course:after:m')
      for(const course of listed.slice(1,3)) {
        assert.equal(course.href,'')
        assert.equal(course.unsupportedReason,'新答题界面暂时不支持，等后续开发')
        assert.match(course.key,/^unsupported:[a-f0-9]{64}$/)
      }
      assert.notEqual(listed[1].key,listed[2].key)
      assert.equal(requests.filter(path=>/HomeWorkNew.aspx/i.test(path)).length,2)
      assert.equal(ctx.pages().length,1)
    } finally { controller.abort(); await task.catch(()=>{}); await ctx.close() }
  })
  await check('缺iframe或同外链、HTTP和原站结构不能当不支持课程跳过', async () => {
    for(const invalid of [{noExternalFrame:true},{noExternalLink:true},{externalLink:externalHref+'&different=1'},{externalSrc:'http://sou.aihaoke.net/course'},{externalSrc:homeworkHref('foreign-looking')},{iframeTitle:'未知空间'}]){
      const {ctx,page}=await setup({courses:[sample('external',{external:true,...invalid}),sample('after')]})
      const controller=new AbortController()
      const task=scan(page,controller.signal)
      let settled=false
      task.then(()=>{settled=true},()=>{settled=true})
      try{
        await page.waitForFunction(()=>document.querySelector('[aria-label="课程学习空间"]')?.textContent.includes('在新窗口打开')||document.querySelector('iframe'))
        await page.waitForTimeout(250)
        assert.equal(settled,false,'未知第三方壳必须等待或失败，不能返回跳过条目')
        assert.equal(await page.locator('[data-learning-course-ref="opaque-after"]').getAttribute('data-learning-course-card-active'),'false')
        controller.abort()
        await assert.rejects(task,error=>error.name==='AbortError')
        assert.equal(ctx.pages().length,1)
      }finally{controller.abort();await task.catch(()=>{});await ctx.close()}
    }
  })
  await check('缺第三方iframe的错误壳仍明确报错误', async () => {
    const {ctx,page}=await setup({courses:[sample('before'),sample('external',{external:true,externalError:true,noExternalFrame:true})]})
    try { await assert.rejects(timely(scan(page)),/课程任务加载失败/); assert.equal(ctx.pages().length,1) }
    finally { await ctx.close() }
  })
  await check('混合第三方课程扫描停止时清理popup且不切后续课', async () => {
    const {ctx,page}=await setup({courses:[sample('external',{external:true}),sample('pending',{popup:'https://l.shou.org.cn/pending'}),sample('after')]})
    const controller=new AbortController()
    const opened=page.waitForEvent('popup')
    const task=scan(page,controller.signal)
    try{
      const popup=await opened
      await popup.waitForLoadState('domcontentloaded')
      controller.abort()
      await assert.rejects(timely(task,1500),error=>error.name==='AbortError')
      assert.equal(ctx.pages().length,1)
      assert.equal(await page.locator('[data-learning-course-ref="opaque-after"]').getAttribute('data-learning-course-card-active'),'false')
    }finally{controller.abort();await task.catch(()=>{});await ctx.close()}
  })
  await check('课程容器先出现时等待延迟任务列表和对应筛选空态', async () => {
    const {ctx,page}=await setup({courses:[sample('c1'),sample('c2',{filter:'completed'}),sample('c3',{filter:'overdue'})],center:{contentDelay:400,emptySwitch:true,staleEmpty:true}})
    try { assert.deepEqual((await scan(page)).map(c=>c.key),['course:c1:m','course:c2:m','course:c3:m']); assert.equal(ctx.pages().length,1) }
    finally { await ctx.close() }
  })
  await check('无可视面积的辅助切课按钮按精确卡片身份切换', async () => {
    const {ctx,page}=await setup({courses:[sample('c1'),sample('c2')],center:{emptySwitch:true}})
    try {
      assert.deepEqual((await scan(page)).map(c=>c.key),['course:c1:m','course:c2:m'])
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('禁用或课程名称不符的切课按钮明确拒绝', async () => {
    for(const invalid of [{disabledSwitch:true},{switchName:'其它课程'}]) {
      const {ctx,page}=await setup({courses:[sample('c1',invalid)],center:{emptySwitch:true}})
      try { await assert.rejects(scan(page),/课程切换按钮不可用/); assert.equal(ctx.pages().length,1) }
      finally { await ctx.close() }
    }
  })
  await check('旧目录缺minor及无ID的身份回退继续检测', async () => {
    const {ctx,page}=await setup({old:true})
    const href='https://l.shou.org.cn/study/HomeWorkNew.aspx?courseopenid=c1'
    await ctx.route('**/learnCatalogNew.aspx*',route=>route.fulfill({contentType:'text/html',body:`<a id="courseHomeWorkNew" href="${href}">形考作业</a>`}))
    try {
      assert.equal((await detect(page,'https://l.shou.org.cn/study/learnCatalogNew.aspx?courseopenid=c1',{key:'course:c1:'})).status,'无作业')
      assert.equal((await detect(page,'https://l.shou.org.cn/study/learnCatalogNew.aspx?access=fixture',{key:'href:fixture-hash'})).status,'无作业')
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('新版学习页采集真实popup URL', async () => {
    const {ctx,page} = await setup()
    try {
      assert.deepEqual(await scan(page), [{ name:'课程 c1',href:homeworkHref('c1'),key:'course:c1:m' }])
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('已有学习页保留其它筛选时显式恢复active', async () => {
    const {ctx,page}=await setup({center:{initialFilter:'completed',preserveFilter:true}})
    try { assert.equal((await timely(scan(page),2500))[0].key,'course:c1:m') }
    finally { await ctx.close() }
  })
  await check('popup异步中转后以最终形考URL核对身份', async () => {
    const {ctx,page}=await setup({courses:[sample('c1',{popup:'https://l.shou.org.cn/redirect'})]})
    await ctx.route('**/redirect',route=>route.fulfill({contentType:'text/html',body:`<script>setTimeout(()=>location.href=${JSON.stringify(homeworkHref('c1'))},300)</script>`}))
    try { assert.deepEqual(await scan(page),[{name:'课程 c1',href:homeworkHref('c1'),key:'course:c1:m'}]); assert.equal(ctx.pages().length,1) }
    finally { await ctx.close() }
  })
  await check('旧版课程明确加载失败不能当无课程或登录成功', async () => {
    const {ctx,page}=await setup({old:true})
    await ctx.route('**/scenter',route=>route.fulfill({contentType:'text/html',body:oldCenterHtml({error:true})}))
    try {
      await page.reload()
      await assert.rejects(timely(scan(page)),/加载失败/)
      await assert.rejects(timely(login(page)),/加载失败/)
    } finally { await ctx.close() }
  })
  await check('popup已打开仍在等待跳转时停止也立即清理', async () => {
    const {ctx,page}=await setup({courses:[sample('c1',{popup:'https://l.shou.org.cn/pending'})]})
    const controller=new AbortController()
    const event=page.waitForEvent('popup')
    const task=scan(page,controller.signal)
    try {
      const popup=await event
      await popup.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(100)
      controller.abort()
      await assert.rejects(timely(task,1500),error=>error.name==='AbortError')
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('已有新版首页会话登录并进入学习', async () => {
    const {ctx,page} = await setup({home:true})
    try { assert.equal((await timely(login(page))).ok,true); assert.equal(new URL(page.url()).pathname,'/learning') }
    finally { await ctx.close() }
  })
  await check('直接形考列表与目录共用检测', async () => {
    const {ctx,page,requests} = await setup({ homework:{online:[{name:'作业',id:'todo'}],phased:[{name:'测验',id:'test'}]} })
    try {
      const result=await detect(page,homeworkHref('c1'))
      assert.equal(requests.filter(p=>p.endsWith('HomeWorkNew.aspx')).length,1,'直接列表不得再点击目录导航')
      assert.deepEqual(result.homeworks.map(h=>h.section),['onlineHomework','phasedTest'])
      for(const hw of result.homeworks) await hw.page?.close()
      assert.equal(ctx.pages().length,1)
      assert.deepEqual((await detect(page,catalogHref('c1'))).homeworks.map(h=>h.section),['onlineHomework','phasedTest'])
    } finally { await ctx.close() }
  })
  await check('目录读取失败关闭本次检测页', async () => {
    const {ctx,page} = await setup()
    try {
      await ctx.route('**/learnCatalogNew.aspx*', route=>route.abort())
      await assert.rejects(detect(page,catalogHref('c1')))
      assert.equal(ctx.pages().length,1,'失败不泄漏检测页')
    } finally { await ctx.close() }
  })
  await check('完整DOM逐课切换、同名身份、筛选空态和旧任务残留', async () => {
    const courses=Array.from({length:12},(_,i)=>sample('c'+(i+1),{name:i===2||i===3?'同名课':'课程 '+(i+1),filter:i===2?'completed':i===3?'overdue':'active'}))
    courses.push(sample('duplicate',{catalog:catalogHref('c3'),popup:homeworkHref('c3')}))
    const {ctx,page}=await setup({courses,center:{delay:150}})
    try {
      const result=await scan(page)
      assert.equal(result.length,12)
      assert.deepEqual(result.slice(2,4).map(c=>[c.name,c.key]),[['同名课','course:c3:m'],['同名课','course:c4:m']])
      const actions=await page.evaluate(()=>JSON.parse(document.documentElement.dataset.actions || '[]'))
      assert.deepEqual(actions.filter(a=>a.startsWith('popup:')),courses.map(c=>'popup:'+c.ref))
      assert.ok(actions.includes('filter:opaque-c3:completed'))
      assert.ok(actions.includes('filter:opaque-c4:overdue'))
      assert.ok(!actions.some(a=>['wrong','confirm','required'].includes(a)))
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
  })
  await check('异步正常无课程接受、读取失败拒绝', async () => {
    for(const error of [false,true]) {
      const {ctx,page}=await setup({courses:[],center:{delay:350,error}})
      try { if(error) await assert.rejects(scan(page),/加载失败/); else assert.deepEqual(await scan(page),[]) }
      finally { await ctx.close() }
    }
  })
  await check('缺入口不能返回半份课表', async () => {
    const {ctx,page}=await setup({courses:[sample('c1'),sample('c2',{missing:true})]})
    try { await assert.rejects(scan(page),/缺少形考/); assert.equal(ctx.pages().length,1) }
    finally { await ctx.close() }
  })
  await check('错误主机、路径、课程身份和缺参数均失败并关闭popup', async () => {
    const urls=[homeworkHref('other'),homeworkHref('c1').replace('l.shou.org.cn','invalid.example'),homeworkHref('c1').replace('HomeWorkNew','Other'), 'https://l.shou.org.cn/study/HomeWorkNew.aspx?minorcourseopenid=m','https://l.shou.org.cn/study/HomeWorkNew.aspx?courseopenid=c1']
    for(const popup of urls) {
      const {ctx,page}=await setup({courses:[sample('c1',{popup})]})
      try { await assert.rejects(scan(page),/形考/); assert.equal(ctx.pages().length,1) }
      finally { await ctx.close() }
    }
  })
  await check('停止采集立即结束popup等待，不切下一课，不关闭其它页', async () => {
    const {ctx,page}=await setup({courses:[sample('c1',{noPopup:true}),sample('c2')]})
    const other=await ctx.newPage()
    const controller=new AbortController()
    const task=scan(page,controller.signal)
    try {
      await page.waitForFunction(()=>document.documentElement.dataset.actions?.includes('popup:opaque-c1'))
      controller.abort()
      await assert.rejects(timely(task,1500),error=>error.name==='AbortError')
      const actions=await page.evaluate(()=>JSON.parse(document.documentElement.dataset.actions || '[]'))
      assert.ok(!actions.includes('course:opaque-c2'))
      assert.equal(other.isClosed(),false)
      assert.equal(ctx.pages().length,2)
    } finally { await ctx.close() }
  })
  await check('失败清理此前已打开的预览页，提取失败沿用既有状态', async () => {
    for(const mode of ['answer','extract']) {
      const {ctx,page}=await setup({homework:{online:[{name:'正常作业',id:'good'},{name:'坏预览',id:'bad'}]}})
      await ctx.route('**/assignment-preview.aspx*',route=>new URL(route.request().url()).searchParams.get('homeWorkId')==='bad'?route.abort():route.fulfill({contentType:'text/html',body:previewHtml()}))
      try {
        if(mode==='answer') { await assert.rejects(detect(page,homeworkHref('c1'),{mode}),/预览页读取失败/); assert.equal(ctx.pages().length,1) }
        else { const result=await detect(page,homeworkHref('c1'),{mode}); assert.equal(result.homeworks[1].extractStats.failed,1); for(const hw of result.homeworks) await hw.page?.close(); assert.equal(ctx.pages().length,1) }
      } finally { await ctx.close() }
    }
  })
  await check('列表为空、满分、窗口、次数和权重沿用原判定', async () => {
    const {ctx,page}=await setup({homework:{online:[{name:'满分',id:'score'},{name:'零权重',weight:0},{name:'窗口外',end:'2021/1/1'},{name:'已用尽',cap:2,used:2}]},preview:{score:100}})
    try {
      const result=await detect(page,homeworkHref('c1'))
      assert.deepEqual(result.homeworks.map(h=>h.status),['skip_full_score','skip_weight0','skip_out_of_window','skip_attempts_exhausted'])
      assert.equal(ctx.pages().length,1)
    } finally { await ctx.close() }
    const empty=await setup()
    try { assert.equal((await detect(empty.page,homeworkHref('c1'))).status,'无作业') }
    finally { await empty.ctx.close() }
  })
  await check('旧置顶Tab扫描保留身份顺序且收藏排除', async () => {
    const {ctx,page}=await setup({old:true})
    await ctx.route('**/scenter',route=>route.fulfill({contentType:'text/html',body:oldCenterHtml({pinned:[{name:'形势与政策（1）',id:'top'}],courses:[{name:'形势与政策（1）',id:'top'},{name:'同名课',id:'a'},{name:'同名课',id:'b'}],collections:[{name:'收藏课',id:'saved'}]})}))
    try {
      await page.reload()
      assert.deepEqual((await scan(page)).map(c=>c.key),['course:top:m','course:a:m','course:b:m'])
    } finally { await ctx.close() }
  })
  await check('新版已有learning及无课程登录，读取失败和壳不冒充成功', async () => {
    for(const courses of [[sample('c1')],[]]) {
      const {ctx,page}=await setup({courses})
      try { assert.equal((await timely(login(page))).ok,true) }
      finally { await ctx.close() }
    }
    const failed=await setup({center:{error:true}})
    try { await assert.rejects(login(failed.page),/加载失败/) }
    finally { await failed.ctx.close() }
    const shell=await setup({center:{shell:true}})
    const controller=new AbortController()
    const timer=setTimeout(()=>controller.abort(),400)
    try { await assert.rejects(scan(shell.page,controller.signal),error=>error.name==='AbortError') }
    finally { clearTimeout(timer); await shell.ctx.close() }
  })
  await check('停止检测不再打开后续预览，混合context互不影响', async () => {
    const newer=await setup({homework:{online:[{name:'第一个',id:'first'},{name:'第二个',id:'second'}]}})
    const older=await setup({old:true,courses:[sample('old')]})
    const controller=new AbortController()
    let previewsOpened=0
    await newer.ctx.route('**/assignment-preview.aspx*',async route=>{previewsOpened++;controller.abort();await route.fulfill({contentType:'text/html',body:previewHtml()})})
    try {
      await assert.rejects(detect(newer.page,homeworkHref('c1'),{signal:controller.signal}),error=>error.name==='AbortError')
      assert.equal(newer.ctx.pages().length,1)
      assert.equal(previewsOpened,1)
      assert.deepEqual((await scan(older.page)).map(c=>c.key),['course:old:m'])
      const already=new AbortController();already.abort()
      await assert.rejects(detect(newer.page,homeworkHref('c1'),{signal:already.signal}),error=>error.name==='AbortError')
      assert.equal(newer.ctx.pages().length,1)
    } finally { await newer.ctx.close(); await older.ctx.close() }
  })
  await check('仿冒主机上的旧Tab不得识别成学习中心', async () => {
    const {ctx,page}=await setup()
    await ctx.route('**/fake-center',route=>route.fulfill({contentType:'text/html',body:oldCenterHtml({courses:[{name:'仿冒课',id:'wrong'}]})}))
    try { await page.goto('https://invalid.example/fake-center'); await assert.rejects(scan(page),/未知学习中心/) }
    finally { await ctx.close() }
  })
  await check('旧版已有会话直接登录就绪，不请求认证兜底', async () => {
    const {ctx,page}=await setup({old:true})
    try { assert.equal((await timely(login(page))).ok,true) }
    finally { await ctx.close() }
  })
  await check('参数名大小写保持实际href，缺目录与popup未打开明确失败', async () => {
    const href=homeworkHref('c1').replace('courseopenid','courseOpenId').replace('minorcourseopenid','minorCourseOpenId')+'&view=1'
    const good=await setup({courses:[sample('c1',{popup:href})]})
    try { assert.deepEqual(await scan(good.page),[{name:'课程 c1',href,key:'course:c1:m'}]) }
    finally { await good.ctx.close() }
    const missing=await setup({courses:[sample('c1',{catalog:''})]})
    try { await assert.rejects(scan(missing.page),/形考入口/); assert.equal(missing.ctx.pages().length,1) }
    finally { await missing.ctx.close() }
    const blocked=await setup({courses:[sample('c1',{noPopup:true})]})
    try { await assert.rejects(scan(blocked.page),/形考跳转未打开/); assert.equal(blocked.ctx.pages().length,1) }
    finally { await blocked.ctx.close() }
  })
} finally { await browser.close() }
console.log(`T004 learning center ${checks} checks passed`)
