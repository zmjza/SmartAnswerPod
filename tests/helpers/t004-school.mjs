const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
export const catalogHref = (id, minor = 'm') => `https://l.shou.org.cn/study/learnCatalogNew.aspx?courseOpenId=${encodeURIComponent(id)}&minorCourseOpenId=${encodeURIComponent(minor)}`
export const homeworkHref = (id, minor = 'm') => `https://l.shou.org.cn/study/HomeWorkNew.aspx?courseopenid=${encodeURIComponent(id)}&minorcourseopenid=${encodeURIComponent(minor)}`
export const externalHref = 'https://sou.aihaoke.net/api/auth/unified/toAuth?fixture=external'

export function newCenterHtml({ courses = [], delay = 30, home = false, error = false, shell = false, initialFilter = 'active', preserveFilter = false, emptySwitch = false, contentDelay = 0, staleEmpty = false } = {}) {
  const data = JSON.stringify(courses).replace(/</g, '\\u003c')
  return String.raw`<!doctype html><meta charset="utf-8"><nav aria-label="主导航"><button aria-label="学习" onclick="location.href='/learning'">学习</button></nav>
  ${home ? '' : '<div aria-label="课程列表" style="height:140px;overflow:auto"></div><div aria-label="课程学习空间"></div>'}
  <script>
  const courses=${data}, delay=${delay}; window.actions=[]; actions.push=function(...items){Array.prototype.push.apply(this,items);document.documentElement.dataset.actions=JSON.stringify(this)}; let selected, lastState, state=${JSON.stringify(initialFilter)};
  function tasks(c) {
    const space=document.querySelector('[aria-label="课程学习空间"]');
    if(c.external&&c.reuseExternalFrame&&space.querySelector('iframe')) {
      space.querySelectorAll('p').forEach(node=>node.remove()); return;
    }
    if(c.external){ const src=c.externalSrc||${JSON.stringify(externalHref)}; space.innerHTML=(c.externalError?'<div role="alert">课程任务加载失败</div>':'')+(c.externalLoading?'<p>正在加载课程学习空间…</p>':'')+(c.noExternalFrame?'':'<iframe title="'+(c.iframeTitle||'课程学习空间')+'" src="'+src+'"></iframe>')+(c.noExternalLink?'':'<a target="_blank" href="'+(c.externalLink||src)+'">在新窗口打开</a>'); return; }
    const filters=['active','completed','overdue'].map(s=>'<button data-figma-segmented-tab-key="'+s+'" aria-pressed="'+(state===s)+'" onclick="filter(\''+s+'\')">'+s+'</button>').join('');
    const show=(c.filter||'active')===state && !c.missing;
    const content=show?'<div role="list" aria-label="'+c.name+' 课程任务"><div role="listitem" data-task-tree-node-kind="lesson"><button aria-label="去完成：在线学习" onclick="actions.push(\'wrong\')">去完成</button><button aria-label="我已完成：完成课程形考作业" onclick="actions.push(\'confirm\')">我已完成</button><button aria-label="去完成：完成课程形考作业" onclick="openHomework()">去完成</button><button aria-label="去完成：形考成绩查询" onclick="actions.push(\'wrong\')">去完成</button></div></div>':'暂无'+({active:'进行中',completed:'已完成',overdue:'已逾期'}[state])+'的课程任务。';
    const stale=${staleEmpty}&&lastState&&lastState!==state?'暂无'+({active:'进行中',completed:'已完成',overdue:'已逾期'}[lastState])+'的课程任务。':''; lastState=state;
    space.innerHTML=filters+'<div role="region" aria-label="课程任务"><div aria-label="'+c.name+' 课程任务">'+(${contentDelay}?stale:content)+'</div></div><a href="'+c.catalog+'">查看更多课程详情 »</a><label><input type="checkbox" onchange="actions.push(\'required\')">只显示必做</label>';
    if(${contentDelay}){ const outer=space.querySelector('[role="region"] > div'); setTimeout(()=>{if(outer.isConnected)outer.innerHTML=content},${contentDelay}); }
  }
  function openHomework(){ actions.push('popup:'+selected.ref); if(!selected.noPopup) window.open(selected.popup); }
  function filter(s){ actions.push('filter:'+selected.ref+':'+s); state=s; const c=selected; const space=document.querySelector('[aria-label="课程学习空间"]'); space.insertAdjacentHTML('afterbegin','<p>正在加载课程学习空间…</p>'); setTimeout(()=>tasks(c), delay); }
  function select(ref){ const c=courses.find(c=>c.ref===ref); selected=c;if(!${preserveFilter})state='active';actions.push('course:'+ref);
    document.querySelectorAll('[data-learning-course-card]').forEach(e=>e.setAttribute('data-learning-course-card-active',String(e.dataset.learningCourseRef===ref)));
    const space=document.querySelector('[aria-label="课程学习空间"]');
    space.insertAdjacentHTML('afterbegin','<p>正在加载课程学习空间…</p>'); setTimeout(()=>tasks(c),delay);
  }
  if(!${home} && !${shell}) setTimeout(()=>{
    const list=document.querySelector('[aria-label="课程列表"]');
    if(${error}){list.innerHTML='<div role="alert">课程加载失败，请重试</div>';return;}
    if(!courses.length){list.innerHTML='<p>暂无课程</p>';return;}
    list.innerHTML=courses.map(c=>'<article data-learning-course-card data-learning-course-ref="'+c.ref+'" data-learning-course-card-active="false" style="height:130px"><h3>'+c.name+'</h3><button aria-label="切换课程：'+(c.switchName||c.name)+'" '+(c.disabledSwitch?'disabled':'')+' '+(${emptySwitch}?'style="width:0;height:0;padding:0;border:0"':'')+' onclick="select(\''+c.ref+'\')">'+(${emptySwitch}?'':'切换')+'</button></article>').join('');
    select(courses[0].ref);
  },delay);
  </script>`
}

