你自行判断本任务是否需要多智能体协作；如需开启，只允许一个主智能体统筹，任一时刻最多同时运行五个子代理，子代理完成后必须及时回收，回收后可按需启用新的子代理，禁止子代理继续派生代理。

请直接开始执行下面步骤。先读取当前项目规则、Stitch 原始产物、UI 接入文档和真实前端实现，再动手优化；不要先解释，不要只给方案，不要停在需求复述。

本次任务不是开发新功能，而是对当前已有真实前端 UI 壳进行“实例级视觉规格保真的一比一还原优化”。

目标：
1. 严格根据 Stitch 原始产物修正真实前端 UI。
2. 重点修正图标、按钮、输入控件、表格、文本和操作区的尺寸、间距、比例及排版流。
3. 不接真实接口，不补业务逻辑，不进入 /goal，不声明业务完成。

一、先自动定位文件

请先从当前项目中查找并读取：
1. 项目规则文件，如 AGENTS.md。
2. Stitch 下载的 HTML、CSS、代码、图片、截图和 MD 规范。
3. 当前 UI 壳接入清单或类似设计/映射文档。
4. 对应的真实前端页面、组件、局部样式、mock、type 和入口文件。
5. 可能影响目标 UI 的全局样式、reset、主题变量和公共组件默认样式。

不得要求我提前提供固定文件名。请根据项目实际结构自行定位。

如果找不到 Stitch HTML、目标前端文件或无法确定 Screen 与真实页面的对应关系，停止修改，只输出缺失资料和已检查路径，不得凭感觉重画。

二、视觉事实来源优先级

必须严格按照：
1. Stitch 原始 HTML。
2. Stitch 代码、CSS、样式和 MD 规范。
3. Stitch 截图。

能从 HTML 确认的结构、class、尺寸、间距和层级不得靠截图猜。截图只用于补充校对。HTML 中的实例级规格属于硬依据，不得擅自合并或重解释。

三、修改前先做控件规格盘点

先盘点并记录：
1. 按钮变体及各自高度、padding、gap、圆角、字体和图标尺寸。
2. 图标尺寸层级和纯图标按钮占位。
3. input、textarea、select、搜索框等输入控件规格。
4. 表头、行高、单元格 padding、操作列、筛选栏和分页规格。
5. badge、pill、tag、tab、dropdown trigger、进度条等规格。
6. header、footer、toolbar、card action、table action 的布局和占位关系。
7. 高密度控件区和容易因尺寸错误导致排版塌陷的区域。

不存在的元素标记“不适用”，不得虚构。

四、一比一还原硬规则

1. 禁止只模仿大概风格、重新设计或自由发挥。
2. 禁止把不同按钮合并成统一按钮规格。
3. 禁止把不同图标合并成统一图标尺寸。
4. 禁止把不同输入控件强制统一高度。
5. 禁止把不同表格元素改成另一套通用规格。
6. 禁止先抽象成通用组件，再凭感觉回调视觉。
7. 禁止抹掉 Stitch 实例级 class、size、spacing 和排版差异。
8. 禁止默认沿用项目现有 Button、Input、Icon、Table 的规格。
9. 必须防止全局 button、input、svg、table、reset、主题变量和公共类名覆盖目标样式。
10. 复用现有组件时，必须覆写到最终视觉结果与 Stitch 一致。
11. 技术栈无法原样表达时，先记录原因，再采用视觉结果等价方案。
12. 例外只能是实现路径例外，不能是视觉结果例外。

五、必须保真的实例级属性

重点对照并保留：
- width、height、min/max width、min/max height
- padding、margin、gap
- border、border-width、border-radius
- 图标 width、height 和容器占位
- font-size、font-weight、line-height、letter-spacing
- 单行、多行、不换行、截断和溢出行为
- flex/grid 方向、wrap、对齐和轨道比例
- 表格行高、列宽、单元格 padding、操作列布局
- header、footer、toolbar、card、table、panel 内的实际占位比例
- hover、focus、active、disabled、selected、expanded 等状态下的尺寸稳定性
- 响应式断点和内容增减时的布局稳定性

六、允许修改范围

只允许：
1. 修改目标 UI 壳直接相关的真实前端文件。
2. 修改目标组件的局部样式。
3. 做必要的实例级样式覆盖。
4. 补充少量 Stitch 规格保真注释。
5. 必要时更新 UI 壳接入清单中的控件规格、文件映射和待接线说明。

修改前先列出本轮文件白名单。不要修改白名单之外的文件。

七、明确禁止

- 不接真实接口
- 不补业务逻辑
- 不改后端、数据库、权限、认证、支付或删除逻辑
- 不新增无关依赖
- 不做无关重构
- 不大规模修改公共组件库或全局主题
- 不把静态 UI 壳说成业务完成
- 不进入后续开发目标或真机验收收口

八、验证要求

