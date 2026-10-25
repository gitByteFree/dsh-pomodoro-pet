# 🍅 番茄精灵（Pomodoro Pet）

DSH Web 的专注小搭档：一个番茄钟、一套四象限任务，和一只跟着你专注一起长大的桌宠。

![番茄精灵专注面板](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/focus-panel.png)

**版本 0.9.3** · 需要 DSH Web `0.2.1-rc.2` 及以上 · 零 npm 依赖 · 数据只存本机

[English](README.md) | **中文**

## 一句话说清

点开 DSH 侧边栏的 🍅，开始一轮专注。专注结束，桌宠涨经验、数据进统计；任务用四象限排好优先级，Agent 也能帮你开钟、记任务——但改任务前一定会先问你。

装好之后你会看到：

- 侧边栏多一个 🍅 **番茄精灵** 入口
- 聊天页右下角多一只桌宠胶囊，抬头就能看到剩余时间
- 专注、统计、设置三个标签页，主题和语言自动跟随 DSH

## 功能

### ⏱ 专注计时

- 三种节奏：**标准 25 分钟 / 深度 50 分钟 / 冲刺 15 分钟**
- 单轮时长也可以自定义，5–120 分钟随意调
- 开始、暂停、继续、停止；专注结束自动进入短休，几轮后进入长休
- DSH 重启后按截止时间恢复当前轮次，漏掉的结算会补上
- 提示音 + 桌面通知，页面切到后台也能收到提醒

| 模式 | 默认时长 | 适合 |
| --- | --- | --- |
| 标准 | 25 分钟 | 日常任务、例行工作 |
| 深度 | 50 分钟 | 写代码、写文档这类需要沉浸的事 |
| 冲刺 | 15 分钟 | 进入状态，或处理零碎事项 |

### ✅ 四象限任务

- 任务按 **A 紧急重要 / B 重要不紧急 / C 紧急不重要 / D 其他** 分类
- 给任务预估番茄数，开钟时直接绑定任务，经验按所属象限结算
- 支持拖拽换象限、完成 / 重新打开、按象限筛选
- 可以建分组，把同一类任务收在一起

### 🐣 会成长的桌宠

- 每完成一轮专注获得经验，**青芽 → 红果 → 发光果 → 彩虹王** 一路进化
- 心情会随专注、休息、放弃和升级变化；可以喂食、打招呼
- 18 个成就，达成后奖励装扮碎片；10 个碎片换一件装扮，共 4 件
- 桌宠大小可调、位置可拖；收起后就是一枚小胶囊

![桌宠胶囊](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/pet-capsule.png)

*忙碌时把桌宠收进聊天页右下角的胶囊：倒计时、暂停、停止都在手边。*

### 📊 看得见的专注数据

- 近半年 / 全年专注热力图，每天专注了多久一眼可见
- 每周专注时长、时段分布（上午 / 下午 / 晚上 / 深夜）、象限分布
- 按会话与工作区归属，能看出时间花在了哪个项目上
- 周报 / 月报、竖版 / 横版分享卡片（PNG）、JSON 备份
- Agent 动态：DSH 是否运行、今天用了多少工具、跑了多少步

### 🤖 和 Agent 一起专注

插件给 Agent 提供了一个 `pomodoro_pet` 工具：

- 让 Agent 开始 / 暂停 / 停止番茄钟，或查询当前专注状态
- 读取最近统计、列出任务
- 让 Agent **提议**新建或修改任务——只有你在界面上确认后才会真正写入
- 结合当前会话、任务和可用技能，生成一份只读的专注计划

在 DSH 对话里直接说就行：

- “开始一轮 25 分钟专注”
- “帮我看看今天的专注统计”
- “把「写周报」加进 B 象限，预估 2 个番茄”

### 🔒 数据只在你自己的机器上

- 不上传、无遥测、不发起远程请求
- 会话名、工作区路径、任务标题只在本机展示，任务标题默认隐藏
- Agent 上下文不会进入导出文件
- 数据保存在 `$DSH_HOME/storages/pomodoro_pet.json`，拷走这个文件就能迁移

## 安装

安装前需要：**DSH Web**（`0.2.1-rc.2` 及以上），以及一个支持 `localStorage` 的现代浏览器。插件本身零 npm 依赖，不需要构建。

### 方式一：从 npm 安装（最快）

插件已发布到 npm，包名 `dsh-pomodoro-pet`。

在 DSH 里打开 **插件 → 已安装 → 添加插件**，输入 `dsh-pomodoro-pet`，点 **安装**。或在终端执行：

```bash
dsh plugin add dsh-pomodoro-pet
```

然后重启 `dsh web` 并刷新浏览器。这条路径不受插件市场索引缓存影响。

### 方式二：从插件市场安装

1. 打开 DSH 的 **插件** 页，启用实验性的 **自定义插件索引**，进入 **发现（Discover）**
2. 点 **添加索引源**，粘贴：

   ```text
   https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/market/index.json
   ```

3. 找到 **番茄精灵 / Pomodoro Pet**，点击安装
4. 重启 `dsh web`，然后刷新浏览器

> 索引走 jsDelivr 分发（插件市场要求直接返回 `200` 且不重定向）。新版本发布后可能有最多 12 小时的缓存，稍等即可。网络可直连 GitHub 时，也可以用 `https://raw.githubusercontent.com/gitByteFree/dsh-pomodoro-pet/main/market/index.json`。

