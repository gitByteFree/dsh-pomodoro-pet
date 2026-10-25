# 番茄精灵（Pomodoro Pet）

DeepSeek Harness Web 的专注伙伴：番茄钟、四象限任务、随专注成长的桌宠，以及一个把会话、工作区与技能串成专注计划的 Agent 工具。

[English](README.md) | **中文**

- 版本：**0.9.1**
- 运行环境：DSH Web（`0.2.1-rc.2` 及以上，本版本在 `0.2.1-rc.2` 上开发与验证）
- 依赖：**零 npm 依赖** —— Host 侧为纯 ESM，Client 侧为注入式 React UI
- 数据仅存本机：不上传、无遥测、不发起远程请求

## 功能

- **番茄钟。** 标准 / 深度 / 冲刺三种模式，5–120 分钟自定义时长，暂停 / 继续 / 停止，自动短休与长休，DSH 重启后按截止时间恢复，并有周期对账扫描补偿漏触发的结算。
- **四象限任务。** 任务带象限（A 紧急重要、B 重要不紧急、C 紧急不重要、D 其他）、可选分组、预估番茄数与 active / done / archived 状态。可跨象限拖动，也可直接对任务开钟。
- **提议闭环。** Agent 只能「提议」创建或修改任务；提议进入队列，用户确认前不会写入任何数据。
- **会成长的桌宠。** 完成专注获得经验值，等级解锁四个进化阶段；心情随专注、休息、放弃和升级变化；18 个成就产出装扮碎片，碎片可兑换装扮。
- **有意义的统计。** 近半年 / 全年专注热力图、每周专注时长、时段分布、象限分布、按会话与工作区归属、累计数据、目标完成率与连续天数。
- **报告与导出。** 周报 / 月报、竖版与横版分享卡片（PNG），以及任务、统计、成就的 JSON 备份。
- **Agent 联动。** `pomodoro_pet` 工具支持开始 / 暂停 / 继续 / 停止、查询状态与统计、列出任务、提议修改任务、对已有任务开钟、列出工作区技能、生成只读专注计划，以及汇总当日 Agent 活动。
- **本地隐私。** 会话名、工作区路径、工具活动与任务标题只在本机展示；任务标题默认隐藏，Agent 上下文不进入导出文件。

## 环境要求

- DSH Web profile，Host 侧需提供 `storageDomain`、`webServer`、`tools`、`timer`，Client 侧需提供 `slots`、`locale`；官方 `web` profile 已全部具备。
- 支持 `localStorage` 的现代浏览器。桌面通知与提示音需要浏览器授权，localhost 视为安全上下文。
- 使用插件不需要 Node.js 构建；Node.js 仅用于运行 `install.sh` 与单元测试。

## 安装

更详细的中文步骤见 [INSTALL.md](INSTALL.md)。

### 一键脚本

```bash
tar -xzf dsh-pomodoro-pet-0.9.1.tar.gz
cd dsh-pomodoro-pet
./install.sh                      # 默认安装到 ~/dsh-plugins，profile 为 web
# ./install.sh --dest ~/my-plugins --profile web
# ./install.sh --home /path/to/.dsh --profile web
```

脚本会拷贝插件、写入 profile 的 `dependencies` 与 `dsh.profile.bundles`、建立 `@local` 软链，并向 `cordis.patch.yml` 追加插件行。重复执行是安全的。完成后重启 `dsh web`；Host 侧代码只在启动时加载。

### 手动安装

1. 把本目录放到固定位置，例如 `~/dsh-plugins/dsh-pomodoro-pet`。
2. 在 `~/.dsh/profiles/web/package.json` 中加入依赖与 bundle：

   ```json
   {
     "dependencies": {
       "@local/dsh-pomodoro-pet": "link:/home/<你的用户名>/dsh-plugins/dsh-pomodoro-pet"
     },
     "dsh": {
       "profile": {
         "bundles": ["...原有 bundle...", "@local/dsh-pomodoro-pet"]
       }
     }
   }
   ```

3. 建立软链：

   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules/@local
   ln -sfn ~/dsh-plugins/dsh-pomodoro-pet ~/.dsh/profiles/web/node_modules/@local/dsh-pomodoro-pet
   ```

4. 向 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: pomodoro-pet
         name: '@local/dsh-pomodoro-pet'
         config: {}
   ```

