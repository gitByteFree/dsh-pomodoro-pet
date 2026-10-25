# 番茄精灵（Pomodoro Pet）· DSH 插件安装说明

一个 DSH（Web GUI / Desktop 桌面端）的番茄钟 + 桌面宠物插件：侧边栏面板（专注 / 统计 / 设置）、
可拖动桌宠、成就与装扮、四象限任务、以及跟 DSH 会话 / Agent / 技能联动的功能。

- 版本：**0.10.0**
- 运行环境：**DSH Web 或 DSH Desktop**，`0.2.1-rc.2` 及以上
- 依赖：**零 npm 依赖**（纯 ESM + 浏览器原生 React 注入），只需 DSH 本体
- 语言：中文 / English（跟随 DSH「设置 → 通用 → 语言」）
- 主题：跟随 DSH「设置 → 通用 → 外观」（浅色 / 深色 / 跟随系统）

> Web 与桌面端是两个独立 profile：Web 用 `~/.dsh/profiles/web`，桌面端独占 `~/.dsh/profiles/desktop`。
> 在一边安装不会同步到另一边；两边的专注数据（`$DSH_HOME/storages/pomodoro_pet/`）是同一份。

---

## 零、最快路径

### 路径 A：Web 端从 npm 安装（无需下载压缩包）

插件已发布到 npm，包名 `dsh-pomodoro-pet`。

在 DSH 里打开 **插件 → 已安装 → 添加插件**，输入 `dsh-pomodoro-pet`，点 **安装**；或直接：

```bash
dsh plugin add dsh-pomodoro-pet
```

然后重启 `dsh web` 即可。

### 路径 B：桌面端（DSH Desktop）从插件页安装

打开桌面端左侧 **Plugins → Add plugin**，输入 `dsh-pomodoro-pet` → **Install** → **Enable now**。
正常情况热生效，不用重启；若提示需要重启，完全退出桌面端再打开。

> 桌面端不能用 npm 安装的 `dsh` 改自己的 profile。命令行方式（可选）：
> 先在桌面端菜单 **Manage dsh Command… → Install**，然后**完全退出桌面端**，执行
> `dsh plugin --profile desktop add dsh-pomodoro-pet`，再打开桌面端。

### 路径 C：Web 端本地压缩包 + 一键脚本

解压后进入目录，直接跑安装脚本（只用于 Web profile）：

```bash
tar -xzf dsh-pomodoro-pet-0.10.0.tar.gz
cd dsh-pomodoro-pet
./install.sh                 # 默认装到 ~/dsh-plugins，profile = web
# 或指定：./install.sh --dest ~/my-plugins --profile web
```

脚本会自动完成「拷目录 → 改 profile package.json → 建软链」，
插件自带的 `cordis.patch.yml` 由 DSH 自动应用，脚本不再改 profile patch。
**跑完只需重启 `dsh web`**。重复运行是安全的（不会产生重复条目）；脚本会拒绝 `desktop` profile（桌面端请走路径 B）。

如果你想手动装、或想弄清每一步在做什么，看下面的详细步骤。

---

## 一、目录内容

```
dsh-pomodoro-pet/
├── package.json          # 插件清单（name/version/exports/dsh 字段）
├── cordis.patch.yml      # 插件自身的 bundle patch（插入一行 pomodoro-pet）
├── index.js              # Host 半：路由 / Tool / 定时器 / 存储
├── pet-engine.js         # 状态机（番茄钟 / EXP / 心情 / 成就）
├── stats-engine.js       # 统计聚合（热力图 / 趋势 / 象限 / 时段）
├── achievement-engine.js # 18 个成就定义与判定
├── agent-bridge.js       # DSH 会话 / Agent / 工具事件桥
├── client.js             # Client 半：全部 UI（React，零构建，词典已内联）
├── i18n-en.mjs           # 英文词典可读副本（由 client.js 生成，仅开发用）
├── scripts/
│   └── sync-i18n.mjs     # 重新生成 i18n-en.mjs（`node scripts/sync-i18n.mjs`）
├── locale/
│   ├── zh.json           # 侧边栏 / 页面标题的中文元数据
│   └── en.json           # 同上（英文）
├── icon.svg              # 侧边栏图标
├── install.sh            # 一键安装脚本（本机 Bash）
├── INSTALL.md            # 本文件
└── *.test.mjs            # 引擎与桥接单元测试（可选，安装不需要）
```

> `i18n-en.mjs`、`scripts/` 与 `*.test.mjs` **不是运行时依赖**，可以不拷。保留它们只是为了以后改词条/跑测试。

---

## 二、安装前确认

在目标机器上先确认：

```bash
dsh --version          # 需要能正常运行 DSH（本插件在 0.2.1-rc.2 上开发）
echo $DSH_HOME         # 默认 ~/.dsh；下文以 ~/.dsh 为例
ls ~/.dsh/profiles/    # Web 端应有 web；桌面端首次启动后会生成 desktop
```

