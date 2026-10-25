# 番茄精灵（Pomodoro Pet）· DSH 插件安装说明

一个 DSH Web GUI 的番茄钟 + 桌面宠物插件：侧边栏面板（专注 / 统计 / 设置）、
可拖动桌宠、成就与装扮、四象限任务、以及跟 DSH 会话 / Agent / 技能联动的功能。

- 版本：**0.9.1**
- 依赖：**零 npm 依赖**（纯 ESM + 浏览器原生 React 注入），只需 DSH 本体
- 语言：中文 / English（跟随 DSH「设置 → 通用 → 语言」）
- 主题：跟随 DSH「设置 → 通用 → 外观」（浅色 / 深色 / 跟随系统）

---

## 零、最快路径（推荐）

解压后进入目录，直接跑安装脚本：

```bash
tar -xzf dsh-pomodoro-pet-0.9.1.tar.gz
cd dsh-pomodoro-pet
./install.sh                 # 默认装到 ~/dsh-plugins，profile = web
# 或指定：./install.sh --dest ~/my-plugins --profile web
```

脚本会自动完成「拷目录 → 改 profile package.json → 建软链 → 插 patch」，
**跑完只需重启 `dsh web`**。重复运行是安全的（不会产生重复条目）。

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
├── i18n-en.mjs           # 英文词典**源文件**（仅开发用；client.js 已内联副本）
├── locale/
│   ├── zh.json           # 侧边栏 / 页面标题的中文元数据
│   └── en.json           # 同上（英文）
├── icon.svg              # 侧边栏图标
├── install.sh            # 一键安装脚本（本机 Bash）
├── INSTALL.md            # 本文件
└── *.test.mjs            # 引擎与桥接单元测试（可选，安装不需要）
```

> `i18n-en.mjs` 与 `*.test.mjs` **不是运行时依赖**，可以不拷。保留它们只是为了以后改词条/跑测试。

---

## 二、安装前确认

在目标机器上先确认：

```bash
dsh --version          # 需要能正常运行 DSH（本插件在 0.2.1-rc.2 上开发）
echo $DSH_HOME         # 默认 ~/.dsh；下文以 ~/.dsh 为例
ls ~/.dsh/profiles/    # 应有 web 之类已存在的 profile
```

本插件需要 profile 已挂载这些内置服务（DSH Web 默认都有）：

`storageDomain` · `webServer` · `tools` · `timer`（Host）+ `slots` · `locale`（Client）

---

## 三、安装步骤

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

### 4. 在 profile patch 里插入插件行

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**追加**：

```yaml
- insert:
    - id: pomodoro-pet
      name: 'dsh-pomodoro-pet'
      config: {}
```

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

```bash
# 1) Host 路由存活（应返回 200 + JSON）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/state

# 2) v0.8 新增的上下文接口（应返回 200）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3080/dsh-pomodoro/context

# 3) 直接看内容
curl -s http://127.0.0.1:3080/dsh-pomodoro/context | head -c 400
```

GUI 侧应能看到：
- 侧边栏出现 🍅 图标，点开是「专注时间」页
- 右下角出现可拖动的桌宠胶囊
- 设置页最下方「版本」显示 `0.9.1`

### 可选：跑单元测试

```bash
cd ~/dsh-plugins/dsh-pomodoro-pet
node --test engine.test.mjs v03-engine.test.mjs v04-engine.test.mjs agent-bridge.test.mjs
# 期望：tests 107 / pass 107 / fail 0
```

---

## 五、数据与存储

- 数据落在 DSH 的 domain storage：`storageDomain: pomodoro_pet`
  （本机实测为 `$DSH_HOME/storages/pomodoro_pet.json`）
- 表：`pets` `sessions` `days` `settings` `tasks` `groups` `achievements` `inventory` `proposals` `audit_log`
- **迁移**：把老机器的 `~/.dsh/storages/pomodoro_pet.json` 拷到新机器同一路径即可继承全部数据（宠物等级、任务、统计、成就）。
  建议拷贝前先关掉 DSH，避免写入竞争。
- 设备级偏好（存在浏览器 `localStorage`，不随数据文件走）：
  - `pp-pet-pos` 桌宠位置、`pp-pet-collapsed` 收纳状态
  - `pp-show-agent` / `pp-show-context` Agent 联动开关
  - `pp-seen-settlement` 结算弹窗去重

---

## 六、常见问题

**侧边栏没有图标 / 面板空白**
先看 DSH 启动日志有没有 `pomodoro-pet` 相关报错；再确认 `cordis.patch.yml` 里那 4 行 YAML 缩进正确（`- insert:` 顶格，下面缩进两级）。

**`/dsh-pomodoro/state` 返回 404**
Host 半没加载。检查：`package.json` 的 `bundles` 是否包含 `dsh-pomodoro-pet`；软链是否指向真实目录；是否重启过 `dsh web`。

**`Cannot find module 'dsh-pomodoro-pet'`**
软链或 `link:` 路径不对。用 `ls -l ~/.dsh/profiles/web/node_modules/` 确认指向存在。

**改了 `client.js` 不生效**
Client 半刷新页面即可；但 DSH 有客户端 bundle 缓存，必要时强制刷新（Ctrl+Shift+R）。
改了 `index.js` / `*-engine.js` 必须重启 `dsh web`。

**快捷键没反应**
面板快捷键（Space / S / 1·2·3 / ?）只在番茄精灵面板挂载时生效；输入框内只响应 `Esc`。
如果焦点在别的 DSH 页面，先点回番茄精灵面板。

**主题不跟随**
v0.9.1 起完全跟随 DSH：改「设置 → 通用 → 外观」即可，插件内没有独立主题开关。
若没跟随，说明 `body[data-ds-dark-theme]` 没变化——重启一次 DSH。

---

## 七、卸载

```bash
# 1) 从 bundles 数组移除 "dsh-pomodoro-pet"
# 2) 删掉 cordis.patch.yml 里的 pomodoro-pet 那 4 行
# 3) 删软链
rm ~/.dsh/profiles/web/node_modules/dsh-pomodoro-pet
# 4) 重启 dsh web
```

数据不会被自动删除；如需清空再删 `$DSH_HOME/storages/pomodoro_pet.json`。

---

## 八、Agent Tool（可选了解）

插件向 Agent 暴露一个工具 `pomodoro_pet`，可用 action：

`start` `pause` `resume` `stop` `status` `stats` `pet`
`task_list` `task_create` `task_start` `task_update`
`skill_list` `focus_plan` `agent_summary`

其中 `task_create` / `task_update` 只入「提议队列」，必须由用户在 UI 确认后才落库。