5. 重启 `dsh web` 并打开 Web UI。下文示例使用 DSH 默认端口 `3080`；如果你用 `--port` 指定过端口（例如 `8080`），请换成实际端口。

### 从插件市场索引安装

DSH 本身不内置索引源。本仓库发布一个 format-1 索引：

```text
https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/market/index.json
```

1. 打开 **插件** 页，启用实验性的 **自定义插件索引** bundle，进入 **发现（Discover）** 标签。
2. 选择 **添加索引源**，粘贴上面的 URL。
3. 选中 Pomodoro Pet 并安装列表中的版本。DSH 会按索引记录的 commit 固定安装这个 Git 仓库。

市场要求索引直接返回 `200` 且不重定向，因此索引通过 jsDelivr 分发；网络可直连 GitHub 时，`https://raw.githubusercontent.com/gitByteFree/dsh-pomodoro-pet/main/market/index.json` 提供同一份文件。两个地址都跟随 `main` 分支；jsDelivr 在边缘节点缓存 12 小时，浏览器端缓存更久，因此新版本可能需要一段时间才会出现。每个列出的版本都固定到不可变的 commit。

由于本包是本地私有包，索引条目使用 Git 源，不发布到 npm。

### 验证

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/context
```

`3080` 是 `dsh web` 的默认端口；若启动时用了 `--port`（例如 `8080`），请替换成实际端口。两条请求都应返回 `200`。界面侧：侧边栏出现番茄图标，设置 → 关于显示版本 `0.9.1`，右下角出现可拖动的桌宠胶囊。

## 使用

### 面板与快捷键

侧边栏入口打开三个标签：**专注**、**统计**、**设置**。面板是普通的 DSH Client bundle，主题跟随 DSH（设置 → 通用 → 外观），语言跟随 DSH 语言设置。

| 按键 | 作用 |
| --- | --- |
| `Space` | 开始 / 暂停 / 继续当前一轮 |
| `S` | 停止当前一轮（休息中则跳过休息） |
| `1` / `2` / `3` | 空闲或待开始时切换 标准 / 深度 / 冲刺 |
| `?` 或 `Shift` + `/` | 打开或关闭快捷键说明 |
| `Esc` | 关闭弹窗，或退出输入框 |
| 收纳状态下的桌宠按 `Enter` / `Esc` | 展开 / 收起桌宠 |

快捷键仅在面板挂载时生效。焦点位于输入框、文本域、下拉框、可编辑元素或弹窗内时，只响应 `Esc`。

停止一轮专注视为放弃：不获得经验、心情 −1、连续轮次清零。停止休息或等待中的轮次则直接跳过，没有惩罚。

### 专注模式

| 模式 | 默认时长 | 经验倍率 |
| --- | --- | --- |
| 标准 | 25 分钟 | 1.0 |
| 深度 | 50 分钟 | 1.2 |
| 冲刺 | 15 分钟 | 0.8 |

自定义时长范围为 5–120 分钟，会覆盖默认值。轮次按配置的短休 / 长休节奏推进，每完成 `roundsPerLong` 轮进入一次长休。

### 任务

- 象限：A 紧急重要、B 重要不紧急、C 紧急不重要、D 其他。
- 任务字段：标题、象限、可选分组、预估番茄数、已完成番茄数、状态（`active`、`done`、`archived`）。
- 支持按象限过滤、跨象限拖动、完成 / 重新打开，以及对 `active` 任务开钟。
- Agent 创建或修改的任务先进入 **待确认提议** 区，确认后才落库，拒绝则丢弃。
- 对任务开钟时，本轮经验按任务所属象限计算，并在会话记录中保存任务标题快照。

### 桌宠成长

| 等级 | 阶段 |
| --- | --- |
| 1 | 青芽 |
| 3 | 红果 |
| 5 | 发光果 |
| 7 | 彩虹王 |

- 单次专注经验：`round(象限基数 × 模式倍率 × 专注分钟 / 25)`，最少 1。象限基数为 A 10、B 12、C 8、D 5；未绑定任务按 10 计算。
- 完成休息获得 2 经验；新的连续打卡获得 5 点额外经验。
- 从等级 `L` 升到下一级需要 `30 + 20 × L` 经验。
- 心情范围 0–5，初始为 3。放弃一轮专注降低 1，升级提升 1。
- 喂食提升 1 点心情，受 `dailyFeedLimit`（默认 3）限制；打招呼不改变心情。两者都不会增加经验。
- 18 个成就覆盖普通到传说稀有度，奖励 0–10 个装扮碎片；10 个碎片可兑换一件装扮，共 4 件。

### 统计与报告

- 近半年或全年专注热力图，悬停查看单日专注时长。
- 每周专注时长柱状图、时段分布（上午 / 下午 / 晚上 / 深夜）、象限分布。
- 汇总：专注总时长、累计番茄、最长连续、目标完成率。
- 按会话与工作区归属，并列出当前会话可用的工作区技能。
- Agent 动态：DSH 是否运行、最近使用的工具、今日工具与步数。
- 周报 / 月报、竖版 / 横版分享卡片（PNG）、JSON 备份。

### 设置

- 番茄钟：专注时长、短休、长休、长休间隔、每日目标。
- 声音与提醒：提示音、音量、桌面通知、动画效果。
- 外观：完全跟随 DSH，无独立主题开关。
- 桌宠：大小（0.5–2.0×）与位置归位。
- 本地数据来源：桌宠工具气泡与状态点、最近会话与工作区、会话 / 工具事件（仅展示）。
- 统计时区：跨日归属按此时区计算，修改不追溯历史。
- 导出 JSON、操作审计（最多 1000 条）与版本信息。

## Agent 工具：`pomodoro_pet`

Host 注册一个原始工具定义，其描述与参数面向模型；所有调用与 UI 操作走同一条串行命令链。

| Action | 参数 | 作用 |
| --- | --- | --- |
| `start` | `focusMinutes`、`taskId`、`mode` | 开始一轮专注；已有进行中的轮次时返回 `busy`。 |
| `pause` / `resume` / `stop` | — | 暂停 / 继续 / 停止当前轮次；休息中停止等于跳过休息。 |
| `status` | — | 当前轮次、宠物阶段 / 等级 / 心情、今日完成数。 |
| `stats` | `days`（1–90，默认 7） | 最近数日与象限分布。 |
| `pet` | `petAction`：`feed` 或 `greet` | 仅影响心情；喂食有每日上限，不增加经验。 |
| `task_list` | `quadrant`、`status` | 只读任务列表。 |
| `task_create` | `title`、`quadrant`、`estimatedPomodoros`、`groupId` | 写入创建提议；用户确认前不落库。 |
| `task_start` | `taskId`、`focusMinutes` | 对已有 `active` 任务开始一轮专注。 |
| `task_update` | `taskId`、`patch`、`title`、`estimatedPomodoros`、`groupId` | 写入修改提议。 |
| `skill_list` | — | 列出工作区技能（60 秒缓存）。 |
| `focus_plan` | `goal`、`minutes` | 结合当前会话、任务与匹配技能生成只读专注计划。 |
| `agent_summary` | `days`（1–90，默认 7） | 当日 Agent 活动与专注协作摘要。 |

约束：

- Agent 不能修改经验值、已完成番茄数或历史记录。
- 任务变更只能以提议形式写入，必须由 UI 确认。
- 每次工具调用都会写入审计日志（`auditEnabled` 开启时），最多保留 1000 条 / 90 天。
- `focus_plan` 与 `skill_list` 不写入任何数据。

## HTTP API

所有路由注册在 `ctx.webServer` 上，位于 DSH 连接信任围栏之后，供 Web UI 会话访问。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/dsh-pomodoro/events` | Server-Sent Events：快照与 Agent 上下文推送 |
| `GET` | `/dsh-pomodoro/state` | 完整快照 |
| `POST` | `/dsh-pomodoro/action` | `start`、`pause`、`resume`、`stop`、`setTask`、`setMode`、`redeemOutfit` |
| `GET` / `POST` | `/dsh-pomodoro/settings` | 读取或修改设置 |
| `GET` | `/dsh-pomodoro/history` | 最近数日 |
| `GET` / `POST` / `PATCH` / `DELETE` | `/dsh-pomodoro/tasks` 与 `/tasks/:id` | 任务 CRUD |
| `GET` / `POST` / `PATCH` / `DELETE` | `/dsh-pomodoro/groups` 与 `/groups/:id` | 分组 CRUD |
| `GET` | `/dsh-pomodoro/heatmap`、`/trend`、`/quadrants`、`/hours` | 聚合数据 |
| `GET` | `/dsh-pomodoro/report?period=week\|month` | 周报或月报 |
| `GET` | `/dsh-pomodoro/achievements` | 成就目录与库存 |
| `GET` | `/dsh-pomodoro/audit` | 审计日志 |
| `GET` / `POST` | `/dsh-pomodoro/proposals` | 列出、确认或拒绝提议 |
| `GET` | `/dsh-pomodoro/context` | 会话、工作区、技能与 Agent 活动 |
| `GET` | `/dsh-pomodoro/days`、`/sessions` | 每日与会话聚合 |