本插件需要 profile 已挂载这些内置服务（DSH Web 与 Desktop 的默认 profile 都有）：

`storageDomain` · `webServer` · `tools` · `timer`（Host）+ `slots` · `locale`（Client）

> 桌面端首次启动会自动创建 `~/.dsh/profiles/desktop`；这个 profile 由 Electron 独占，CLI 不能启动它，
> 只有桌面端自带的 `dsh` 命令或应用内插件页能管理它的插件。

---

## 三、安装步骤

> 桌面端只需做 **3.0**；Web 端做 **1–3、5**（第 4 步只是说明：profile patch 行已不再需要）。

### 3.0 桌面端（DSH Desktop）

1. 打开桌面端（首次启动会自动创建 `~/.dsh/profiles/desktop`）。
2. 左侧 **Plugins → Add plugin**，输入 `dsh-pomodoro-pet`，点 **Install**。
3. 安装完成后点 **Enable now**；正常情况立即生效（HMR），不用重启。
4. 若提示需要重启，完全退出桌面端再打开。
5. 命令行方式：桌面端菜单 **Manage dsh Command… → Install**，完全退出桌面端后执行
   `dsh plugin --profile desktop add dsh-pomodoro-pet`，再打开桌面端。

> 桌面端不要执行 `install.sh`，也不要改 `profiles/web`——那是另一套 profile。

### 1. 放置插件目录

选一个固定位置，例如：

```bash
mkdir -p ~/dsh-plugins
cp -r dsh-pomodoro-pet ~/dsh-plugins/
```

### 2. 注册到 profile

编辑 `~/.dsh/profiles/web/package.json`，在 `dependencies` 加一行（**路径换成你自己的**）：

```json
{
  "dependencies": {
    "dsh-pomodoro-pet": "link:/home/<你的用户名>/dsh-plugins/dsh-pomodoro-pet"
  }
}
```

再把它加进同一个文件的 `dsh.profile.bundles` 数组（顺序不敏感，放在末尾即可）：

```json
"dsh": {
  "profile": {
    "bundles": [
      ... 原有的 bundle ...,
      "dsh-pomodoro-pet"
    ]
  }
}
```

### 3. 建立软链并安装

```bash
cd ~/.dsh/profiles/web
mkdir -p node_modules
ln -sfn ~/dsh-plugins/dsh-pomodoro-pet node_modules/dsh-pomodoro-pet
npm install --no-audit --no-fund     # 或 pnpm install / yarn install
```

> `npm install` 会按 `link:` 重新建立软链；若没有 pnpm/npm 网络也不要紧，
> 手工 `ln -sfn` 那一步已经够用。

### 4. profile patch 行（已不再需要）

DSH `0.2.1-rc.2` 起会自动应用插件自带的 `dsh.bundle.patch`（即本仓库的 `cordis.patch.yml`），
所以**不需要**再手动往 `~/.dsh/profiles/web/cordis.patch.yml` 插入 `pomodoro-pet` 行。

> 旧版教程里加过的那 4 行可以删掉。重复的 row id 会被 Loader 按最后一条去重，留着也不会崩，但属于冗余配置。

### 5. 重启 DSH

Host 端代码（`index.js` 等）**必须重启**才能加载：

```bash
# 在跑 dsh web 的终端 Ctrl+C，然后重新启动
dsh web
```

浏览器刷新 `http://127.0.0.1:3080` 即可看到侧边栏出现 🍅「番茄精灵」。

> `3080` 是 `dsh web` 的默认端口。如果你的 `dsh web` 用 `--port` 指定过端口（例如 `8080`），下面验证命令里的端口也要一并替换。

---

## 四、验证是否装好

**Web**：

```bash
# 1) Host 路由存活（应返回 200 + JSON）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state

# 2) v0.8 新增的上下文接口（应返回 200）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/context

# 3) 直接看内容
curl -s http://127.0.0.1:3080/dsh-pomodoro/context | head -c 400
```

**Desktop**：桌面端 Host 端口由系统分配，且请求需要应用注入的 Cookie；直接 `curl` 会得到 `401`，
这是插件的信任围栏在正常工作，不代表没装好。直接在界面里确认即可。

GUI 侧应能看到（Web / Desktop 相同）：
- 侧边栏出现 🍅 图标，点开是「专注时间」页
- 右下角出现可拖动的桌宠胶囊
- 设置页最下方「版本」显示 `0.10.0`

### 可选：跑单元测试

```bash
cd ~/dsh-plugins/dsh-pomodoro-pet
node --test
# 期望：tests 129 / pass 129 / fail 0
```

---

## 五、数据与存储

- 数据落在 DSH 的 domain storage：`storageDomain: pomodoro_pet`
  （本机实测为 `$DSH_HOME/storages/pomodoro_pet/` 目录）
- 表：`pets` `sessions` `days` `settings` `tasks` `groups` `achievements` `inventory` `proposals` `audit_log`
- **Web 与桌面端共用这份数据**（数据按 `$DSH_HOME` 共享，profile 只隔离插件与依赖）。
  但请不要同时开着 `dsh web` 和桌面端写同一份数据，避免写入竞争。
