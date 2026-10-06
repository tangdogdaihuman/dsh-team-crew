# @local/dsh-team-crew — Team Crew Tools

给 DSH 的 Agent Teams 补两个缺的功能，装完重启一次 DSH 生效：

- **`set_teammate_model`** — 给现役队友热切换 provider/model（可选带 `reasoning_effort` 挡位），**她的记忆、身份、上下文全部保留**，下一轮请求就用新模型。
- **`retire_teammate`** — 软删除（退役）：她从 `list_agents` 名册消失，`send_message` / `interrupt_agent` / 任务 `reassign` 一律明确拒绝；`action: "restore"` 可以把同一个她请回来（同一个会话、同一份记忆）。

两个工具只注册在 **Team Lead** 的作用域里，队友自己看不到，也不会误伤别人。

## v1.1.0：人类自助入口（不用先喊 Lead）

- **「队友」按钮 + 换脑台面板**（挂在会话标题栏动作区，紧挨官方队友面板）：每人一行显示 `provider/模型 · 挡位` 与 冷/排队中/已退役 标记；三个联动下拉（provider → 模型 → 挡位，选项来自真实 catalog，挡位跟随所选模型）+「应用」；另有退役/恢复。当前会话没有队友时它根本不出现（读共享 store 的 `agentTeam` 投影，零请求）。
- **`/crew` 人类命令**（输入框直接敲）：`list ｜ providers ｜ models <provider> ｜ set <队友> <provider/模型> [挡位] ｜ retire <队友> [原因] ｜ restore <队友> ｜ help`。

两个入口都不另写逻辑：动作一律发成一条 `/crew` 命令，落到与 `set_teammate_model` / `retire_teammate` **同一份实现、同一份账本**上，所以名册、面板、工具三方永远看到同一个事实。

## v1.1.2：修复「装了 1.1.1 两个模型工具消失」

**症状**：插件条目 active、账本加载、退役隐藏都正常，但 `set_teammate_model` / `retire_teammate` 从工具清单里消失。
**根因**：宿主的 Agent 作用域注入了 `tools` 但**没有** `commands`；Cordis 上下文代理读未注入的服务属性是**抛错**（`cannot get property "commands" without inject`）而不是返回 undefined——v1.1.1 在 install() 里用可选链 `scoped.commands?.register` 探测，防不住"读取本身就抛"，异常把 install() 整体回滚，两个 P0 工具被连坐带走。
**修复**：`/crew` 改为在 apply() 的**全局层注册一次**（与官方 `/goal` 命令同构），`inject` 声明加 `'commands'`；install() 内不再触碰 `scoped.commands`。全局命令是安全的：`crewCommand` 每个子命令都先经 `snapshot()/setModel()/retire()` 校验调用者是 Lead，非 Lead 会话只会收到明确报错。

## v1.1.3：修复「面板渲染了但全是空的、按钮点不动」

**症状**：面板能挂出来（挂载路径 OK），但每人一行全是 `现在: ?`、下拉只有"—"、没有任何报错、按钮全灰/点了没反应。
**根因**：`ctx.remote.commands.execute()` 的返回是网关信封 `RemoteResult`——`{ok:true, value}` / `{ok:false, error}`，`value` 才是 `{commandId, result}` 的 `CommandExecution`（官方作曲家的解码顺序：ok → value → result，见 dsh-client-ui-commands 的 execute()）。v1.1.2 的 `unwrap()` 直接在信封上找 `.result`，找不到就静默落进 `{ok:true, note:""}` 兜底分支——`/crew list` 的真数据被丢掉，面板渲染成空壳还不报错。
**修复**：`unwrap()` 按官方顺序拆信封：信封失败 → 抛出（带 code/message）；`value === undefined`（命令未被受理，未知名/坏语法）→ 抛出；再取 `.result`。client probe 的假 execute 改为真网关语义，新增 3 条故障分支断言（信封失败/未受理/handler 错误必须显示在面板上，绝不静默），并改为测工作区源码。**29/29 PASS**。

## v1.1.4：液态玻璃自适应 + 按钮可见性

- **「应用」按钮只在选了新路线后出现**——此前它是"常驻但禁用"，在玻璃主题下渲染成一块无字灰疙瘩，看起来像坏了一样。退役行也只显示「恢复」。
- **壁纸引擎液态玻璃适配**：检测到 `dsh-plugin-wallpaper-engine` 激活（`body[data-we-wallpaper]`）时，面板自动套用**与作曲家/弹层同一张玻璃配方**——复用它的共享令牌（`--we-glass-alpha/--we-blur/--we-saturate/--we-surface-tint-rgb-*`），浅色原样、深色 ×0.4、可读性下限 `--we-readability-floor` 保 4.5:1 对比度、无 `backdrop-filter` 支持时回退近不透明底板。壁纸引擎不装或没开时这些变量不解析，自动回落到原生主题令牌，**两个插件互不依赖**。client probe 33/33 PASS（含 4 条玻璃断言）。