export function oldCenterHtml({ courses = [], pinned = [], collections = [], error = false } = {}) {
  const card = (c) => `<div class="course-item"><div class="course-title"><a class="el-link" title="点击进入学习" href="${esc(c.href || catalogHref(c.id))}"><span class="el-link__inner">${esc(c.name)}</span></a></div></div>`
  return `<!doctype html><meta charset="utf-8"><button id="tab-courseList" class="is-active">我的课程</button><div class="box-card"><div class="el-card__body"><div class="el-tabs__content">${pinned.map(card).join('')}<div id="pane-courseList">${error ? '<div role="alert">课程加载失败，请重试</div>' : courses.map(card).join('')}</div><div id="pane-collections">${collections.map(card).join('')}</div></div></div></div>`
}

export function homeworkHtml({ courseId = 'c1', online = [], phased = [] } = {}) {
  const section = (id, title, items) => items.length ? `<div id="${id}"><h3>${title}</h3><table class="am-table"><tbody>${items.map((hw,i)=>`<tr><td>${i+1}</td><td title="${esc(hw.name)}">${esc(hw.name)}</td><td>作业</td><td>${esc(hw.workType || '客观题')}</td><td>${hw.weight ?? 100}%</td><td title="${hw.start || '2020/1/1'}">开始</td><td title="${hw.end || '2099/1/1'}">结束</td><td>${hw.used || 0}/${hw.cap || '无限制'}<input name="replyCount" type="hidden" value="${hw.cap ?? -1}"></td><td><a href="/study/assignment-preview.aspx?courseopenid=${esc(courseId)}&homeWorkId=${esc(hw.id || String(i))}">查看</a></td></tr>`).join('')}</tbody></table></div>` : `<h3>${title}：暂无数据</h3>`
  return `<!doctype html><meta charset="utf-8"><a id="courseHomeWorkNew" href="${esc(homeworkHref(courseId))}">形考作业</a>${section('onlineHomework','网上记分作业列表',online)}${section('phasedTest','阶段性测验',phased)}`
}

export function previewHtml({ score = null, status = '已批阅' } = {}) {
  return `<!doctype html><meta charset="utf-8"><div id="mainContent"><table class="am-table"><thead><tr><th>作答历史</th></tr></thead><tbody>${score === null ? '' : `<tr><td>1</td><td>2026/9/1</td><td>10</td><td>${esc(status)}</td><td title="${score}">${score}</td><td><a href="/study/assignment/history.aspx">查看</a></td></tr>`}</tbody></table></div><a class="am-btn" href="/study/assignment/preview.aspx" onclick="document.getElementById('dl_qrCodeCheck').hidden=false;return false">做作业</a><div id="dl_qrCodeCheck" hidden>微信扫码验证</div>`
}