## 数据与存储

- Domain storage：`storageDomain: pomodoro_pet`，默认单文件布局下持久化到 `$DSH_HOME/storages/pomodoro_pet.json`。
- 数据表：`pets`、`sessions`、`days`、`settings`、`tasks`、`groups`、`achievements`、`inventory`、`proposals`、`audit_log`。
- 迁移：停止 DSH，把 `pomodoro_pet.json` 拷贝到新机器的同一路径，再启动 DSH。宠物等级、任务、统计与成就会一并恢复。
- 设备级偏好存在浏览器 `localStorage`，不随数据文件迁移：`pp-pet-pos`、`pp-pet-collapsed`、`pp-show-agent`、`pp-show-context`、`pp-seen-settlement`。

## 开发

插件没有构建步骤。`client.js` 是可直接提供的浏览器 bundle，英文词典已内联；`i18n-en.mjs` 是供修改的词典源文件，`locale/*.json` 提供侧边栏与页面元数据。

```text
index.js              Host 半：路由、工具、定时器效果、存储
pet-engine.js         纯状态机：专注轮次、经验、心情、任务
stats-engine.js       热力图、趋势、象限 / 时段分布、报告
achievement-engine.js 18 个成就定义与判定
agent-bridge.js       把 DSH 会话 / Agent / 工具活动折叠为上下文
client.js             Client 半：完整 React UI
i18n-en.mjs           英文词典源文件
locale/*.json         本地化插件元数据
install.sh            幂等安装脚本
*.test.mjs            引擎与桥接单元测试
```