## v1.1.5：修复下拉选项列表刺眼的亮灰色

`<select>` 弹出的选项列表是**浏览器原生 UI**，不吃面板的玻璃样式；不显式声明 `color-scheme` 时 Chromium 在深色主题下也按浅色画，出现一块刺眼的亮灰（现场反馈截图）。修复：按应用主题钉 `color-scheme`（浅/深），并给 `option` 显式表面色+文字色；深色玻璃主题下选项列表用玻璃 tint 而非生硬的主题色。client probe 35/35（+2 条断言）。

## v1.1.6：自绘下拉（v1.1.5 的方案在本宿主无效）+ 应用按钮对比度

现场复测证明 v1.1.5 **在这台宿主上无效**：`<select>` 的弹出列表是 OS 级原生 chrome，连 `option` 的显式配色都完全无视。改为**面板内置自绘下拉**（`.tc-dd-btn` + `.tc-list`）：选项列表与面板同一张玻璃配方，样式 100% 可控。同时修掉：

- **「应用」按钮白底白字**（用户看到的"无字白块"）：玻璃主题下 `--dsw-alias-brand-primary` 与文字色近乎同色。现改用 `--dsw-alias-label-primary` 前景 + inset 描边环，任何令牌配对都可读。
- **挡位显示"（默认）"但实际是 max**：目录里没有 `max` 选项时原生 select 无法表示当前值。自绘下拉始终显示真实当前值；当前值不在目录时以斜体灰显示，目录内当前项带「（当前）」标记——你点开就能看清她真正的挡位。
- 探针升级到 39/39（自绘下拉结构、玻璃列表、当前值显示、应用按钮对比度）。

## v1.1.7：修复自绘下拉「点了选不中」+ 选中项白块 + 选项又小又灰

v1.1.6 现场反馈三个问题，根因全在自绘下拉自身：

- **点击选项完全无效**：选项是不可聚焦的 `<span>`，按下鼠标时浏览器默认动作把焦点从按钮上移走，外层 `onBlur` 抢在 click 之前把列表整个拆掉——点击落在已删除的节点上，选择永远不发生。修复：选取改在 `onMouseDown` 里做并 `preventDefault()`（焦点根本不离开按钮，竞速不存在了），`onBlur` 只在焦点真正移出下拉组时才关列表（relatedTarget 包含判断，与宿主 Menu 原语同款）；同时去掉 `<label>` 包裹（它会隐式转发点击，加剧开关抖动）。
- **列表里当前选中项是一块白色**：选中样式用的还是「brand 填充 + base 文字」这对令牌——玻璃主题下两者都近白，白底白字（与应用按钮 v1.1.6 修掉的问题同源，当时漏了选项）。改为半透明 brand tint（20%）+ 安全的主文字色 + 细描边 + `✓` 前缀，任何主题配对都可读。
- **选项文字又小又灰**：`.tc-field span` 后代选择器优先级 (0,1,1) 压过 `.tc-opt` 的 (0,1,0)，把所有选项拖成 11px 次要灰。说明文字改用独立 `.tc-cap` 类，选项显式 12px 主文字色。

另修一个探针 exposing 时发现的隐患：先点挡位再应用时草稿会丢 provider/model（`setDraft` 现在从成员当前路线完整播种）。探针升级到 46/46（mousedown 时序、relatedTarget 失焦、无 label、选中配色、优先级修复各有断言）。

## v1.1.8：应用按钮第三次白块的真根因 + 下拉列表改不透明阅读面

v1.1.7 复测仍有两个问题：

- **「应用」按钮仍是无字白块**（用户问"退役上面那个白色方块是啥"——那就是应用按钮）。真根因这次挖到底：这个宿主主题里 `--dsw-alias-brand-primary` **本身渲染近白**，所以"brand 填充 + 改文字色"修两轮都无效（v1.1.6 加描边、v1.1.7 玻璃覆盖里的 text-shadow 反而把文字又盖回近白）。v1.1.8 改**反色按钮**：主文字色做底、底色做字（label 与 bg 按定义互为反色，任何主题都不可能白上白），并删掉玻璃主题里所有对按钮的覆盖规则。
- **provider 选项挤成一团**：下拉列表沿用的半透明玻璃配方让身后的白色按钮和输入框整个渗过来，provider 名字糊成一片。列表是**阅读面不是展示面**——改为不透明 overlay 底、去掉毛玻璃模糊（玻璃感保留在面板卡片本体上），行距加大。

探针同步升级：断言"任何规则不得用 brand-primary 做填充/对比"、应用按钮反色、列表不透明；并清掉一条 v1.1.6 起混进来的永真式断言（`test(...)===false ? 弱检查 : true` 恒真，是它两轮放过了白块）。46/46 PASS。

