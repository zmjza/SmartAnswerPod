# API 文档

> 接口清单与出入参定义。前后端协作依据。
> 不写真实 Key。硅基流动模型 id 开发时核对控制台，以能调通的为准。

## 主进程 IPC（渲染 ↔ 主进程）

第一期内部 IPC，不是公网 HTTP。路径名实现时可微调，语义不得漂。

### 保存设置
- **方法 / 路径**：`IPC settings:save`
- **用途**：写入加密凭据与并行度
- **关联模块**：[[_B]]

#### 请求参数
| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| siliconflow_key | body | string | 否 | 只进 safeStorage |
| supabase_url | body | string | 否 | 项目 URL |
| supabase_anon | body | string | 否 | publishable/anon，禁止 secret |
| account_parallel | body | number | 否 | 默认 2 |
| course_parallel | body | number | 否 | 默认 2 |
| browser_visible_default | body | bool | 否 | 默认关=无头 |
| log_enabled | body | bool | 否 | 默认开 |

#### 响应
| 字段 | 类型 | 说明 |
|------|------|------|
| ok | bool | 加密存储失败则为 false |

### 进度订阅
- **方法 / 路径**：`IPC progress:event`
- **用途**：五层状态与点击日志
- **关联模块**：[[_C]] [[_D]]

进度事件字段以 PRD 第 9 节为准。禁止密码、Key、token、cookie 全文、xhtoken。

### 启动检测
- **方法 / 路径**：`IPC run:detect`
- **用途**：主按钮「登录并刷新课程」
- **关联模块**：[[登录并刷新课程]]

检测阶段禁止点「做作业」。

## Supabase questions

- **方法 / 路径**：`REST /rest/v1/questions`
- **用途**：按 content_hash 查、插、更新、删除；course_names 只随写入追加，不作答过滤
- **关联模块**：[[_I]] [[_L]]
- **鉴权**：anon / publishable，RLS 已建；禁止 service role 进客户端

### 请求参数
| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| content_hash | query | text | 查时是 | 命中键，unique 索引 |
| course_names | body | text[] | 否 | 写入时并入已有数组；JSON 导入可空 |
| 行字段 | body | 见数据字典 | 写时是 | 冲突时 conflict=true 留旧值 |

### 错误码
| 码 | 含义 | 处理建议 |
|----|------|---------|
| 网络/401 | 读失败 | 当未命中走 AI |
| 写失败 | 入库失败 | 进待回写，不卡死 |

## 硅基流动 Chat Completions

- **方法 / 路径**：`POST {siliconflow}/v1/chat/completions`
- **用途**：题库未命中时要选项正文
- **关联模块**：[[_J]]

### 请求参数
| 参数 | 位置 | 类型 | 必填 | 说明 |
|------|------|------|------|------|
| model | body | string | 是 | 14 模型按去重顺序降级 |
| messages | body | array | 是 | 要求只输出 JSON |

### 响应（程序只认）
| 字段 | 类型 | 说明 |
|------|------|------|
| option_texts | string[] | 正确选项正文列表 |

非法 JSON、缺字段、正文不在当前选项集合 → 该模型失败，换下一个。

## 开大站点

## 2026-09-21 新增 IPC 契约

| IPC | 请求 | 响应/事件 | 约束 |
|---|---|---|---|
| runtime:config:get | 无 | 当前配置、推荐值、locked | 真实主进程值 |
| runtime:config:save | 并发与显示设置 | 保存结果 | 运行中拒绝并发热改 |
| runtime:config:changed | 事件 | 最新配置 | 工作台和设置页同步 |
| courses:scope:set | accountId、scope、courseIds | 选择快照 | 运行中拒绝修改 |
| courses:start-selected | 多学生选择汇总 | 队列生成结果 | 至少选一门 |
| homework:history:list | accountId、courseId、homeworkId | 历史成绩列表 | 只读，不续做/提交/回写 |
| logs:course:list | accountId、courseId | 课程日志 | 未选课程拒绝 |
| qr:get | taskId | 二维码内存 PNG、归属、版本与状态 | 不返回站点 token |
| qr:copy | taskId | 剪贴板结果 | 复制图片 |
| qr:refresh | taskId | 新二维码快照 | 优先真实刷新入口；无入口则重开验证弹窗；旧版本立即失效 |
| qr:verify | taskId | 页面复核结果 | 用户触发后才检查 |
| ai:connectivity:start | 无 | 检测批次 ID | 最多并发 3 |
| ai:connectivity:retry | model | 单模型结果 | 不改答题顺序 |
| bank:unlock | password | unlocked/lockedUntil/remainingAttempts | 主进程哈希校验 |
| bank:list | BankQuery | 分页题库 | 服务端查询 |
| bank:delete | ids | 逐条结果与回读 | 二次确认在渲染层，回读在主进程 |
| system:metrics | 事件 | CPU、内存、软件内存、浏览器数、压力 | 真实采样 |

所有新增 IPC 失败必须返回稳定错误码和可展示原因，禁止固定成功结果。密码、账号、Key、Cookie、token、二维码不得写日志。

不是受控 API。只允许按页面结构文档操作 DOM。禁止直接 POST 交卷绕过 xcConfirm。assignment-preview.aspx 与 assignment/preview.aspx 禁止混用。