- **迁移**：把老机器的 `~/.dsh/storages/pomodoro_pet/` 目录（0.9.5+）拷到新机器同一路径即可；若老机器是 0.9.4 及更早，拷 `pomodoro_pet.json` 单文件，首次启动会自动迁移。
  建议拷贝前先关掉 DSH，避免写入竞争。
- 设备级偏好（存在浏览器 `localStorage`，不随数据文件走，且**按页面 origin 隔离**）：
  - `pp-pet-pos` 桌宠位置、`pp-pet-collapsed` 收纳状态
  - `pp-wait-alert` Agent 等待闪烁横幅、`pp-wait-notify` Agent 等待桌面通知
  - `pp-show-agent` / `pp-show-context` Agent 联动开关
  - `pp-seen-settlement` 结算弹窗去重
  - Web 的 origin 是 `http://127.0.0.1:<port>`，桌面端是 `dsh-app://app`——从 Web 换到桌面端时，
    桌宠会回到默认位置、结算弹窗可能再弹一次，属于预期行为。

---

## 六、常见问题

**侧边栏没有图标 / 面板空白**
先看 DSH 启动日志有没有 `pomodoro-pet` 相关报错；再确认 `package.json` 的 `dsh.profile.bundles` 是否包含 `dsh-pomodoro-pet`。
自 0.2.1-rc.2 起插件自带的 `cordis.patch.yml` 会自动生效，**不需要**手写 `insert` 行。

**桌面端插件列表里看不到 / 面板空白**
Web 和桌面端是两个独立 profile，需要在桌面端 **Plugins → Add plugin** 再装一次；
确认安装后点了 **Enable now**，或之后在 **Installed** 里启用。

**`/dsh-pomodoro/state` 返回 404（仅 Web）**
Host 半没加载。检查：`package.json` 的 `bundles` 是否包含 `dsh-pomodoro-pet`；软链是否指向真实目录；是否重启过 `dsh web`。
桌面端没有固定端口且需要应用注入的 Cookie，`curl` 返回 `401` 属正常，请改用界面确认。

**`Cannot find module 'dsh-pomodoro-pet'`**
软链或 `link:` 路径不对。用 `ls -l ~/.dsh/profiles/web/node_modules/` 确认指向存在。

**改了 `client.js` 不生效**
Client 半刷新页面即可；但 DSH 有客户端 bundle 缓存，必要时强制刷新（Ctrl+Shift+R）。
改了 `index.js` / `*-engine.js` 必须重启（Web 重启 `dsh web`；桌面端完全退出再打开）。

**收不到桌面通知**
Web 需在浏览器里授权通知，后台标签页还受浏览器策略限制。
桌面端权限是自动授予的，能否弹系统通知取决于 macOS 签名、Windows AUMID 或 Linux 通知服务，开发版可能静默（有提示音兜底）。

**桌面端关掉窗口后计时还在走吗**
在走。桌面端关窗只是隐藏，Host 继续运行并按截止时间结算；真正退出桌面端会丢本轮提醒，下次启动会补结算。

**快捷键没反应**
面板快捷键（Space / S / 1·2·3 / ?）只在番茄精灵面板挂载时生效；输入框内只响应 `Esc`。
如果焦点在别的 DSH 页面，先点回番茄精灵面板。

**主题不跟随**
v0.9.1 起完全跟随 DSH：改「设置 → 通用 → 外观」即可，插件内没有独立主题开关。
若没跟随，说明 `body[data-ds-dark-theme]` 没变化——重启一次 DSH。

---

## 七、卸载

**Web**：

```bash
# 1) 从 bundles 数组移除 "dsh-pomodoro-pet"
# 2) 删除依赖 / 软链（如果用 link: 安装）
rm ~/.dsh/profiles/web/node_modules/dsh-pomodoro-pet
# 3) 重启 dsh web
```

也可以在 DSH 的插件页直接卸载，不用手改文件。
旧版教程里额外加的 `cordis.patch.yml` 行已不再需要，顺手删掉即可。

**Desktop**：
- 应用内 **Plugins → Installed** 里卸载；或
- 完全退出桌面端后执行 `dsh plugin --profile desktop remove dsh-pomodoro-pet`，再打开桌面端。

数据不会被自动删除；如需清空再删 `$DSH_HOME/storages/pomodoro_pet/` 目录（旧版备份 `pomodoro_pet.json` 可一并删除）。

---

## 八、Agent Tool（可选了解）

插件向 Agent 暴露一个工具 `pomodoro_pet`，可用 action：

`start` `pause` `resume` `stop` `status` `stats` `pet`
`task_list` `task_create` `task_start` `task_update`
`skill_list` `focus_plan` `agent_summary`

其中 `task_create` / `task_update` 只入「提议队列」，必须由用户在 UI 确认后才落库。