完成后使用当前项目可行的预览方式验证：
1. 对照 Stitch HTML 和截图检查整体结构。
2. 逐项检查图标、按钮、输入控件、表格和文本规格。
3. 检查是否仍有通用组件抹平实例差异。
4. 检查是否仍受全局样式或老项目默认规格影响。
5. 检查默认态及可验证的交互状态。
6. 检查目标断点和内容增减时的排版稳定性。
7. 运行相关语法检查、lint、typecheck、构建或项目最小验证。
8. 查看最终 diff，确认没有修改无关文件和业务逻辑。

九、完成后输出

1. 实际读取的 Stitch 来源文件。
2. 控件规格盘点结果。
3. 实际修改的文件及逐文件改动。
4. 修正的图标、按钮、输入框、表格、文本和操作区问题。
5. 哪些问题来自实例级规格被通用化抹平。
6. 哪些问题来自项目默认组件或全局样式干扰。
7. 哪些元素不适用。
8. 是否已达到 Stitch 原始产物的一比一还原。
9. 尚未处理且应留到后续开发目标的业务接线事项。
10. 执行的验证命令、预览检查和结果。

收口条件：
- 高风险 UI 元素已按 Stitch 原始产物完成实例级规格保真。
- 不再存在错误的统一按钮、统一图标、统一输入框或统一表格规格。
- 不再存在明显的公共组件默认值或全局样式干扰。
- UI 壳可以作为后续开发目标接业务前的合格视觉基线。
- 本轮仍只代表 UI 壳视觉承接完成，不代表业务完成。

十、完整视觉维度复修

本轮不得被理解为“主要修控件大小”。控件规格是完整视觉保真的一个维度，不能遮蔽页面结构、布局、尺寸与间距、字体排版、颜色与视觉样式、图片资源、层级、状态和响应式。修改前必须将下列九个维度逐项盘点，修改后必须逐项复核。

1. **页面结构与布局**：核对页面区块顺序、主容器尺寸、最大/最小宽高、左右栏与上下区块占比、grid 轨道数量和比例、flex 方向、固定/流式/绝对定位、header/sidebar/content/footer 占位，以及弹窗、抽屉、面板和浮层的位置、尺寸、对齐基线、内容密度与区块关系。内容增减时仍要保持 Stitch 的布局规律。
2. **尺寸与间距**：除已有实例级属性外，还要核对 row-gap、column-gap、section spacing、页面边缘留白、卡片内部留白和元素间相对距离。不得将不同层级的间距统一成一个 token，也不得让控件尺寸变化带动整块排版流偏移。
3. **字体与文本排版**：核对 font-family、font-size、font-weight、line-height、letter-spacing、text-align、文字颜色、大小写、数字/英文展示、标题/正文/辅助文字/标签的层级，以及 white-space、word-break、overflow-wrap、text-overflow、ellipsis、单行/多行/固定行数/截断/溢出行为。检查文字是否被挤成竖排，是否与图标基线对齐。字体字号、字重、行高、字距和换行行为属于一比一还原的硬依据，不得被项目默认 Typography、全局字体或公共文本组件改写。
4. **颜色和视觉样式**：以 Stitch HTML、CSS、代码和资源实际值核对主色、辅助色、点缀色、中性色、背景色、文本色、边框色、图标色、状态色、opacity、gradient、border 宽度/样式、圆角、阴影、backdrop-filter、blur、outline、分隔线和明暗关系；禁止只判断“颜色差不多”。
5. **控件规格**：继续执行上文的按钮、图标、输入控件、表格、标签、进度和操作区盘点，并补充 checkbox、radio、switch 的实例级规格。但不得因为这些元素容易出问题，就跳过其他八个视觉维度。
6. **图片和视觉资源**：核对图片、背景图、头像、插图、图标和字体资源的来源、尺寸、比例、清晰度、透明度、object-fit、object-position、裁切和背景定位。已能从 Stitch 原始产物取得的资源，禁止换成相似图、临时占位图或重画资源。
7. **层级与组合关系**：核对 z-index、stacking context、遮罩层、弹窗/抽屉与背景关系、卡片与背景关系、图标与文字组合、控件与容器比例、操作区与内容区权重，确保浮层位置正确且没有错误覆盖或遮挡。
8. **状态表现**：除已列 hover/focus/active/disabled/selected/expanded 外，还要核对 default、checked、collapsed、loading、empty、error、success、modal/drawer open/close、panel/screen/tab switch 和内容增减。状态变化时检查尺寸、字体、行高、边框、图标占位、文本换行和容器是否发生不符合 Stitch 的位移或抖动。
9. **响应式与不同视口**：核对 Stitch 目标画布、项目实际断点、桌面/平板/移动端、最小支持宽度、宽屏、高度不足、滚动方式、横向溢出、换行、栅格切换、面板收缩、工具栏换行、文本截断和浮层尺寸。原产物只定义某一视口时，先忠于该事实，再按项目实际目标视口做稳定的等价承接，不得自行重设计。

十一、项目微调与完整性门禁