运行测试：

```bash
node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
```

预期：107 个测试全部通过。修改 `client.js` 后刷新浏览器即可（客户端 bundle 有缓存时强制刷新）；修改任何 Host 文件都必须重启 `dsh web`。

## 常见问题

- **侧边栏没有图标或面板空白。** 先看 `dsh web` 日志里是否有 `pomodoro-pet` 报错，再确认 `cordis.patch.yml` 缩进正确、bundle 已加入 `dsh.profile.bundles`。
- **`/dsh-pomodoro/state` 返回 404。** Host 半未加载。检查 bundle 列表、`@local` 软链，以及是否重启过 DSH。
- **`Cannot find module '@local/dsh-pomodoro-pet'`。** 软链或 `link:` 路径不正确，检查 `~/.dsh/profiles/web/node_modules/@local/`。
- **改了 `client.js` 不生效。** 客户端 bundle 有缓存，强制刷新；Host 侧修改必须重启。
- **快捷键没反应。** 仅在面板挂载且焦点不在输入框或弹窗内时生效。
- **主题不跟随 DSH。** 插件读取 DSH 主题；修改「设置 → 通用 → 外观」后重启 DSH。
- **收不到桌面通知。** 需要在浏览器中授权；后台标签页的通知还受浏览器策略限制。

## 卸载

1. 从 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 与 `dependencies` 中移除 `@local/dsh-pomodoro-pet`。
2. 删除 `cordis.patch.yml` 中的 `pomodoro-pet` 行。
3. 删除软链：`rm ~/.dsh/profiles/web/node_modules/@local/dsh-pomodoro-pet`。
4. 重启 `dsh web`。

数据不会自动删除；需要清空时删除 `$DSH_HOME/storages/pomodoro_pet.json`。

## 许可证

MIT © 2026 chris，详见 [LICENSE](LICENSE)。