## v1.1.9：应用按钮整行白条的布局根因

用户复测仍见"白色方框"：`.tc-row` 是 flex 列容器，应用按钮作为裸子元素被 `align-self:stretch` 拉成**整行宽的色块**——不管什么配色，整行浅色块看起来都像个怪白条。修复：按钮包进 `.tc-line`（flex 行）恢复自然宽度、右对齐。另确认：用户截图显示的是 v1.1.7 旧前端（列表半透明、密集），v1.1.8 未随重启生效，需重启后核验。46/46 PASS。

## 实现要点（为什么不碰内核）

- **模型**：队友出生时模型从 Lead 的 live 配置复制一次就固化在 `subagent/descriptor` 里；冷恢复也只按 descriptor 重建。本插件不改 journal、不改 descriptor，而是在**平台自己的模型选择接缝**上做事：`installModelSelection()`（`@deepseek-ai/dsh-agent`，就是 GUI 切模型用的同一套监听 `system-prompt/assemble` / `agent/request` / `agent/pre-step`）+ 往队友**自己**的会话日志追加已有的 log-only 事件 `model/selection`。所以效果与 GUI 手切一致：新挡位/新模型只在她下一轮请求的边界生效，上下文里多一条 `[model changed]` 提示，历史一个字都不动。
- **正在跑的回合不被打断**：她 `running` 时切换只入队（`state: "pending"`），`agent/status` 变 `idle`（回合间隙）或她下次被激活时自动生效。想让切换立刻生效就传 `deferModelSwitchWhileRunning: false`（`cordis.patch.yml` 里改）。
- **退役**：插件自己的旁挂账本（`ctx.storageDomain` 的 `team_crew` 域，落盘 `~/.dsh/storages/team_crew.json`），拦在模型可见的工具面上——`ctx.tools.guard()` 做单调拒绝，`tools/post-execute` 改写 `list_agents` 的结果（隐藏退役行、把 `model` 字段改成生效路线）。Team 的 journal 与 immutable 校验一行没动。

## 已知限制

1. 浏览器右侧的队友名册面板读的是 Lead 会话的 `agentTeam` 投影（由 journal 推导），插件不重写 journal，所以**退役成员在 GUI 面板里可能仍然显示**；模型侧的 `list_agents` 与所有投递路径都已拦截。
2. `maxTokens` 不切：平台的模型选择契约只携带 provider/model/reasoningEffort，输出预算属于单次激活，descriptor 也刻意不存它。
3. 名字回收（spec F3）未做：`spawn_teammate` 的同名检查读的是不可变 journal 状态，绕过它要么改 journal，要么制造重名尸体，两者都违反红线。要重新上岗请用 `action: "restore"`，或者换个新名字。
4. 账本不可用时（storage 域打不开）插件会**明确报错并降级**：工具照样能用，但每次结果里都会带 `WARNING`，重启后状态丢。

## 怎么装（本机踩过的坑，别再来一次）

**必须以 tarball 副本安装，不能让 pnpm 用 `link:` 装这个目录**：

```powershell
cd C:\Users\admin\Desktop\qqbot\team-crew-bundle
npm pack                                   # → local-dsh-team-crew-<version>.tgz
# 然后把那个 .tgz 交给插件管理器安装（plugin_manager install_bundle 传 tgz 绝对路径），再重启 DSH
```

原因：`link:` 安装会在 profile 的 `node_modules` 里留一个指向本目录的 junction，宿主的 Node 按**真实路径**解析裸依赖 —— 而 `C:\Users\admin\Desktop\qqbot` 往上没有任何 `node_modules`，于是
`Cannot find package '@deepseek-ai/dsh-agent'` → 插件条目 `fiberPhase: null`，两个工具根本不出现。装成副本后包落在 `profiles\desktop\node_modules\@local\dsh-team-crew\`，往上就是 profile 的 `node_modules`，依赖才能解析。

另一个坑：对 `link:` 装的 bundle 执行卸载，会**顺着 junction 删掉这个源码目录**（Windows junction 的 rm 陷阱，本机 2026-10-06 真踩了，源码是从已安装副本 `Copy-Item` 回来的）。装成副本后没这个问题，卸载只删拷贝，源码目录安全。

## 卸载 / 回滚

```powershell
# 1) 插件管理器卸载 @local/dsh-team-crew（Settings → 插件，或 plugin_manager remove_bundle），然后重启 DSH
# 2) 账本数据（可选删除）
Remove-Item "C:\Users\admin\.dsh\storages\team_crew.json" -ErrorAction SilentlyContinue
```

删掉包 + 重启即回到原状：插件没写过任何 journal、没改过会话日志、没动过 profile 的 `cordis.patch.yml` 手工段（选择记录只在 `package.json` 的 `dsh.profile.bundles` 里，卸载会自己摘掉）。