运行时必须将项目名称、模块/UI 壳名称、Stitch Project/Screen 信息与下载路径、真实前端文件、接入清单、技术栈、UI 库、局部样式机制、查看入口、文件白名单、目标视口/断点、全局样式干扰源和验证命令填入本提示词。微调只允许填充或替换项目事实、增加项目专属限制/文件/验证，以及对不存在的元素标记：`不适用：当前 Stitch 原始产物中不存在该元素。`

即使某元素不存在，也不得删除对应规则、列表项或章节。禁止删除、缩短、摘要、改写或合并任何固定正文；禁止改变事实来源优先级、降低一比一强度、删除盘点、验证、输出或收口条件。实例级复修提示词也必须保持 3000–10000 个字符，不得重复凑字，不得用“详见模板”替代正文。交付时只在代码块外说一句复修原因，完整提示词放在一个独立 Markdown 代码块中。

项目事实：
项目名称：开大自动答题桌面端
项目路径：/Users/liran/Documents/codex 相关项目/开大自动答题
Stitch Project Title：OpenEdu Auto Desktop（MCP 实际 Title：上海开大自动答题）
Stitch Project ID：4741787672985224870
Stitch Screen Name：PC-P01-home 主界面 (动态微交互版)
Stitch Screen ID：092c05d88efd490d9d0edea686463143
Stitch Screen Name：PC-P02-settings 设置 (动态微交互版)
Stitch Screen ID：109626339c614b1eb65c9656b766504b
Stitch Screen Name：PC-P03-bank-import 题库导入 (动态微交互版)
Stitch Screen ID：4ffb416003994f77bc888dddf58d717a
Stitch Screen Name：PC-P04-students 学生账号 (微动效交互版)
Stitch Screen ID：5fd62582fdaf45e1a246bdce3e24c446
Stitch Screen 映射：PC-P01-home→src/views/HomeView.vue；PC-P02-settings→src/views/SettingsView.vue；PC-P03-bank-import→src/views/BankImportView.vue；PC-P04-students→src/views/AccountsView.vue；Design System stub asset-stub-assets_678075bdcf70475d920a10adeb3afebd 不计页
下载路径：liran_docs/ui-shells/stitch-download/
HTML 样式来源文件：liran_docs/ui-shells/stitch-download/PC-P01-home.html、PC-P02-settings.html、PC-P03-bank-import.html、PC-P04-students.html；同目录 PNG 仅补充校对
源码路径：src/views/HomeView.vue、src/views/SettingsView.vue、src/views/BankImportView.vue、src/views/AccountsView.vue、src/App.vue、src/styles/stitch.css、src/styles/app.css、src/mock/demo.ts、src/main.ts、index.html、electron/main.ts
真实入口：仓库根 npm run dev 打开开发态 Electron 窗；渲染进程入口 index.html + src/main.ts；不是独立 prototype.html
视口：Stitch 桌面约 1440×900；Electron minWidth 1200 minHeight 760；移动端 0 页，不另出 Screen
主题：HTML 主色 indigo #4F46E5，背景 #F5F3FF/#F8FAFC，字体 Plus Jakarta Sans + Geist + JetBrains Mono + Material Symbols Outlined；禁止改回提案湖绿 #0E9F78
启动命令：npm run dev
构建命令：npx vue-tsc --noEmit && npx vite build
测试命令：不适用：当前 Stitch 原始产物中不存在该元素。
验证命令：git diff --check -- .；npx vue-tsc --noEmit；npx vite build；仓库搜索真实 Key/学号/xhtoken/sb_secret
允许编辑文件：src/views/HomeView.vue、src/views/SettingsView.vue、src/views/BankImportView.vue、src/views/AccountsView.vue、src/styles/stitch.css、src/styles/app.css、src/App.vue、src/mock/demo.ts、index.html、electron/main.ts、liran_docs/10-UI壳接入清单.md、liran_docs/ui-shells 四份清单、liran_docs/04-开发追踪.md、liran_docs/03-索引.md、liran_docs/ui-shells/T001-Stitch实例级细节复修提示词.md
项目专属限制：初次接收检查结论为可以进入实例级细节复修。无头/可视化只在学生卡右上角，禁止进顶栏。主按钮文案必须是「登录并刷新课程」。必须始终看见题库答题 x / AI 答题 y。提取题库在工作台学生卡，不是第五页。顶栏四字：工作台、题库、学生账号、设置。禁止真实 API、Playwright 登录作答提交。禁止密钥、学号样本、xhtoken、sb_secret 入源码。预留锚点 TODO(ui-shell)/TODO(codex-connect)/TODO(codex-state)/TODO(codex-permission)。各页自带 header，不要抽成统一顶栏组件。设置页「已保存最新配置」Stitch 默认可见，禁止默认 opacity-0。课程并行 HTML value=1，产品默认 2，保持 2 并记下，不要改回 1。Toast/Popover 可用 Vue :class，默认视觉必须等价 Stitch 隐藏态。根多一层 Vue 包装 div 是实现路径例外。密码显隐/复制只做壳外观。假数据只用张同学/李同学、0000****0001。不调用 Design QA，不创建 design-qa.md。不宣布整体完成，不进入正式归档。