### 方式三：一键脚本

```bash
tar -xzf dsh-pomodoro-pet-0.9.3.tar.gz
cd dsh-pomodoro-pet
./install.sh                # 默认装到 ~/dsh-plugins，profile 为 web
```

脚本会自动完成「拷贝目录 → 注册到 profile → 建软链 → 注入 patch」，重复执行也安全。装完重启 DSH：

```bash
# 在运行 dsh web 的终端按 Ctrl+C，再重新启动
dsh web
```

需要自定义位置或 profile：

```bash
./install.sh --dest ~/my-plugins --profile web
./install.sh --home /path/to/.dsh --profile web
```

### 方式四：手动安装

<details>
<summary>展开手动步骤（适合想弄清每一步在做什么的人）</summary>

1. 把插件目录放到固定位置，例如 `~/dsh-plugins/dsh-pomodoro-pet`
2. 编辑 `~/.dsh/profiles/web/package.json`：
   - `dependencies` 增加 `"dsh-pomodoro-pet": "link:/home/<你的用户名>/dsh-plugins/dsh-pomodoro-pet"`
   - `dsh.profile.bundles` 末尾增加 `"dsh-pomodoro-pet"`
3. 建立软链：

   ```bash
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -sfn ~/dsh-plugins/dsh-pomodoro-pet ~/.dsh/profiles/web/node_modules/dsh-pomodoro-pet
   ```

4. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: pomodoro-pet
         name: 'dsh-pomodoro-pet'
         config: {}
   ```

5. 重启 `dsh web`，刷新浏览器

更详细的逐步说明见 [INSTALL.md](https://github.com/gitByteFree/dsh-pomodoro-pet/blob/main/INSTALL.md)。

</details>

### 验证装好了没

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state
```

返回 `200` 说明 Host 端加载成功。`3080` 是 `dsh web` 的默认端口；如果你用 `--port` 启动过（例如 `8080`），换成实际端口。

界面上应该看到：

- 侧边栏出现 🍅 **番茄精灵**
- 右下角出现可拖动的桌宠胶囊
- 设置 → 关于显示版本 `0.9.3`

## 使用速览

### 快捷键

面板打开时可用：

| 按键 | 作用 |
| --- | --- |
| `Space` | 开始 / 暂停 / 继续 |
| `S` | 停止当前一轮（休息中则跳过休息） |
| `1` / `2` / `3` | 切换 标准 / 深度 / 冲刺 |
| `?` | 打开或关闭快捷键说明 |
| `Esc` | 关闭弹窗 / 退出输入框 |

> 快捷键只在番茄精灵面板打开时生效；光标在输入框或弹窗里时只响应 `Esc`。停止一轮专注算放弃：没有经验、心情 −1、连续轮次清零；停止休息没有惩罚。

### 三个标签页

- **专注**：计时器、当前任务、今日进度、桌宠状态、任务分布
- **统计**：热力图、趋势、时段 / 象限分布、报告、分享卡片
- **设置**：时长、提醒、桌宠大小、统计时区、数据导出

![偏好设置](https://cdn.jsdelivr.net/gh/gitByteFree/dsh-pomodoro-pet@main/png/settings.png)

*设置页：番茄钟、声音与提醒、外观、Agent 联动、桌宠、统计、数据，一页调完。*

## 常见问题

<details>
<summary>展开排查清单</summary>

- **侧边栏没有图标 / 面板空白**：先看 `dsh web` 启动日志里有没有 `pomodoro-pet` 报错；再确认 `cordis.patch.yml` 缩进正确、bundle 已加入 `dsh.profile.bundles`
- **`/dsh-pomodoro/state` 返回 404**：Host 端没加载。检查软链、bundle 列表，并确认重启过 `dsh web`
- **`Cannot find module 'dsh-pomodoro-pet'`**：软链或 `link:` 路径不对，检查 `~/.dsh/profiles/web/node_modules/`
- **改了 `client.js` 不生效**：客户端 bundle 有缓存，强制刷新；Host 端文件改动必须重启 `dsh web`
- **收不到桌面通知**：需要在浏览器里授权通知，后台标签页还受浏览器策略限制
- **主题 / 语言不跟随**：跟随 DSH 的「设置 → 通用 → 外观 / 语言」，改完重启 DSH

</details>

## 数据与卸载

- 数据文件：`$DSH_HOME/storages/pomodoro_pet.json`
- 迁移：关掉 DSH，把该文件拷到新机器同一路径，再启动即可
- 卸载：从 `~/.dsh/profiles/web/package.json` 移除 `dsh-pomodoro-pet`，删掉 `cordis.patch.yml` 里对应的 4 行，删除 `node_modules` 软链，重启 `dsh web`
- 卸载不会删除数据；要清空就删除上面的 JSON 文件

## 开发者

- 插件零构建：`client.js` 是可直接提供给浏览器加载的 bundle
- Agent 工具参数、HTTP API、文件结构与存储表：见 [DEVELOPMENT.md](https://github.com/gitByteFree/dsh-pomodoro-pet/blob/main/DEVELOPMENT.md)
- 跑单元测试：

  ```bash
  node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
  # 107 个测试全部通过
  ```

## 许可证

MIT © 2026 chris，详见 [LICENSE](LICENSE)。
