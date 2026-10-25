/**
 * Pomodoro Pet — Client half (plain-JS React, zero build). v0.4
 *
 * Registers:
 *  - shell.overlay: draggable desktop pet (V5 pattern)
 *  - main keyed 'pomodoro-pet' + sidebar.panellist icon (V6 pattern)
 *
 * v0.4 (DESIGN.md §13): 四 Tab 侧边栏（计时/统计/任务/设置，默认统计）、
 *  serverNow 校时（§11.2）、结算面板 + seenSettlementId 去重（§8.1）、
 *  53 列热力图（§8.2）、任务四象限 + 提议闭环（D16）、设置全量键（§13.6）。
 *
 * Client never mutates state: actions POST /dsh-pomodoro/action, state comes
 * from GET /dsh-pomodoro/state snapshots; the countdown interpolates
 * endsAt/remainingMs locally with the serverNow offset (§11.2).
 */
window.__ModuleLoader__.load({
  id: 'dsh-pomodoro-pet',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useMemo, useCallback } = React

    /* =============== v0.9 国际化（运行时翻译，零构建） ===============
     * 关键决定：**不**重写 500+ 处 JSX 文案，而是在渲染出口做翻译。
     *  - `tr('中文')`：单条文案。
     *  - `trf('中文 {n} 个', {n})`：带插值。
     *  - `localizeNode(node)`：递归遍历 React 元素树，把**纯中文文本子节点**
     *    以及常见字符串 props（title/aria-label/placeholder）翻译掉。
     *    这样即使组件里直接写 `'专注时间'`、`` `${done}/${goal} 个番茄` ``
     *    也能在英文界面下正确显示，且语言切换会随重渲染自动生效。
     * 词典 key = 中文原文；未命中时原样返回（不会退化成 key）。
     */
    const NS = 'pomodoro.pet'
    const i18nStore = { dict: null, locale: 'zh', rev: 0, listeners: new Set() }

    /** 载入词典并接上 ctx.locale（apply 里调用）。 */
    function installLocale(ctx) {
      try {
        const snap = ctx?.locale?.getSnapshot?.()
        if (snap?.active) i18nStore.locale = String(snap.active)
        // 订阅同样挂 effect：HMR 重载后旧订阅必须注销，否则每次热更都残留一个。
        const off = ctx?.locale?.subscribe?.(() => {
          const next = ctx?.locale?.getSnapshot?.()
          i18nStore.locale = String(next?.active ?? 'zh')
          i18nStore.rev += 1
          for (const fn of [...i18nStore.listeners]) fn(i18nStore.rev)
        })
        if (typeof off === 'function') ctx.effect(() => off, 'pomodoro-pet: locale subscription')
      } catch { /* locale unavailable → 中文原文 */ }
      try { i18nStore.dict = buildDict() } catch { i18nStore.dict = null }
    }

    /** 当前是否英文界面。 */
    const isEn = () => i18nStore.locale !== 'zh' && i18nStore.locale !== 'zh-CN' && i18nStore.locale !== 'zh-Hans'

    /** 翻译一条文案。
     *  策略：先精确命中词典；否则按 PATTERNS 逐条做「模式重写」——
     *  这样 `` `${done} / ${goal} 个番茄` `` 这类插值后的成品（"6 / 8 个番茄"）
     *  也能翻译，而不需要为每个数字组合建 key。 */
    function tr(text, params) {
      const raw = String(text ?? '')
      if (!raw || !isEn()) return raw
      const dict = i18nStore.dict
      const exact = dict?.text?.[raw]
      if (exact != null) {
        if (!params) return exact
        return exact.replace(/\{([\w$]+)\}/g, (m, key) => (key in params ? String(params[key]) : m))
      }
      let out = raw
      for (const [re, rep] of PATTERNS) {
        if (re.test(out)) out = out.replace(re, rep)
      }
      return out
    }
    const trf = (text, params) => tr(text, params)

    /** 语言变化时重渲染。 */
    function useLocaleRev() {
      const [, force] = React.useReducer(n => n + 1, 0)
      React.useEffect(() => {
        i18nStore.listeners.add(force)
        return () => { i18nStore.listeners.delete(force) }
      }, [])
      return i18nStore.locale
    }

    /** 只翻译「含中文的纯文本」，避免误伤代码/类名/emoji-only。 */
    const ZH_RE = /[\u4e00-\u9fa5]/
    const localizeText = (value) => {
      if (typeof value !== 'string' || !ZH_RE.test(value) || !isEn()) return value
      return tr(value)
    }
    /** 需要翻译的字符串 props。 */
    const TEXT_PROPS = new Set(['title', 'aria-label', 'placeholder', 'alt'])

    /** 递归翻译 React 元素树（只处理字符串 child 与常见文本 props）。 */
    function localizeNode(node) {
      if (!isEn() || node == null || typeof node === 'boolean') return node
      if (typeof node === 'string') return localizeText(node)
      if (typeof node === 'number' || typeof node === 'bigint') return node
      if (Array.isArray(node)) {
        let changed = false
        const next = node.map(child => {
          const out = localizeNode(child)
          if (out !== child) changed = true
          return out
        })
        return changed ? next : node
      }
      if (!React.isValidElement(node)) return node
      const { props } = node
      if (!props) return node
      let patch = null
      if (props.children != null) {
        const kids = localizeNode(props.children)
        if (kids !== props.children) patch = { ...(patch ?? {}), children: kids }
      }
      for (const key of TEXT_PROPS) {
        const value = props[key]
        if (typeof value !== 'string') continue
        const out = localizeText(value)
        if (out !== value) patch = { ...(patch ?? {}), [key]: out }
      }
      return patch ? React.cloneElement(node, patch) : node
    }

    /** 本地化 createElement：在元素创建时翻译字符串 children 与文本 props。
     *  这样做的好处是覆盖所有 `h('div', null, '文案')` 与插值模板，无需改写
     *  500+ 处 JSX；语言切换时由外层 withI18n 触发重渲染 → h() 重新执行。 */
    function h(type, props, ...children) {
      if (!isEn()) return React.createElement(type, props, ...children)
      let nextProps = props
      if (props) {
        for (const key of TEXT_PROPS) {
          const value = props[key]
          if (typeof value !== 'string') continue
          const out = localizeText(value)
          if (out !== value) nextProps = { ...(nextProps ?? {}), [key]: out }
        }
      }
      let nextChildren = children
      if (children.length) {
        let changed = false
        nextChildren = children.map(child => {
          if (typeof child === 'string') {
            const out = localizeText(child)
            if (out !== child) changed = true
            return out
          }
          if (Array.isArray(child)) {
            let arrChanged = false
            const mapped = child.map(item => {
              if (typeof item !== 'string') return item
              const out = localizeText(item)
              if (out !== item) arrChanged = true
              return out
            })
            if (arrChanged) changed = true
            return arrChanged ? mapped : child
          }
          return child
        })
        if (!changed) nextChildren = children
      }
      return React.createElement(type, nextProps, ...nextChildren)
    }

    /** 用 localizeNode 兜底（处理极少数组件直接返回字符串/数组的情况）。 */
    function withI18n(render) {
      return function I18nBound(props) {
        useLocaleRev()
        return localizeNode(render(props))
      }
    }

    /** 语言敏感的派生文案（常量里存中文 key，渲染时翻译）。 */
    const trQuad = (key) => tr((QUADRANTS.find(x => x.key === key) ?? {}).label ?? key)
    const trQuadLong = (key) => tr(QUAD_STYLE[key]?.label ?? key)
    const trMode = (key) => tr((MODES.find(m => m.key === key) ?? MODES[0]).name)
    const trMood = (mood) => tr(MOOD_TEXT[Math.max(0, Math.min(5, Number(mood) ?? 3))] ?? MOOD_TEXT[3])
    const trStage = (stage) => tr(STAGE_TEXT[stage] ?? stage)
    const trRarity = (r) => tr(RARITY_TEXT[r] ?? r)

    /* ---------------- 词典（key = 中文原文 → 英文） ---------------- */
    /** EN_TEXT: 精确命中（静态文案）。 */
    const EN_TEXT = {
      "番茄精灵": "Pomodoro Pet", "番茄钟宠物": "Pomodoro Pet", "专注 · 任务 · 成长": "Focus · Tasks · Growth",
      "番茄钟面板": "Pomodoro panel", "专注": "Focus", "统计": "Stats", "设置": "Settings", "专注时间": "Focus time",
      "专注统计": "Focus stats", "偏好设置": "Preferences", "正在连接番茄钟服务…": "Connecting to the pomodoro service…",
      "快捷键 (?": "Shortcuts (?)", "快捷键 (?)": "Shortcuts (?)", "查看快捷键": "View shortcuts", "⌨ 快捷键": "⌨ Shortcuts",
      "⌨　快捷键": "⌨　Shortcuts", "快捷键": "Shortcuts", "知道了": "Got it", "关闭弹窗": "Close dialog", "关闭": "Close",
      "取消": "Cancel", "确认": "Confirm", "拒绝": "Decline", "继续": "Continue", "收起": "Collapse", "查看": "View",
      "复制": "Copy", "已复制": "Copied", "试听": "Test", "重置位置": "Reset position", "恢复默认": "Restore defaults",
      "放弃修改": "Discard changes", "开始 / 暂停 / 继续": "Start / pause / resume",
      "停止（休息中 = 跳过休息）": "Stop (during a break = skip it)",
      "切换 标准 / 深度 / 冲刺 模式": "Switch Standard / Deep / Sprint mode", "显示 / 隐藏本面板": "Show / hide this panel",
      "桌宠：展开 / 收纳（聚焦时）": "Desktop pet: expand / collapse (when focused)", "◴　今日进度": "◴　Today’s progress",
      "继续保持 ✨": "Keep it up ✨", "已专注 ": "Focused ", "▣　今天的任务": "▣　Today’s tasks", "＋ 新建任务": "＋ New task",
      "新建任务": "New task", "🌱 新建任务": "🌱 New task", "待确认提议": "Pending proposals", "执行失败": "Action failed",
      "象限过滤": "Filter by quadrant", "全部": "All", "松开即可移入此象限": "Release to drop into this quadrant",
      "任务分布": "Task distribution", "任务名称": "Task name", "任务内容不合法": "Invalid task content",
      "优先级（象限）": "Priority (quadrant)", "预估番茄数": "Estimated pomodoros", "创建一个任务": "Create a task",
      "创建任务": "Create task", "分组": "Group", "无分组": "No group", "分组不存在": "Group not found",
      "选择一个任务（可选）": "Choose a task (optional)", "选择任务": "Choose a task", "未分类（不绑定任务）": "Uncategorized (no task)",
      "未分类": "Uncategorized", "暂无进行中任务": "No active tasks", "例如:完成设计稿": "e.g. Finish the design mockup",
      "自定义时长": "Custom length", "自定义专注时长（5–120 分钟, 回车开始）": "Custom focus length (5–120 min, Enter to start)",
      "分 · 回车开始": "min · Enter to start", "专注模式": "Focus mode",
      "计时中不可切换模式": "Can’t switch modes while the timer runs", "⚙ 快速设置": "⚙ Quick settings",
      "准备开始专注": "Ready to focus", "开始专注": "Start focus", "开始下一轮专注": "Start the next round",
      "▶　开始专注": "▶　Start focus", "▶　继续专注": "▶　Resume focus", "Ⅱ　暂停专注": "Ⅱ　Pause focus", "Ⅱ　暂停休息": "Ⅱ　Pause break",
      "暂停": "Pause", "停止": "Stop", "继续专注": "Resume focus", "收纳桌宠": "Tuck away", "正在专注…": "Focusing…",
      "休息中": "On a break", "休息中，撒欢一下": "On a break — time to play", "已暂停，休息一下也好": "Paused — a rest is fine too",
      "本轮完成，结算中…": "Round complete — settling…", "空闲,准备开始专注": "Idle — ready to focus",
      "空闲 — 开始一个番茄钟吧": "Idle — start a pomodoro", "专注中,精灵陪你打坐": "Focusing — your sprite sits with you",
      "已暂停,时间冻结": "Paused — time is frozen", "短休中,撒欢一下": "Short break — time to play",
      "长休中,好好放松": "Long break — relax properly", "休息结束,确认后开始下一轮": "Break over — confirm to start the next round",
      "休息结束,等你确认": "Break over — waiting for you", "休息结束，确认后开始下一轮": "Break over — confirm to start the next round",
      "专注时长需在 5-120 分钟之间": "Focus length must be 5–120 minutes",
      "超过允许的上限（专注 5-120 分钟）": "Over the allowed limit (focus 5–120 min)", "超出允许的上限": "Over the allowed limit",
      "已有进行中的番茄钟": "A pomodoro is already running", "当前状态不支持此操作": "That action isn’t available right now",
      "当前状态不支持此操作,已为你刷新": "That action isn’t available right now — refreshed for you",
      "本轮已结算,无需重复操作": "This round already settled", "开始失败": "Couldn’t start", "操作失败": "Action failed",
      "操作失败（": "Action failed (", "创建失败,请重试": "Couldn’t create — please retry", "创建失败（": "Couldn’t create (",
      "保存失败,请重试": "Couldn’t save — please retry", "未知": "unknown", "修改任务 ": "Update task ",
      "删除任务 ": "Delete task ", "删除任务「": "Delete task “", "完成任务 ": "Complete task ", "重新打开任务 ": "Reopen task ",
      "对「": "Start on “", "」开钟": "”", "新建任务「": "New task “", "已完成 (": "Completed (", "审计日志 (": "Audit log (",
      "本轮任务:": "This round: ", "本轮第 ": "Round ", "番茄串 ": "Pomodoros ", "🐾　桌宠状态": "🐾　Pet status", "心情 ": "Mood ",
      "心情": "Mood", "装扮 · ": "Outfit · ", "未装扮": "None", "自定义装扮": "Customize outfit",
      "自定义装扮 · ": "Customize outfit · ", "装扮碎片": "Outfit fragments", "装扮碎片 ": "Fragments ",
      "🎀　自定义装扮": "🎀　Customize outfit", "选择装扮": "Choose an outfit", "当前": "Current", "选": "Pick",
      "兑换中…": "Redeeming…", "兑换失败，请重试": "Redeem failed — please retry",
      "兑换装扮（10 碎片）": "Redeem outfit (10 fragments)", "碎片不足，10 个碎片兑 1 件装扮": "Not enough fragments — 10 per outfit",
      "已足够兑换 1 件装扮": "Enough for one outfit", "再收集 ": "Collect ", "个碎片即可兑换": " more fragments to redeem",
      "个碎片": "fragments", "还差 ": "Need ", "叶冠": "Leaf crown", "腮红贴纸": "Blush stickers", "光环吊坠": "Halo pendant",
      "王冠轮廓": "Crown outline", "头顶三片嫩叶": "Three tender leaves", "脸颊星星贴纸": "Starry cheek stickers",
      "头顶金色小光环": "A small golden halo", "金色王冠描边": "A golden crown outline", "青芽": "Sprout", "红果": "Red fruit",
      "发光果": "Glowing fruit", "彩虹王": "Rainbow king", "很低落": "Very low", "有点蔫": "Droopy", "平静": "Calm",
      "不错": "Good", "开心": "Happy", "超开心": "Overjoyed", "青芽正在努力扎根": "Your sprout is putting down roots",
      "红果越结越多了": "The red fruit keeps growing", "光环在闪,专注在涨。": "The halo is glowing — focus rising.",
      "王者风范,继续专注。": "Regal as ever — keep focusing.", "小芽正在扎根,陪你打坐。": "The sprout is rooting — sitting with you.",
      "状态不错,陪你再专注一轮。": "Feeling good — one more round together.", "陪你专注每一轮。": "Here for every round.",
      "心声": "Thought", "陪我待会儿？": "Stay with me a bit?", "要不要开始一个番茄？": "Shall we start a pomodoro?",
      "今天也一起加油": "Let’s do our best today too", "伸个懒腰，准备开工": "Stretch, then let’s get going",
      "我在这儿陪着你": "I’m right here with you", "摸鱼一会儿也没关系": "A short break is fine too", "戳我一下试试？": "Try poking me?",
      "嘘——我在打坐，别打扰": "Shh — I’m meditating", "认真专注中，看我！": "Focusing hard — look at me!",
      "别看我，看任务": "Don’t look at me, look at your task", "专注的时候我最亮": "I shine brightest when you focus",
      "这一轮我们一起加油": "Let’s push through this round", "时间在走，我陪着你": "Time is moving — I’m with you",
      "休息一下，伸个懒腰": "Take a break, stretch", "喝口水吧": "Have some water", "陪我跳一跳？": "Bounce with me?",
      "休息也是正经事": "Resting is real work too", "眼睛也歇一会儿": "Give your eyes a rest",
      "休息好啦，要开始下一轮吗？": "Break’s over — next round?", "我准备好了，你呢？": "I’m ready — you?",
      "直接开始，还是再歇会儿？": "Start now, or rest a bit more?", "时间被我冻住啦": "I froze the clock",
      "暂停中，慢慢来": "Paused — take your time", "想歇就歇，我等你": "Rest if you need to — I’ll wait",
      "进度条在原地等你": "The progress bar is waiting for you", "有点累了…": "A little tired…",
      "摸摸头会好一点": "A head pat helps a bit", "今天已经做得很好了": "You did well today already",
      "要不要休息一下？": "How about a rest?", "我陪你一起难过一小会儿": "I’ll be sad with you for a bit",
      "✨ 今天也辛苦了，偷偷给你加个光环": "✨ You worked hard today — here’s a secret halo",
      "🍅 连点我有惊喜哦": "🍅 Keep clicking for a surprise", "✨ 你专注的样子最好看": "✨ You look best when you focus",
      "🌟 好运分你一半": "🌟 Half my luck goes to you", "🍀 今天也会是好日子": "🍀 Today will be a good day too", "嗯？": "Hm?",
      "怎么啦": "What’s up?", "嘿~": "Hey~", "我在呢": "I’m here", "戳我干嘛呀": "Why poke me?",
      "再戳就生气了！": "Poke me again and I’ll get mad!", "好吧好吧，给你看个宝贝 ✨": "Fine, fine — look at this ✨",
      "呜呜，别戳啦…": "Aw, stop poking…", "点我互动": "Tap to interact", "摸摸番茄精灵": "Pat the pomodoro sprite",
      "点击展开番茄精灵": "Click to expand the sprite",
      "拖动移动 · 单击回应 · 双击互动（连点有惊喜）": "Drag to move · click to chat · double-click to play (keep clicking for a surprise)",
      "干得漂亮!": "Nice work!", "又一个!我们好棒": "Another one! We’re great", "收获满满,继续加油": "Great haul — keep going",
      "你专注的样子在发光": "You’re glowing while you focus", "王者之路,由番茄铺成": "The king’s road is paved with pomodoros",
      "你专注的时候，Agent 也没闲着 🤝": "While you focused, the agent kept working 🤝", "结算面板": "Session summary",
      "再来一个": "One more", "🏅 解锁成就「": "🏅 Achievement unlocked “", "⬆️ 升到 Lv.": "⬆️ Reached Lv.",
      "🍅 本次专注 ": "🍅 Focused ", "🤖 专注期间 Agent 执行 ": "🤖 Agent ran ", " 次工具": " tool calls during focus",
      "你的专注足迹": "Your focus footprint",
      "每一次专注,都在慢慢累积成就感。坚持自己的节奏就很好。": "Every session adds up. Keep your own rhythm.",
      "◷　专注总时长": "◷　Total focus time", "◎　目标完成率": "◎　Goal completion", "🔥　最长连续": "🔥　Longest streak",
      "🍅　累计番茄": "🍅　Total pomodoros", "近半年": "Last 6 months", "全年": "Full year", "专注时间热力图": "Focus heatmap",
      "用颜色记录每一天的专注强度,颜色越深代表专注时间越长。": "Colour shows how much you focused each day — darker means longer.",
      "少": "Less", "多": "More", "番茄数": "Pomodoros", "专注分钟": "Focus minutes",
      "完成第一个番茄后，这里会有你的数据": "Your data appears after the first pomodoro",
      "热力图会按天记录专注强度，颜色越深投入越多。": "The heatmap records daily focus — darker means more effort.",
      "📌 提示:将鼠标悬停在色块上,可查看当天专注时长。": "📌 Tip: hover a cell to see that day’s focus time.",
      "📈　每周专注时长": "📈　Weekly focus time", "🎯　专注时段分布": "🎯　Focus by time of day",
      "暂无时段数据": "No time-of-day data yet",
      "完成几个番茄后，这里会显示你一天中的高效时段": "Your peak hours appear after a few pomodoros",
      "本周还没有专注记录": "No focus recorded this week yet",
      "开始一个番茄，这里会画出每天的投入曲线": "Start a pomodoro to draw your daily curve",
      "本周每日专注时长柱状图": "Daily focus minutes this week", "上午": "Morning", "下午": "Afternoon", "晚上": "Evening",
      "深夜": "Late night", "上午 8–12": "Morning 8–12", "下午 12–18": "Afternoon 12–18", "晚上 18–22": "Evening 18–22",
      "深夜 22–08": "Late night 22–08", "🏅　成就": "🏅　Achievements", "普通": "Common", "稀有": "Rare", "史诗": "Epic",
      "传说": "Legendary", " · 已解锁": " · unlocked", " · 未解锁": " · locked",
      "奖励 {n} 个装扮碎片": "Reward: {n} outfit fragments", "🗂　按会话": "🗂　By session", "会话时长占比": "Session time share",
      "会话与工作区": "Sessions & workspaces",
      "番茄自动归属到当时的 DSH 会话与工作区": "Pomodoros are attributed to the DSH session and workspace in effect",
      "未命名会话": "Untitled session", "会话 ": "Session ", "🎓　工作区技能": "🎓　Workspace skills", "无描述": "No description",
      "在对话里输入 /名称 即可调用": "Type /name in chat to invoke", "工作上下文": "Work context",
      "最近活跃会话（启发式）": "Most recently active session (heuristic)", "DSH Agent 当前活动": "Current DSH agent activity",
      "Agent 运行中": "Agent running", "AI 空闲": "AI idle", "Agent 正在工作": "Agent is working",
      "Agent 动态": "Agent activity", "Agent 联动": "Agent integration", "本周专注报告": "This week’s focus report",
      "本月专注报告": "This month’s focus report", "番茄专注报告": "Pomodoro focus report", "生成本周报告": "Generate weekly report",
      "生成本月报告": "Generate monthly report", "分享 · 竖版": "Share · portrait", "横版": "Landscape",
      "下载 PNG": "Download PNG", "下载 JSON 备份（任务、统计与成就）": "Download JSON backup (tasks, stats, achievements)",
      "分享卡片预览": "Share card preview", "周报": "Weekly", "月报": "Monthly", "平均每天 ": "Daily average ",
      "上期 ": "Previous ", "→ 持平": "→ flat", "比上期": "vs previous", "　较上一周期": "　vs previous period",
      "连续打卡": "Streak", "完成番茄": "Pomodoros done", "你在努力": "Keep going", "番茄钟": "Pomodoro", "专注时长": "Focus length",
      "短休时长": "Short break", "长休时长": "Long break", "长休间隔": "Long break every", "每日目标": "Daily goal",
      "每个番茄的长度（5–120 分钟）": "Length of each pomodoro (5–120 min)", "每个番茄后的休息时间": "Break after each pomodoro",
      "连续多轮后的长休息": "Longer rest after several rounds", "每完成几轮进入一次长休": "Rounds before a long break",
      "今日进度条的目标番茄数": "Target pomodoros for today’s progress bar", "声音与提醒": "Sound & alerts", "提示音": "Chime",
      "音量": "Volume", "桌面通知": "Desktop notifications", "动画效果": "Animations",
      "专注结束与休息结束时的提示音": "Chime when focus or a break ends", "提示音播放音量": "Chime playback volume",
      "页面收起到后台时也能收到提醒": "Get notified even when the page is in the background",
      "关闭后所有过渡与庆祝动效静止": "Turn off all transitions and celebrations", "浏览器不支持": "Not supported by this browser",
      "✓ 已授权": "✓ Allowed", "已被拒绝，请在浏览器设置中开启": "Blocked — enable it in your browser settings", "申请授权": "Allow",
      "外观": "Appearance", "主题": "Theme",
      "跟随 DSH 的外观设置自动切换（在「设置 → 通用 → 外观」修改）": "Follows the DSH appearance setting (change it in Settings → General → Appearance)",
      "🌙 深色（跟随 DSH）": "🌙 Dark (follows DSH)", "☀️ 浅色（跟随 DSH）": "☀️ Light (follows DSH)",
      "默认深色；跟随系统时随系统深浅色自动切换": "Dark by default; System follows your OS setting", "跟随系统": "System",
      "跟随系统（推荐）": "System (recommended)", "浅色": "Light", "深色": "Dark", "桌宠": "Desktop pet", "大小": "Size",
      "桌宠大小": "Pet size", "归位": "Position", "桌宠浮层的显示比例（0.5–2.0×）": "Scale of the floating pet (0.5–2.0×)",
      "把桌宠移回右下角默认位置": "Move the pet back to the bottom-right corner", "本地": "Local", "数据来源": "Data source",
      "宠物冒工具气泡、状态点与结算战绩（本机偏好）": "Pet tool bubbles, status dot and session record (local preference)",
      "显示最近会话名、工作区目录与「按会话」统计": "Show recent session names, workspace paths and per-session stats",
      "DSH 会话事件 + 工具调用事件，仅在本机展示，不上传、不写入导出": "DSH session and tool events, shown locally only — never uploaded or exported",
      "统计时区": "Stats time zone",
      "跨日归属按此时区计算（改变不追溯历史）": "Day boundaries use this zone (changes don’t rewrite history)", "数据": "Data",
      "10 个碎片兑换 1 件装扮（可预览）": "10 fragments per outfit (previewable)", "导出数据": "Export data",
      "导出 JSON": "Export JSON", "操作审计": "Action audit", "审计记录": "Audit log",
      "记录 Agent 每次调用的动作与结果": "Record every agent action and its result",
      "查看最近操作（最多保留 1000 条）": "View recent actions (kept up to 1000)", "暂无记录": "No records yet", "关于": "About",
      "版本": "Version", "番茄精灵 · DSH 插件": "Pomodoro Pet · DSH plugin", "✓ 已自动保存": "✓ Saved automatically",
      "恢复默认设置？任务与统计记录不受影响。": "Restore defaults? Tasks and stats are unaffected.",
      "显示任务名（默认隐藏,注意隐私）": "Show task names (hidden by default for privacy)",
      "（可直接输入, 回车或失焦生效）": " (type a value, Enter or blur to apply)", "减少": "Decrease ", "增加": "Increase ",
      "减少预估番茄数": "Decrease estimated pomodoros", "增加预估番茄数": "Increase estimated pomodoros", "个": "", "分": " min",
      "轮": " rounds", "天": " days", "天,口径:": " days, metric: ", "月": "month", "每日专注热力图,": "Daily focus heatmap, ",
      "经验 ": "EXP ", "本月目标完成情况": "This month’s goal progress",
      "✨ 完成第一个番茄后,这里会出现你的时段洞察。": "✨ Your time-of-day insight appears after the first pomodoro.",
      "完成第一个番茄后,这里会出现你的时段洞察。": "Your time-of-day insight appears after the first pomodoro.",
      "A 紧急重要": "A Urgent & important", "B 重要不紧急": "B Important, not urgent", "C 紧急不重要": "C Urgent, not important",
      "D 其他": "D Other", "重要+紧急": "Important + Urgent", "重要+不紧急": "Important + Not urgent",
      "紧急+不重要": "Urgent + Not important", "不紧急+不重要": "Neither", "紧急重要": "Urgent & important",
      "重要不紧急": "Important, not urgent", "紧急不重要": "Urgent, not important", "其他": "Other",
      "⏰ 休息结束啦,回来看看我呀!": "⏰ Break is over — come see me!", "今天的你也很棒": "You’re doing great today",
      "完成第一个番茄后开始记录": "Tracking starts after your first pomodoro", "统计范围": "Stats range",
      "继续保持这个节奏": "Keep this pace",
      "🍅 专注完成!休息一下,精灵在撒欢": "🍅 Focus done! Take a break — the sprite is celebrating",
      "🎉 精灵进化了!快去看看它": "🎉 Your sprite evolved! Go take a look", "周一": "Mon", "周二": "Tue", "周三": "Wed",
      "周四": "Thu", "周五": "Fri", "周六": "Sat", "周日": "Sun", "🔥 连续 ": "🔥 Streak ",
      "🔥 {n}-day streak": "🔥 {n}-day streak", " 天": " days", " 个番茄": " pomodoros", " 分钟": " min", " 小时": " h",
      " 个": "", "个番茄": "pomodoros", "分钟": " min", "小时": " h", " 个番茄 · 距长休还差 ": " pomodoros · ",
      "🌱 标准": "🌱 Standard", "🍅 标准": "🍅 Standard", "🌿 深度": "🌿 Deep", "⚡ 冲刺": "⚡ Sprint", "番茄": "Pomodoro",
      "标准 25": "Standard 25", "深度 50": "Deep 50", "冲刺 15": "Sprint 15", "工作区技能": "Workspace skills",
      "成就": "Achievements", "成就进度 ": "Achievement progress ",
    }
    /** 中文词典（自映射，供 ctx.locale 的中文查找链完整）。 */
    const ZH_SELF_DICT = Object.fromEntries(Object.keys(EN_TEXT).map(k => [k, k]))
    /** PATTERNS: [正则, 替换] 用于插值成品（"6 / 8 个番茄"、"3 天"…）。 */
    const PATTERNS = [

      [/^(\d+) 个番茄 · 专注 (\d+) 分钟 · 活跃 (\d+) 天 · \+(\d+) EXP$/g, "$1 pomodoros · $2 min focused · $3 active days · +$4 EXP"],
      [/^近半年共专注 ([\d.]+) 小时 · (\d+) 个番茄 · B 区占 (\d+)%$/g, "Last 6 months: $1 hours focused · $2 pomodoros · $3% in quadrant B"],
      [/^全年共专注 ([\d.]+) 小时 · (\d+) 个番茄 · B 区占 (\d+)%$/g, "This year: $1 hours focused · $2 pomodoros · $3% in quadrant B"],
      [/^番茄精灵:(.+) — 按 Enter 收纳,Escape 收纳$/g, "Pomodoro sprite: $1 — press Enter or Escape to tuck away"],
      [/^番茄精灵:已收纳（(.+)） — 点击或按 Enter 展开$/g, "Pomodoro sprite: tucked away ($1) — click or press Enter to expand"],
      [/^装扮碎片\s*(\d+)\/10$/g, "Outfit fragments $1/10"],
      [/^自定义装扮\s*·\s*(\d+)\/10(.*)$/g, "Custom outfit · $1/10$2"],
      [/^每日专注热力图, (\d+) 天,口径:(.+)$/g, "Daily focus heatmap, $1 days, metric: $2"],
      [/^再收集\s*(\d+)\s*个碎片即可兑换$/g, "Collect $1 more fragments to redeem"],
      [/^(.+?)（可直接输入, 回车或失焦生效）$/g, "$1 (type a value, then press Enter or click away)"],
      [/自定义装扮\s*·\s*(\d+)\/(\d+)/g, "Customize outfit · $1/$2"],
      [/^进行中 (\d+) 个 · 点击图例按象限过滤$/g, "$1 active · click a legend to filter by quadrant"],
      [/装扮碎片\s*(\d+)\s*\/\s*(\d+)/g, "Fragments $1/$2"],
      [/碎片\s*(\d+)\s*\/\s*(\d+)/g, "$1/$2 fragments"],
      [/^⬆️ 升到 Lv\.(\d+)!$/g, "⬆️ Leveled up to Lv.$1!"],
      [/^🤖 专注期间 Agent 执行 (\d+) 次工具$/g, "🤖 Agent ran $1 tools during focus"],
      [/^已暂停,剩余 ([\d:]+)$/g, "Paused, $1 left"],
      [/^删除任务「(.+?)」\?$/g, "Delete task “$1”?"],
      [/^平均每天 ([\d.]+) 小时$/g, "Daily average $1 hours"],
      [/升到 Lv\.(\d+)/g, "Reached Lv.$1"],
      [/平均每天 ([\d.]+)/g, "Daily average $1"],
      [/^(\d+)\s*个会话\s*·\s*([\d.]+)h$/g, "$1 sessions · $2h"],
      [/^🏅 解锁成就「(.+?)」$/g, "🏅 Achievement unlocked: “$1”"],
      [/^心情(.+?),今天也要加油呀$/g, "Feeling $1 — let’s do our best today"],
      [/^(\d+) 条待确认提议,见下方待确认区$/g, "$1 pending proposals — see the section below"],
      [/(\d+)\s*\/\s*(\d+)\s*个番茄/g, "$1 / $2 pomodoros"],
      [/连续\s*(\d+)\s*天/g, "$1-day streak"],
      [/点击图例按象限过滤/g, "click a legend to filter by quadrant"],
      [/解锁成就「(.+?)」/g, "Achievement unlocked “$1”"],
      [/^🍅 本次专注 ([\d:]+)$/g, "🍅 Focused $1 this round"],
      [/^专注中,剩余 ([\d:]+)$/g, "Focusing, $1 left"],
      [/^本轮第 (\d+) 个番茄 · 距长休还差 (\d+) 个$/g, "Round $1 · $2 more to a long break"],
      [/^经验 (\d+)\/(\d+)$/g, "EXP $1/$2"],
      [/已完成 \((\d+)\)/g, "Completed ($1)"],
      [/连续 ([\d,.]+) 天/g, "Streak $1 days"],
      [/本轮任务[:：]\s*(.+)$/g, "This round: $1"],
      [/本次专注 ([\d:]+)/g, "Focused $1"],
      [/^还差\s*(\d+)\s*个碎片$/g, "$1 fragments to go"],
      [/^空闲,Lv\.(\d+)$/g, "Idle, Lv.$1"],
      [/^🤖 待确认提议 \((\d+)\)$/g, "🤖 Pending proposals ($1)"],
      [/^本轮任务:(.+)$/g, "Current task: $1"],
      [/^成就进度 (\d+)%$/g, "Achievement progress $1%"],
      [/(\d+)\s*个碎片/g, "$1 fragments"],
      [/^会话 ([\w-]{4,})$/g, "Session $1"],
      [/·\s*🤖\s*(\d+)\s*次工具/g, "· 🤖 $1 tool calls"],
      [/^今日完成 (\d+)\/(\d+) 个番茄$/g, "$1/$2 pomodoros today"],
      [/^删除任务 (.+)$/g, "Delete task $1"],
      [/^对「(.+?)」开钟$/g, "Start a pomodoro for “$1”"],
      [/^新建任务「(.+?)」(.+)$/g, "New task “$1”$2"],
      [/^番茄串 (\d+)\/(\d+)$/g, "Pomodoros $1/$2"],
      [/^减少(.*)$/g, "Decrease $1"],
      [/^审计日志 \((\d+)\)$/g, "Audit log ($1)"],
      [/(\d+)\s*个\s*·\s*点击复制/g, "$1 · click to copy"],
      [/^今日\s*(\d+)\s*工具$/g, "$1 tools today"],
      [/^(\d+)\s*个\s*·\s*点击复制$/g, "$1 · click to copy"],
      [/^🔥 连续 (\d+) 天$/g, "🔥 $1-day streak"],
      [/^重新打开任务 (.+)$/g, "Reopen task $1"],
      [/^完成任务 (.+)$/g, "Complete task $1"],
      [/^修改任务 (.+)$/g, "Update task $1"],
      [/^比上期 ([\d.]+)%$/g, "vs. last period $1%"],
      [/^上期 (\d+) 个,/g, "Last period $1,"],
      [/^增加(.*)$/g, "Increase $1"],
      [/(\d+)\s*个会话/g, "$1 sessions"],
      [/(\d+)\s*次工具/g, "$1 tool calls"],
      [/([\d.]+)\s*小时/g, "$1 h"],
      [/([\d.]+)\s*分钟/g, "$1 min"],
      [/(\d+)\s*天/g, "$1 days"],
      [/(\d+)\s*轮/g, "$1 rounds"],
      [/(\d+)月(\d+)日/g, "$1/$2"],
      [/全年共专注/g, "This year: "],
      [/(\d+)\s*个番茄/g, "$1 pomodoros"],
      [/(\d+)\s*个工具/g, "$1 tools"],
      [/连续/g, "Streak"],
      [/(\d+)\s*个$/g, "$1"],
      [/近半年共专注/g, "In 6 months: "],
      [/B 区占/g, "B region"],
      [/进行中 (\d+) 个/g, "$1 in progress"],
      [/今日 (\d+) 工具/g, "$1 tools today"],
      [/(\d+)\s*个 · 点击复制/g, "$1 · click to copy"],
      [/占总时长/g, "of total time"],
      [/^(\d+) (天)$/g, "$1 days"],
      [/^(\d+) (轮)$/g, "$1 rounds"],
      [/^🤖 (\d+) 条待确认$/g, "🤖 $1 pending"],
      [/^([\d.]+) 小时$/g, "$1 h"],
      [/^(\d+) 小时$/g, "$1 hours"],
      [/(\d+) 个番茄 · /g, "$1 pomodoros · "],
      [/^(\d+) (分|分钟)$/g, "$1 min"],
      [/^(\d+) (个)$/g, "$1"],
      [/^(\d+) 分钟$/g, "$1 min"],
      [/^(\d+)月$/g, "$1"],
      [/^≈ (\d+) 分钟$/g, "≈ $1 min"],

    ]
    const buildDict = () => ({ text: EN_TEXT })

    /* ---------------- 设计 token (§13.1 + v0.5 视觉重设计) ---------------- */
    // v0.5: 暖纸底 + 番茄红（对齐 tomato_spirit_dashboard.html 设计稿）。
    // 颜色仍走 token 对象 C（后接 .pp-app 作用域 CSS 注入，§13.1）。
    const C = {
      accent: 'var(--dsw-alias-brand-primary, #E74C3C)',
      warm: '#F39C12', success: '#27AE60', danger: '#E74C3C', warning: '#E67E22',
      taskA: '#E74C3C', taskB: '#F39C12', taskC: '#3498DB', taskD: '#95A5A6',
      text: 'var(--dsw-alias-label-primary, #1c1c1e)',
      text2: 'var(--dsw-alias-label-secondary, rgba(60,60,67,.6))',
      text3: 'var(--dsw-alias-label-tertiary, rgba(60,60,67,.3))',
      bg: 'var(--dsw-alias-bg-layer-1, #fff)',
      bg2: 'var(--dsw-alias-bg-layer-2, #F2F2F7)',
      bg3: 'var(--dsw-alias-bg-layer-3, #E5E5EA)',
      border: 'var(--dsw-alias-border-l1, rgba(60,60,67,.12))',
      heat: ['#EBEDF0', '#FFD4CC', '#FF9B8A', '#E74C3C', '#C0392B'],
    }
    const QUADRANTS = [
      { key: 'A', label: '重要+紧急', color: C.taskA },
      { key: 'B', label: '重要+不紧急', color: C.taskB },
      { key: 'C', label: '紧急+不重要', color: C.taskC },
      { key: 'D', label: '不紧急+不重要', color: C.taskD },
    ]
    const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif`
    const EASE_BACK = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
    /** 动画总开关（§13.6 animationEnabled + prefers-reduced-motion 双闸门）。 */
    let animationsOn = true
    const setAnimationsEnabled = (v) => { animationsOn = v !== false }
    const reduceMotion = () => {
      if (!animationsOn) return true
      try { return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false } catch { return false }
    }
    const MODES = [
      { key: 'standard', label: '标准 25', min: 25 },
      { key: 'deep', label: '深度 50', min: 50 },
      { key: 'sprint', label: '冲刺 15', min: 15 },
    ]
    const modeColor = { standard: '#f15f50', deep: '#8E44AD', sprint: '#f5ae42' }
    const safeParse = (s) => { try { return JSON.parse(s) } catch { return {} } }

    /* ---------------- 主题（v0.9.1：完全跟随 DSH） ----------------
     * 不再有手动切换：直接读 DSH 的主题状态 `body[data-ds-dark-theme]`，
     * 并用 MutationObserver 跟随变化，与「设置 → 通用 → 外观」同步。
     * 同时把结果写到 <html data-pp-theme>，让 `:root[...]` 级细节覆盖也能生效。 */
    const themeStore = { effective: 'light', observer: null, listeners: new Set() }

    /** DSH 当前是否深色（无 body 时退回系统偏好）。 */
    const dshPrefersDark = () => {
      try {
        if (typeof document !== 'undefined' && document.body) {
          return document.body.hasAttribute('data-ds-dark-theme')
        }
      } catch { /* non-DOM */ }
      try { return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false } catch { return false }
    }
    const effectiveTheme = () => themeStore.effective

    /** 同步 <html data-pp-theme>（幂等）。 */
    const applyThemeAttr = () => {
      if (typeof document === 'undefined') return
      try { document.documentElement.setAttribute('data-pp-theme', themeStore.effective) } catch { /* non-DOM */ }
    }

    /** 重新读取 DSH 主题；变化时通知订阅者。 */
    const syncTheme = (force) => {
      const next = dshPrefersDark() ? 'dark' : 'light'
      if (!force && next === themeStore.effective) return
      themeStore.effective = next
      applyThemeAttr()
      for (const fn of [...themeStore.listeners]) fn()
    }

    /** 监听 body 上的 data-ds-dark-theme 变化（DSH 切换外观时触发）。 */
    const bindThemeObserver = () => {
      if (themeStore.observer || typeof document === 'undefined' || !document.body) return
      try {
        themeStore.observer = new MutationObserver(() => syncTheme(false))
        themeStore.observer.observe(document.body, {
          attributes: true, attributeFilter: ['data-ds-dark-theme'],
        })
      } catch { /* no MutationObserver */ }
    }

    /** 订阅 DSH 主题；返回 { mode, effective }（mode 与 effective 相同，保留旧字段兼容）。 */
    function useTheme() {
      const [, force] = React.useReducer(n => n + 1, 0)
      // 渲染期同步（幂等），避免首帧颜色闪一下
      themeStore.effective = dshPrefersDark() ? 'dark' : 'light'
      applyThemeAttr()
      React.useEffect(() => {
        bindThemeObserver()
        syncTheme(true)
        themeStore.listeners.add(force)
        return () => { themeStore.listeners.delete(force) }
      }, [])
      return { mode: themeStore.effective, effective: themeStore.effective }
    }

    /* ---------------- v0.5 作用域样式注入 ----------------
     * 全部规则限定在 .pp-app（面板）/ .pp-pet-host（桌宠 overlay）下,
     * 不影响 Harness 其余 UI。幂等注入, id 重复则跳过。
     * token 源: tomato_spirit_dashboard.html 设计稿（暖纸底 + 番茄红）。 */
    const PP_STYLE_ID = 'pp-v05-styles'
    const PP_CSS = `
.pp-app,.pp-pet-host{
  --pp-bg:#faf8f5; --pp-paper:#fffefd; --pp-ink:#252a32; --pp-muted:#6f7680;
  --pp-line:#eeeae5; --pp-red:#f15f50; --pp-red-dark:#df4e42; --pp-red-soft:#fff0ed;
  --pp-green:#4ba66a; --pp-green-soft:#edf8f0; --pp-orange:#f5ae42; --pp-orange-soft:#fff6e8;
  --pp-blue:#4599e8; --pp-blue-soft:#edf6ff; --pp-gray-soft:#f0f1f2;
  --pp-shadow:0 8px 28px rgba(55,43,32,.045); --pp-radius:18px;
  font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
.pp-app[data-theme="dark"],.pp-pet-host[data-theme="dark"]{
  --pp-bg:#1f1b18; --pp-paper:#262220; --pp-ink:#ece7e2; --pp-muted:#a39b93;
  --pp-line:#383230; --pp-red:#f07368; --pp-red-dark:#f08a80; --pp-red-soft:#3a2723;
  --pp-green:#5cbb7c; --pp-green-soft:#21302a; --pp-orange:#f5b95c; --pp-orange-soft:#382e1e;
  --pp-blue:#5ea9ec; --pp-blue-soft:#1e2c3a; --pp-gray-soft:#2e2b29;
  --pp-shadow:0 8px 28px rgba(0,0,0,.28);
}
.pp-app,.pp-pet-host{transition:background-color .2s ease,color .2s ease}
.pp-app{background:var(--pp-bg);color:var(--pp-ink);font-size:14px;line-height:1.5;
  height:100vh;height:100dvh;max-height:100dvh;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain}
.pp-app button,.pp-app input,.pp-app select{font:inherit}
.pp-app button{cursor:pointer}
.pp-app main{max-width:1600px;margin:0 auto;padding:8px 40px 44px}
/* ---- header ---- */
.pp-header{height:88px;display:grid;grid-template-columns:1fr minmax(360px,560px) 1fr;align-items:center;gap:22px;border-bottom:1px solid var(--pp-line)}
.pp-brand{display:flex;align-items:center;gap:12px}
.pp-brand strong{font-size:19px;letter-spacing:-.5px;display:block}
.pp-brand small{display:block;color:var(--pp-muted);font-size:12px;margin-top:2px}
.pp-logo{width:46px;height:46px;display:grid;place-items:center}
.pp-nav{display:flex;align-items:center;justify-content:center;gap:8px}
.pp-nav button{border:0;background:transparent;border-radius:13px;padding:12px 17px;display:flex;align-items:center;gap:9px;color:#626a73;font-size:15px;min-width:104px;justify-content:center}
.pp-nav button:active{transform:scale(.97)}
.pp-nav button[aria-selected="true"]{background:var(--pp-red-soft);color:var(--pp-red-dark);font-weight:650}
.pp-app[data-pp-dark="1"] .pp-nav button{color:var(--pp-muted)}
.pp-profile{justify-self:end;display:flex;align-items:center;gap:10px}
.pp-profile .pp-avatar{width:38px;height:38px;border-radius:50%;overflow:hidden;flex-shrink:0}
.pp-profile strong{font-size:13px;display:block}
.pp-profile small{display:block;color:var(--pp-muted);font-size:11px;margin-top:2px}
/* ---- page head ---- */
.pp-pagehead{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:18px 0 16px}
.pp-pagehead h1{font-size:27px;margin:0;font-weight:750;letter-spacing:-.8px}
.pp-pagehead .pp-date{color:var(--pp-muted);font-size:14px;display:flex;align-items:center;gap:22px}
.pp-pills{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pp-pill{display:flex;align-items:center;gap:7px;border:1px solid var(--pp-line);border-radius:99px;padding:7px 13px;background:var(--pp-paper);color:var(--pp-ink);font-weight:600;font-size:12.5px;box-shadow:0 1px 2px rgba(55,43,32,.03)}
.pp-pill.streak{color:var(--pp-red-dark);background:var(--pp-red-soft);border-color:transparent}
.pp-pill.warm{color:#c78116;background:var(--pp-orange-soft);border-color:transparent}
/* ---- layout ---- */
.pp-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.04fr);gap:20px;align-items:start}
.pp-col{display:grid;gap:18px;align-content:start}
.pp-card{background:var(--pp-paper);border:1px solid var(--pp-line);border-radius:var(--pp-radius);box-shadow:var(--pp-shadow)}
.pp-cardhead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:15px 20px 9px}
.pp-cardhead h2{font-size:17px;margin:0;font-weight:700;display:flex;align-items:center;gap:9px}
.pp-subtle{color:var(--pp-muted);font-size:12px}
/* ---- timer ---- */
.pp-hero{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(220px,1fr);align-items:center;gap:8px;position:relative;
  background:radial-gradient(ellipse at 20% 90%,rgba(248,231,200,.55) 0,transparent 40%),linear-gradient(180deg,var(--pp-paper),#fffaf5);
  border-radius:var(--pp-radius) var(--pp-radius) 0 0;margin:0 24px 14px;padding:10px 18px;min-height:210px}
.pp-hero-art{position:relative;height:186px;display:flex;align-items:flex-end;justify-content:center}
.pp-hero-art .pp-bigtomato{transform:translateY(-6px)}
.pp-spark{position:absolute;font-size:25px;top:34px;right:14%;animation:pp-float 3s ease-in-out infinite}
.pp-leaf{position:absolute;font-size:28px;top:18px;left:20%}
@keyframes pp-float{50%{transform:translateY(-7px) rotate(8deg)}}
.pp-ringwrap{display:grid;justify-items:center;gap:7px}
.pp-ringbox{position:relative;width:min(100%,188px);aspect-ratio:1;display:grid;place-items:center}
.pp-ringbox>svg{position:absolute;inset:0;width:100%;height:100%}
.pp-ring-inner{position:relative;z-index:1;display:grid;justify-items:center;gap:6px}
.pp-time{font-size:38px;line-height:1;font-weight:760;letter-spacing:-1.2px;font-variant-numeric:tabular-nums}
.pp-caption{color:var(--pp-muted);font-size:13px}
.pp-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:0 24px 12px}
.pp-mode{border:1px solid var(--pp-line);border-radius:12px;background:var(--pp-paper);padding:8px;color:var(--pp-muted);display:flex;flex-direction:column;align-items:center;gap:2px}
.pp-mode strong{color:var(--pp-ink);font-weight:650}
.pp-mode small{font-size:12px}
.pp-mode[aria-pressed="true"]{background:var(--pp-red-soft);border-color:#ffb4a9;color:var(--pp-red-dark)}
.pp-mode[aria-pressed="true"] strong{color:var(--pp-red-dark)}
.pp-mode:disabled{opacity:.55;cursor:not-allowed}
.pp-taskselect{display:flex;justify-content:space-between;align-items:center;gap:10px;border:1px solid var(--pp-line);border-radius:12px;padding:10px 15px;background:var(--pp-paper);color:var(--pp-muted);margin:0 24px 12px;width:calc(100% - 48px);text-align:left}
.pp-primaryrow{display:flex;gap:12px;padding:0 24px 16px}
.pp-startbtn{flex:1;border:0;border-radius:99px;background:linear-gradient(100deg,#f46859,#e95448);color:#fff;font-weight:700;font-size:16px;padding:15px 20px;box-shadow:0 7px 14px rgba(241,95,80,.15)}
.pp-startbtn:hover{filter:brightness(.98);transform:translateY(-1px)}
.pp-secondarybtn{border:1px solid var(--pp-line);background:var(--pp-paper);border-radius:99px;padding:12px 16px;color:var(--pp-ink)}
.pp-secondarybtn:active{transform:scale(.97)}
.pp-dangerbtn{border:1px solid #ffd9d4;background:var(--pp-red-soft);border-radius:99px;padding:12px 16px;color:var(--pp-red-dark);font-weight:600}
/* ---- progress ---- */
.pp-progressbody{padding:0 20px 14px}
.pp-progressline{display:flex;align-items:center;gap:16px}
.pp-track{height:9px;background:var(--pp-line);border-radius:99px;overflow:hidden;flex:1}
.pp-track>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#f36b5c,#e95347);transition:width .3s}
.pp-count{white-space:nowrap;font-weight:650}
.pp-tomatorow{display:flex;gap:8px;margin-top:8px;font-size:15px}
/* ---- tasks ---- */
.pp-tasklist{display:grid;gap:10px;padding:0 18px}
.pp-task{display:grid;grid-template-columns:5px 23px minmax(0,1fr) auto 18px;align-items:center;gap:12px;border:1px solid var(--pp-line);border-radius:12px;padding:12px 13px 12px 0;min-height:56px;background:var(--pp-paper);transition:border-color .15s,box-shadow .15s}
.pp-task:hover{border-color:#e6ddd3;box-shadow:0 4px 14px rgba(55,43,32,.05)}
.pp-task .pp-bar{height:100%;min-height:34px;border-radius:0 5px 5px 0}
.pp-task input[type=checkbox]{width:19px;height:19px;accent-color:var(--pp-red);cursor:pointer;margin:0}
.pp-taskname{font-size:15px;font-weight:600;display:flex;gap:9px;align-items:center;flex-wrap:wrap;min-width:0}
.pp-taskname>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-tag{font-size:11px;border-radius:99px;padding:4px 7px;font-weight:600;flex-shrink:0}
.pp-taskmeta{display:flex;align-items:center;gap:9px;color:var(--pp-muted);font-size:12px;white-space:nowrap}
.pp-strand{display:flex;gap:3px;align-items:center;flex-wrap:nowrap}
.pp-strand .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0}
.pp-strand .dot.empty{background:var(--pp-gray-soft)}
.pp-task .pp-count{font-variant-numeric:tabular-nums}
.pp-taskhover{display:flex;gap:2px;opacity:0;transition:opacity .15s}
.pp-task:hover .pp-taskhover,.pp-task:focus-within .pp-taskhover{opacity:1}
.pp-taskdone .pp-taskname{text-decoration:line-through;color:var(--pp-muted)}
.pp-addtask{border:1px dashed #e6dfd9;background:transparent;border-radius:11px;padding:12px;color:var(--pp-muted);width:calc(100% - 36px);margin:11px 18px 18px}
/* ---- 任务分布 (v0.5.3: 比例条 + 图例 chips) ---- */
.pp-dist{margin-top:18px;padding:14px 18px 12px}
.pp-dist-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
.pp-dist-head h2{font-size:14.5px;margin:0;font-weight:700}
.pp-dist-sub{font-size:11.5px;color:var(--pp-muted)}
.pp-dist-bar{display:flex;gap:3px;height:8px;border-radius:99px;overflow:hidden;background:var(--pp-bg)}
.pp-dist-seg{display:block;min-width:8px;border-radius:99px}
.pp-dist-empty{background:var(--pp-line)}
.pp-dist-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.pp-dist-chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--pp-line);background:var(--pp-paper);
  border-radius:999px;padding:5px 12px;font-size:12.5px;color:var(--pp-ink);cursor:pointer;
  transition:border-color .15s,background .15s,transform .15s}
.pp-dist-chip i{width:8px;height:8px;border-radius:50%;background:var(--qc);flex-shrink:0}
.pp-dist-chip b{font-variant-numeric:tabular-nums;font-weight:750;color:var(--qc)}
.pp-dist-chip:hover{border-color:var(--qc);transform:translateY(-1px)}
.pp-dist-chip.active{border-color:var(--qc);background:var(--qs)}
.pp-dist-chip:active{transform:scale(.98)}
/* ---- pet card ---- */
.pp-petcontent{display:grid;grid-template-columns:150px minmax(0,1fr);align-items:center;gap:14px;padding:2px 20px 14px}
.pp-petinfo h3{margin:0 0 13px;font-size:17px}
.pp-expline{height:9px;background:var(--pp-line);border-radius:99px;overflow:hidden}
.pp-expline>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#f46a5b,#e95145)}
.pp-mood{margin-top:22px;display:flex;align-items:center;gap:9px;font-weight:650}
.pp-note{color:var(--pp-muted);margin-top:12px;line-height:1.6}
/* ---- proposals ---- */
.pp-proposalcard{margin:0 18px 12px;border:1px dashed var(--pp-orange);border-radius:12px;padding:12px 14px;background:var(--pp-orange-soft)}
.pp-proposalrow{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px}
/* ---- quadrant filter / drop zones ---- */
.pp-filters{display:flex;gap:6px;flex-wrap:wrap;padding:4px 18px 0}
.pp-qhead{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:650;margin:8px 0 5px;padding:0 18px}
.pp-qhead .pp-qcount{font-size:11px;font-weight:600;color:var(--pp-muted);background:var(--pp-bg);border-radius:999px;padding:1px 7px;line-height:1.5}
.pp-dropzone{border-radius:12px;padding:0 18px 4px;transition:background .15s}
.pp-dropzone-empty{padding-bottom:2px}
.pp-dropzone-over{background:var(--pp-red-soft);outline:2px dashed var(--pp-red);outline-offset:-2px}
.pp-drophint{font-size:11.5px;color:var(--pp-muted);border:1px dashed #e6ddd3;border-radius:10px;padding:7px;text-align:center;margin-bottom:6px}
/* ---- modal ---- */
.pp-backdrop{position:fixed;inset:0;background:rgba(37,42,50,.4);display:grid;place-items:center;padding:20px;z-index:60}
.pp-modal{background:var(--pp-paper);border-radius:18px;padding:24px;width:min(100%,420px);box-shadow:0 20px 60px rgba(0,0,0,.18);max-height:90vh;overflow:auto}
.pp-modal h2{margin:0 0 18px;font-size:18px}
.pp-modal label{display:block;font-size:13px;color:var(--pp-muted);margin:12px 0 6px}
.pp-modal input,.pp-modal select{width:100%;padding:11px;border:1px solid var(--pp-line);border-radius:10px;background:var(--pp-paper);color:var(--pp-ink)}
.pp-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
/* ---- v0.8.2 表单：数字输入 / 紧凑步进器 / 弹窗焦点 ---- */
.pp-modal input,.pp-modal select{font-family:inherit;font-size:13.5px}
.pp-modal input:focus,.pp-modal select:focus{border-color:var(--pp-red);box-shadow:0 0 0 3px rgba(241,95,80,.12);outline:none}
input[type="number"]{appearance:textfield;-moz-appearance:textfield}
input[type="number"]::-webkit-outer-spin-button,input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pp-field{display:grid;gap:8px;margin:14px 0}
.pp-field .pp-field-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.pp-field .pp-field-head label{margin:0}
.pp-field-hint{font-size:11.5px;color:var(--pp-muted);font-variant-numeric:tabular-nums}
.pp-stepper{display:inline-flex;align-items:center;gap:2px;background:var(--pp-bg);border:1px solid var(--pp-line);border-radius:999px;padding:3px;width:max-content}
.pp-stepper .pp-step-btn{width:28px;height:28px;border:0;border-radius:50%;background:transparent;color:var(--pp-red-dark);font-size:16px;font-weight:700;display:grid;place-items:center;cursor:pointer;line-height:1;font-family:inherit}
.pp-stepper .pp-step-btn:hover:not(:disabled){background:var(--pp-paper)}
.pp-stepper .pp-step-btn:disabled{color:var(--pp-muted);opacity:.45;cursor:not-allowed}
.pp-stepper-unit{font-size:11.5px;color:var(--pp-muted);padding:0 6px 0 2px}
.pp-stepper .pp-numfield{width:46px;height:30px;border:0;background:transparent;padding:0;box-shadow:none}
.pp-numfield{width:52px;height:30px;border:0;background:transparent;text-align:center;font-size:14px;font-weight:650;
  font-variant-numeric:tabular-nums;color:var(--pp-ink);padding:0;font-family:inherit;border-radius:8px;appearance:textfield}
.pp-numfield:focus{outline:none;color:var(--pp-red-dark)}
.pp-step .pp-numfield{width:42px;height:24px;font-size:13.5px}
.pp-custommin{display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--pp-muted);padding:0 24px 16px}
.pp-custommin label{margin:0}
.pp-custommin .pp-numfield{width:56px;height:30px;border:1px solid var(--pp-line);border-radius:9px;background:var(--pp-paper)}
.pp-custommin .pp-numfield:focus{border-color:var(--pp-red);box-shadow:0 0 0 3px rgba(241,95,80,.12);outline:none}
.pp-custommin-unit{font-size:11.5px;color:var(--pp-muted)}
:root[data-pp-theme="dark"] .pp-stepper .pp-step-btn:hover:not(:disabled){background:#383230}
/* ---- stats ---- */
.pp-statshead{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin:8px 0 22px;flex-wrap:wrap}
.pp-statshead h2{font-size:25px;margin:0 0 7px;letter-spacing:-.5px}
.pp-statshead p{margin:0;color:var(--pp-muted)}
.pp-rangeswitch{display:flex;gap:4px;padding:4px;background:var(--pp-line);border-radius:11px}
.pp-rangeswitch button{border:0;background:transparent;border-radius:8px;padding:8px 13px;color:var(--pp-muted)}
.pp-rangeswitch button[aria-pressed="true"]{background:var(--pp-paper);color:var(--pp-red-dark);box-shadow:0 2px 5px rgba(0,0,0,.06);font-weight:650}
.pp-statcards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:18px}
.pp-statcard{padding:19px 20px}
.pp-statlabel{color:var(--pp-muted);font-size:13px;display:flex;align-items:center;gap:8px}
.pp-statvalue{font-size:29px;font-weight:760;letter-spacing:-.7px;margin:13px 0 7px;font-variant-numeric:tabular-nums}
.pp-statfoot{font-size:12px;color:var(--pp-muted)}
.pp-up{color:var(--pp-green);font-weight:650}
.pp-down{color:var(--pp-red);font-weight:650}
.pp-heathead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.pp-heathead h3{margin:0 0 6px;font-size:17px}
.pp-heathead p{margin:0;color:var(--pp-muted);font-size:12px}
.pp-legend{display:flex;align-items:center;gap:6px;color:var(--pp-muted);font-size:11px;white-space:nowrap}
.pp-heatcell{width:14px;height:14px;border-radius:4px;background:var(--pp-line);display:inline-block}
.pp-heatcell[data-l="0"]{background:var(--pp-gray-soft)}
.pp-heatcell[data-l="1"]{background:#fbd4ce}.pp-heatcell[data-l="2"]{background:#f6a69b}
.pp-heatcell[data-l="3"]{background:#f27668}.pp-heatcell[data-l="4"]{background:#dc4d42}
.pp-heatcell:hover{outline:2px solid #e3a49b;outline-offset:1px}
.pp-heatlabel{color:var(--pp-muted);font-size:11px}
.pp-heatnote{margin-top:16px;color:var(--pp-muted);font-size:12px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pp-statslower{display:grid;grid-template-columns:1.1fr .9fr;gap:18px}
.pp-panel{padding:21px 22px}
.pp-panel h3{font-size:16px;margin:0 0 18px}
.pp-barchart{height:170px;display:flex;align-items:flex-end;justify-content:space-around;gap:12px;padding:10px 5px 0;border-bottom:1px solid var(--pp-line);
  background:repeating-linear-gradient(to bottom,transparent 0,transparent 41px,var(--pp-line) 42px,var(--pp-line) 43px)}
.pp-barcol{height:100%;flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:8px;min-width:0}
.pp-bar{width:min(30px,70%);border-radius:7px 7px 2px 2px;background:linear-gradient(180deg,#f58b7e,#ef5f51);min-height:3px}
.pp-barcol span{font-size:11px;color:var(--pp-muted);white-space:nowrap}
.pp-hourlist{display:grid;gap:17px}
.pp-hourrow{display:grid;grid-template-columns:92px 1fr 48px;gap:12px;align-items:center;font-size:12px}
.pp-hourrow .pp-track{height:8px}
/* ---- v0.6.1 骨架屏 / 空态 / 成就 / 快捷键 ---- */
.pp-skel{display:inline-block;height:12px;border-radius:6px;background:linear-gradient(90deg,var(--pp-line) 25%,#f6f1ec 37%,var(--pp-line) 63%);background-size:400% 100%;animation:pp-shimmer 1.4s ease infinite}
@keyframes pp-shimmer{0%{background-position:100% 0}100%{background-position:-100% 0}}
.pp-skel-block{border-radius:10px}
.pp-empty{display:grid;place-items:center;gap:6px;padding:24px 16px;color:var(--pp-muted);font-size:12.5px;text-align:center}
.pp-empty b{font-size:13px;color:var(--pp-ink);font-weight:650}
.pp-empty button{margin-top:2px}
.pp-achv{margin-top:18px;padding:18px 20px}
.pp-achv-head{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.pp-achv-head h3{font-size:15px;margin:0;font-weight:700;display:flex;align-items:center;gap:8px}
.pp-achv-prog{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--pp-muted);font-variant-numeric:tabular-nums}
.pp-achv-bar{width:120px;height:6px;border-radius:99px;background:var(--pp-line);overflow:hidden}
.pp-achv-bar>i{display:block;height:100%;background:linear-gradient(90deg,#f7a05c,#ef5f51);border-radius:99px;transition:width .3s}
.pp-achv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.pp-achv-chip{display:flex;align-items:center;gap:8px;border:1px solid var(--pp-line);border-radius:11px;padding:8px 10px;font-size:12px;color:var(--pp-ink);background:var(--pp-paper);min-width:0}
.pp-achv-chip .medal{font-size:14px;line-height:1;filter:grayscale(1) opacity(.5)}
.pp-achv-chip b{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-achv-chip small{margin-left:auto;font-size:10.5px;color:var(--pp-muted);white-space:nowrap}
.pp-achv-chip.on{border-color:var(--rc);background:var(--rs)}
.pp-achv-chip.on .medal{filter:none}
.pp-achv-chip.on small{color:var(--rc)}
.pp-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border:1px solid var(--pp-line);border-bottom-width:2px;border-radius:6px;background:var(--pp-bg);font-size:11.5px;font-weight:650;color:var(--pp-ink);font-family:ui-monospace,monospace}
.pp-shortcut-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px dashed var(--pp-line);font-size:13px}
.pp-shortcut-row:last-of-type{border-bottom:0}
.pp-shortcut-row span.keys{display:flex;gap:6px;align-items:center}
.pp-shortcut-row span.desc{color:var(--pp-muted)}
.pp-insight{margin-top:17px;padding:13px 14px;border-radius:12px;background:var(--pp-red-soft);color:#a94d43;font-size:12px;line-height:1.7}
/* ---- settings ---- */
/* ---- 设置页 (v0.6: 双列紧凑卡片) ---- */
.pp-settings{display:grid;grid-template-columns:minmax(0,1.06fr) minmax(0,.94fr);gap:18px;align-items:start;max-width:1180px;margin:4px auto 0}
.pp-setcol{display:grid;gap:16px;align-content:start}
.pp-setcard{padding:0 0 4px}
.pp-sethead{display:flex;align-items:center;gap:8px;padding:14px 18px 6px}
.pp-sethead h3{margin:0;font-size:14px;font-weight:700}
.pp-seticon{font-size:14px;line-height:1}
.pp-setrow2{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:9px 18px;min-height:50px}
.pp-setrow2+.pp-setrow2{border-top:1px solid var(--pp-line)}
.pp-slabel{display:grid;gap:2px;min-width:0}
.pp-slabel b{font-size:13.5px;font-weight:600;color:var(--pp-ink)}
.pp-slabel small{font-size:11.5px;color:var(--pp-muted);line-height:1.35}
.pp-sctrl{display:flex;align-items:center;gap:8px;flex-shrink:0}
.pp-step{display:inline-flex;align-items:center;background:var(--pp-bg);border:1px solid var(--pp-line);border-radius:999px;padding:2px}
.pp-step button{width:26px;height:26px;border:0;background:transparent;color:var(--pp-red-dark);font-size:15px;font-weight:700;border-radius:50%;display:grid;place-items:center;cursor:pointer;line-height:1}
.pp-step button:hover:not(:disabled){background:var(--pp-paper)}
.pp-step button:disabled{color:#cfc8c1;cursor:not-allowed}
.pp-step input{width:42px;border:0;background:transparent;text-align:center;font-size:13.5px;font-weight:650;color:var(--pp-ink);
  font-variant-numeric:tabular-nums;appearance:textfield;font-family:inherit}
.pp-step input:focus{outline:none;color:var(--pp-red-dark)}
.pp-step input:hover{color:var(--pp-red-dark)}
.pp-step input::-webkit-outer-spin-button,.pp-step input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.pp-step .pp-unit{font-size:11.5px;color:var(--pp-muted);padding-right:8px}
.pp-switch{width:42px;height:24px;border-radius:999px;border:0;background:#ded8d2;position:relative;cursor:pointer;padding:0;transition:background .18s}
.pp-switch[aria-checked="true"]{background:linear-gradient(180deg,#5ebd7c,#43a463)}
.pp-switch span{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.22);transition:left .18s cubic-bezier(.34,1.56,.64,1)}
.pp-switch[aria-checked="true"] span{left:20px}
.pp-range{width:150px;accent-color:var(--pp-red);cursor:pointer}
.pp-sval{min-width:44px;text-align:right;font-size:12.5px;color:var(--pp-muted);font-variant-numeric:tabular-nums}
.pp-select{appearance:none;border:1px solid var(--pp-line);background:var(--pp-paper);border-radius:10px;padding:7px 26px 7px 10px;font-size:12.5px;color:var(--pp-ink);max-width:200px;
  background-image:linear-gradient(45deg,transparent 50%,#9aa0a6 50%),linear-gradient(135deg,#9aa0a6 50%,transparent 50%);
  background-position:calc(100% - 14px) calc(50% - 2px),calc(100% - 9px) calc(50% - 2px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;cursor:pointer}
.pp-sbtn{border:1px solid var(--pp-line);background:var(--pp-paper);border-radius:999px;padding:6px 13px;font-size:12px;color:var(--pp-ink);cursor:pointer;white-space:nowrap;transition:border-color .15s,background .15s}
.pp-sbtn:hover{border-color:#e0d6cc;background:var(--pp-bg)}
.pp-sstatus{font-size:11.5px;font-weight:600}
.pp-sstatus.ok{color:#328b50}.pp-sstatus.warn{color:#c78116}.pp-sstatus.muted{color:var(--pp-muted)}
.pp-setfoot{grid-column:1/-1;display:flex;align-items:center;gap:8px;padding:2px 4px 6px}
.pp-auditbox{background:var(--pp-paper);border:1px solid var(--pp-line);border-radius:14px;padding:14px;font-size:12px;max-height:260px;overflow:auto;margin-bottom:14px}
/* ---- settlement ---- */
/* 桌宠浮层: 紧凑胶囊 (v0.5.2) */
.pp-petpill{display:flex;align-items:center;gap:6px;background:var(--pp-paper);border:1px solid var(--pp-line);
  border-radius:999px;padding:3px 6px 3px 4px;box-shadow:var(--pp-shadow);cursor:grab}
.pp-petpill .pp-pettime{font-size:11.5px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--pp-ink);min-width:34px;text-align:center}
.pp-petpill .pp-petctl{display:flex;gap:1px;margin-left:2px;max-width:0;overflow:hidden;opacity:0;transition:max-width .22s ease,opacity .15s ease}
.pp-petpill:hover .pp-petctl,.pp-petpill:focus-within .pp-petctl{max-width:132px;opacity:1}
.pp-petctl button{border:0;background:transparent;color:var(--pp-muted);width:21px;height:21px;border-radius:50%;
  font-size:10.5px;line-height:1;display:grid;place-items:center;cursor:pointer;transition:background .15s,color .15s}
.pp-petctl button:hover{background:var(--pp-bg);color:var(--pp-ink)}
.pp-petdot-wrap{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;cursor:pointer;
  background:var(--pp-paper);border:1px solid var(--pp-line);box-shadow:var(--pp-shadow);transition:transform .15s,box-shadow .15s}
.pp-petdot-wrap:hover{transform:scale(1.08);box-shadow:0 6px 18px rgba(241,95,80,.22)}
.pp-petdot{width:14px;height:14px;border-radius:50%;background:var(--pp-red);opacity:.92}
.pp-petdot-wrap:focus-visible{outline:2px solid var(--pp-red);outline-offset:2px}
/* ---- v0.8 Agent 联动 ---- */
.pp-context{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;align-items:center}
.pp-ctag{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--pp-line);background:var(--pp-paper);color:var(--pp-ink);border-radius:999px;padding:5px 11px;font-size:12px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pp-ctag-session{max-width:320px}
.pp-ctag-sub{color:var(--pp-muted);font-size:11px}
.pp-ctag-agent.on{border-color:#cdd6f5;background:#f2f4fe;color:#3d55b8}
:root[data-pp-theme="dark"] .pp-ctag-agent.on{border-color:#3a4670;background:#242a44;color:#c9d2ff}
.pp-agent-dot{width:7px;height:7px;border-radius:50%;background:#c9c2bb;display:inline-block;flex-shrink:0}
.pp-agent-dot.on{background:#5b76d6;box-shadow:0 0 0 3px rgba(91,118,214,.18);animation:pp-agent-pulse 1.8s ease-in-out infinite}
@keyframes pp-agent-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.pp-agent-mini{display:inline-flex;align-items:center;gap:5px}
.pp-agent-thought{position:absolute;top:6px;right:26px;font-size:11px;letter-spacing:2px;color:#5b76d6;opacity:.9;animation:pp-agent-think 1.6s ease-in-out infinite}
.pp-agent-thought.pill{position:absolute;right:6px;top:2px;font-size:10px;letter-spacing:1px}
@keyframes pp-agent-think{0%,100%{transform:translateY(0);opacity:.55}50%{transform:translateY(-2px);opacity:1}}
/* ---- v0.8.3 Agent 卡片（按会话 / 工作区技能） ---- */
.pp-agentgrid{display:grid;grid-template-columns:1.25fr .78fr;gap:18px;margin-top:18px;align-items:start}
.pp-agentgrid.single{grid-template-columns:1fr}
.pp-agentcard{display:flex;flex-direction:column;min-width:0;padding:18px 20px 14px}
.pp-agentcard-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:12px}
.pp-agentcard-head h3{margin:0;font-size:15px;letter-spacing:-.2px}
.pp-agentcard-sum{font-size:11.5px;color:var(--pp-muted);font-variant-numeric:tabular-nums}
.pp-agentcard-note{margin:10px 0 0;font-size:11px;color:var(--pp-muted)}
.pp-agentcard .pp-sharebar{margin:0 -8px 12px}
.pp-sharebar{display:flex;height:7px;border-radius:99px;overflow:hidden;background:var(--pp-line);margin:2px 0 12px}
.pp-sharebar>i{display:block;height:100%;transition:width .3s}
.pp-sesslist{display:grid}
.pp-sessrow{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:10px;
  padding:9px 8px;margin:0 -8px;border-radius:10px;border-bottom:1px solid var(--pp-line);cursor:default}
.pp-sessrow:last-child{border-bottom:0}
.pp-sessrow:hover{background:var(--pp-gray-soft)}
.pp-sessavatar{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff}
.pp-sessmain{min-width:0;display:grid;gap:2px}
.pp-sessmain b{font-size:12.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-sessmain span{font-size:11px;color:var(--pp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-sesstime{font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--pp-ink);text-align:right}
.pp-skilllist{display:grid;gap:2px}
.pp-skillrow{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:9px;
  padding:7px 8px;margin:0 -8px;border:0;border-radius:10px;background:transparent;cursor:pointer;text-align:left;
  font-family:inherit;color:var(--pp-ink)}
.pp-skillrow:hover{background:var(--pp-gray-soft)}
.pp-skillrow:focus-visible{outline:2px solid var(--pp-red);outline-offset:2px}
.pp-skillicon{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:var(--pp-green-soft);font-size:12px}
.pp-skillmain{min-width:0;display:grid;gap:1px}
.pp-skillmain b{font-size:12px;font-weight:650;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-skillmain small{font-size:10.5px;color:var(--pp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pp-skillact{font-size:10.5px;font-weight:650;color:var(--pp-red-dark);background:var(--pp-red-soft);
  border-radius:999px;padding:3px 9px;white-space:nowrap}
.pp-skillact.done{background:var(--pp-green-soft);color:#328b50}
@media (max-width: 980px){.pp-agentgrid{grid-template-columns:1fr}}
@media (max-width: 720px){
  .pp-agentcard{padding:14px 14px 12px}
  .pp-context{gap:6px}
  .pp-ctag{max-width:220px}
}
/* ---- v0.8.1 桌宠互动（连击/粒子/气泡语气） ---- */
.pp-pet-bubble{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);white-space:nowrap;
  font-size:12px;color:var(--pp-ink);background:var(--pp-paper);border:1px solid var(--pp-line);border-radius:999px;
  padding:4px 11px;box-shadow:var(--pp-shadow);animation:pp-bubble-in .25s ease-out;z-index:6}
.pp-pet-bubble.warn{border-color:#f0c894;background:#fff6e8;color:#8a5a1f}
.pp-pet-bubble.rare{border-color:#f2d47f;background:linear-gradient(100deg,#fffdf5,#fff2cf);color:#7a5a12;font-weight:650;
  box-shadow:0 6px 18px rgba(216,166,56,.24)}
.pp-pet-bounce .pp-pet{animation:pp-pop .55s cubic-bezier(.34,1.56,.64,1) !important}
.pp-heart{position:absolute;bottom:8px;left:50%;font-size:13px;pointer-events:none;z-index:5;opacity:0;
  animation:pp-heart-float 1.15s ease-out forwards}
@keyframes pp-heart-float{0%{opacity:0;transform:translate(-50%,4px) scale(.6)}
  18%{opacity:1}100%{opacity:0;transform:translate(calc(-50% + var(--dx,0px)),-52px) scale(1.15)}}
:root[data-pp-theme="dark"] .pp-pet-bubble.warn{border-color:#5e4a30;background:#332a1f;color:#f0d6a8}
:root[data-pp-theme="dark"] .pp-pet-bubble.rare{border-color:#5c4c28;background:linear-gradient(100deg,#2f2820,#3a2f1c);color:#f5dd9e;
  box-shadow:0 6px 18px rgba(0,0,0,.34)}
/* ---- 宠物动效 (v0.7) ---- */
.pp-pet{overflow:visible}
.pp-pet-idle{animation:pp-breathe 3.6s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 85%}
.pp-pet-focus{animation:pp-bob 2.6s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 85%}
.pp-pet-break{animation:pp-bounce 1.5s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 85%}
.pp-pet-waiting{animation:pp-tilt 3.2s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 90%}
.pp-pet-sleep{animation:pp-breathe 5.2s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 85%}
.pp-pet-sad{animation:pp-sway 5s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 90%}
.pp-pet-pop{animation:pp-pop .55s cubic-bezier(.34,1.56,.64,1) !important}
.pp-eye{transform-box:fill-box;transform-origin:center;animation:pp-blink 5.4s infinite}
.pp-leaf-sway{transform-box:fill-box;transform-origin:20% 100%;animation:pp-sway 4.2s ease-in-out infinite}
.pp-pet-glow{animation:pp-glow 3.4s ease-in-out infinite}
@keyframes pp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.028)}}
@keyframes pp-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.4px)}}
@keyframes pp-bounce{0%,100%{transform:translateY(0) scale(1)}28%{transform:translateY(-5px) scale(1.04)}58%{transform:translateY(0) scale(.985)}}
@keyframes pp-tilt{0%,100%{transform:rotate(0)}30%{transform:rotate(-3.5deg)}70%{transform:rotate(3.5deg)}}
@keyframes pp-sway{0%,100%{transform:rotate(-1.6deg)}50%{transform:rotate(1.6deg)}}
@keyframes pp-blink{0%,92%,100%{transform:scaleY(1)}95.5%{transform:scaleY(.08)}}
@keyframes pp-glow{0%,100%{opacity:.35}50%{opacity:.75}}
@keyframes pp-pop{0%{transform:scale(1)}35%{transform:scale(1.16) rotate(-3deg)}70%{transform:scale(.96)}100%{transform:scale(1)}}
/* 宠物气泡（点击反应） */
.pp-pet-bubble{position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;
  font-size:12px;color:var(--pp-ink);background:var(--pp-paper);border:1px solid var(--pp-line);border-radius:999px;
  padding:4px 11px;box-shadow:var(--pp-shadow);animation:pp-bubble-in .25s ease-out;z-index:3}
@keyframes pp-bubble-in{from{opacity:0;transform:translate(-50%,4px) scale(.94)}to{opacity:1;transform:translate(-50%,0) scale(1)}}
.pp-pet-live{position:relative;cursor:pointer;border-radius:50%}
.pp-pet-live:hover{filter:brightness(1.04)}
.pp-pet-live:focus-visible{outline:2px solid var(--pp-red);outline-offset:6px}
/* ---- 装扮弹窗 (v0.7) ---- */
.pp-outfit-modal{width:min(100%,520px)}
.pp-outfit-stage{position:relative;display:grid;place-items:center;padding:20px 0 12px;border-radius:16px;
  background:radial-gradient(ellipse at 50% 60%,rgba(241,95,80,.10),transparent 64%),var(--pp-bg);margin:0 0 14px}
.pp-outfit-stage-glow{position:absolute;width:170px;height:170px;border-radius:50%;
  background:radial-gradient(circle,rgba(241,95,80,.16),transparent 70%)}
.pp-outfit-spark{position:absolute;color:#f2b25c;opacity:.8;animation:pp-float 3.4s ease-in-out infinite}
.pp-outfit-spark.s1{top:18px;left:22%;font-size:16px}
.pp-outfit-spark.s2{top:34px;right:20%;font-size:13px;animation-delay:.6s}
.pp-outfit-spark.s3{bottom:16px;left:32%;font-size:12px;animation-delay:1.2s}
.pp-outfit-stage-pet{position:relative;z-index:1;display:block;animation:pp-breathe 3.6s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 85%}
.pp-outfit-stage-name{margin-top:8px;display:grid;place-items:center;gap:2px;font-size:14.5px;font-weight:700;position:relative;z-index:1}
.pp-outfit-stage-name small{font-size:11.5px;color:var(--pp-muted);font-weight:400}
.pp-outfit-picker{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.pp-outfit-thumb{position:relative;display:grid;justify-items:center;gap:4px;padding:10px 6px 8px;border:1px solid var(--pp-line);
  border-radius:13px;background:var(--pp-paper);cursor:pointer;transition:border-color .15s,transform .15s,box-shadow .15s;
  font-family:inherit;color:var(--pp-ink)}
.pp-outfit-thumb:hover{transform:translateY(-1px);border-color:#e6ddd3}
.pp-outfit-thumb.active{border-color:var(--pp-red);box-shadow:0 0 0 2px rgba(241,95,80,.14)}
.pp-outfit-thumb.current{border-color:#4ba66a}
.pp-outfit-thumb b{font-size:11.5px}
.pp-outfit-art{display:grid;place-items:center;width:52px;height:52px}
.pp-outfit-badge{position:absolute;top:4px;right:4px;font-size:9.5px;background:var(--pp-gray-soft);color:var(--pp-muted);border-radius:999px;padding:1px 6px}
.pp-outfit-badge.sel{background:var(--pp-red-soft);color:var(--pp-red-dark)}
.pp-outfit-progress{margin-top:14px;padding:2px 2px 0}
.pp-outfit-progress-head{display:flex;justify-content:space-between;font-size:12px;color:var(--pp-muted);margin-bottom:6px}
.pp-outfit-progress-head b{color:var(--pp-ink);font-variant-numeric:tabular-nums}
.pp-outfit-bar{height:7px;border-radius:99px;background:var(--pp-line);overflow:hidden}
.pp-outfit-bar>i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#f7a05c,#ef5f51);transition:width .3s}
.pp-outfit-progress small{display:block;margin-top:6px;font-size:11.5px;color:var(--pp-muted)}
.pp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.pp-btn-primary{border:0;border-radius:999px;padding:9px 18px;font-size:12.5px;font-weight:650;color:#fff;cursor:pointer;
  background:linear-gradient(100deg,#f46859,#e95448);box-shadow:0 6px 14px rgba(241,95,80,.18)}
.pp-btn-primary:disabled{background:var(--pp-line);color:var(--pp-muted);cursor:not-allowed;box-shadow:none}
:root[data-pp-theme="dark"] .pp-outfit-thumb:hover{border-color:#4a423d}
:root[data-pp-theme="dark"] .pp-outfit-stage{background:radial-gradient(ellipse at 50% 60%,rgba(241,95,80,.16),transparent 66%),var(--pp-bg)}
.pp-settle-back{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);backdrop-filter:blur(4px)}
.pp-settle{width:360px;max-width:92vw;border-radius:20px;padding:24px;text-align:center;background:var(--pp-paper);box-shadow:0 12px 32px rgba(0,0,0,.12)}
/* ---- responsive ---- */
:root[data-pp-theme="dark"] .pp-hero{background:radial-gradient(ellipse at 20% 90%,rgba(120,86,48,.30) 0,transparent 42%),linear-gradient(180deg,#2a2522,#241f1c)}
:root[data-pp-theme="dark"] .pp-mode[aria-pressed="true"]{border-color:#8a4a42}
:root[data-pp-theme="dark"] .pp-switch:not([aria-checked="true"]){background:#4a423d}
:root[data-pp-theme="dark"] .pp-switch span{background:#f4efe9}
:root[data-pp-theme="dark"] .pp-step button:disabled{color:#5c544e}
:root[data-pp-theme="dark"] .pp-task:hover{border-color:#4a423d}
:root[data-pp-theme="dark"] .pp-drophint{border-color:#4a423d;color:var(--pp-muted)}
:root[data-pp-theme="dark"] .pp-insight{color:#e8a49b}
:root[data-pp-theme="dark"] .pp-skel{background:linear-gradient(90deg,#332e2a 25%,#3d3733 37%,#332e2a 63%);background-size:400% 100%}
:root[data-pp-theme="dark"] .pp-heatcell:hover{outline-color:#8a4a42}
:root[data-pp-theme="dark"] .pp-dist-chip:hover{border-color:var(--qc)}
:root[data-pp-theme="dark"] .pp-petdot-wrap{background:var(--pp-paper)}
@media(max-width:1150px){
  .pp-header{grid-template-columns:auto 1fr auto;gap:10px}
  .pp-nav button{min-width:auto;padding:11px 12px}
  .pp-grid{grid-template-columns:1fr}
  .pp-settings{grid-template-columns:1fr}
  .pp-statcards{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pp-statslower{grid-template-columns:1fr}
}
@media(max-width:760px){
  .pp-app main{padding:6px 16px 30px}
  .pp-header{height:auto;min-height:70px;grid-template-columns:1fr auto;gap:8px;padding:12px 0 10px}
  .pp-brand strong{font-size:15px}.pp-brand small{display:none}
  .pp-logo{width:34px;height:34px}
  .pp-nav{grid-column:1/-1;grid-row:2;justify-content:stretch;gap:4px}
  .pp-nav button{flex:1;min-width:0;padding:9px 4px;font-size:12px;gap:5px}
  .pp-profile{grid-column:2;grid-row:1}
  .pp-profile small{display:none}
  .pp-pagehead{align-items:flex-start;flex-direction:column;margin:17px 0 14px}
  .pp-pagehead h1{font-size:24px}
  .pp-statcards{gap:9px}.pp-statcard{padding:14px}.pp-statvalue{font-size:24px;margin:10px 0 5px}
  .pp-hero{margin:0 15px 14px;padding:10px 12px;min-height:220px;grid-template-columns:.8fr 1fr}
  .pp-hero-art{height:190px}
  .pp-ringbox{width:min(100%,180px)}.pp-time{font-size:35px}.pp-caption{font-size:12px}
  .pp-modes{margin:0 15px 14px;gap:5px}
  .pp-taskselect{margin:0 15px 14px;width:calc(100% - 30px)}
  .pp-primaryrow{padding:0 15px 17px;gap:8px}.pp-startbtn{font-size:14px;padding:13px 10px}
  .pp-tasklist{padding:0 12px}.pp-addtask{width:calc(100% - 24px);margin:11px 12px 14px}
  .pp-filters{padding:4px 12px 0}.pp-qhead{padding:0 12px}.pp-proposalcard{margin:0 12px 12px}
  .pp-task{grid-template-columns:4px 22px minmax(0,1fr) 16px;padding-right:8px}
  .pp-petcontent{grid-template-columns:110px minmax(0,1fr);padding:6px 13px 14px}
  .pp-dist{margin-top:14px;padding:12px 14px 10px}
  .pp-dist-chip{padding:4px 10px;font-size:12px}
  .pp-settings{grid-template-columns:1fr}
  .pp-setrow2{padding:9px 14px;gap:10px}
  .pp-range{width:110px}
}
@media(prefers-reduced-motion:reduce){
  .pp-app *,.pp-pet-host *{animation:none!important;transition:none!important}
}
`
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(PP_STYLE_ID)) return
      const el = document.createElement('style')
      el.id = PP_STYLE_ID
      el.textContent = PP_CSS
      document.head.append(el)
    }
    /** 面板/弹窗共用的暖色 UI 原子样式（v0.5） */
    const UI = {
      primaryBtn: (extra) => ({ background: 'linear-gradient(100deg,#f46859,#e95448)', color: '#fff', border: 'none', borderRadius: 99, fontWeight: 700, padding: '11px 18px', ...extra }),
      ghostBtn: (extra) => ({ background: 'var(--pp-paper)', color: 'var(--pp-ink)', border: '1px solid var(--pp-line)', borderRadius: 99, padding: '9px 16px', ...extra }),
      chip: (active, color, soft) => ({
        border: `1px solid ${active ? color : 'var(--pp-line)'}`, borderRadius: 99, padding: '5px 13px',
        fontSize: 13, background: active ? (soft ?? color) : 'var(--pp-paper)', color: active ? color : 'var(--pp-ink)',
        fontWeight: active ? 650 : 400,
      }),
    }

    /* ---------------- browser notifications (background reminders) ----- */

    async function ensureNotifyPermission() {
      if (typeof Notification === 'undefined') return 'denied'
      if (Notification.permission === 'granted' || Notification.permission === 'denied') return Notification.permission
      try { return await Notification.requestPermission() } catch { return 'denied' }
    }
    function notifyPhase(kind) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      const body = {
        'focus-done': '🍅 专注完成!休息一下,精灵在撒欢',
        'break-done': '⏰ 休息结束啦,回来看看我呀!',
        evolve: '🎉 精灵进化了!快去看看它',
      }[kind]
      if (!body) return
      try { new Notification('番茄钟宠物', { body, tag: `pomodoro-${kind}` }) } catch { /* notification API unavailable */ }
    }

    /* ---------------- audio: WebAudio chimes, zero assets (§14) -------- */
    let audioCtx
    function chime(kind, volume = 0.6) {
      try {
        audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)()
        if (audioCtx.state === 'suspended') void audioCtx.resume()
        const t0 = audioCtx.currentTime
        const notes = kind === 'evolve' ? [523, 659, 784, 1047]
          : kind === 'levelup' ? [523, 659, 784, 1047, 1319]
          : kind === 'achievement' ? [784, 1047]
          : kind === 'focus-done' ? [523, 659, 784]
          : kind === 'greet' ? [988]
          : [659, 784]
        const gap = kind === 'achievement' ? 0.3 : 0.14
        notes.forEach((freq, i) => {
          const osc = audioCtx.createOscillator()
          const gain = audioCtx.createGain()
          osc.type = kind === 'achievement' ? 'triangle' : 'sine'
          osc.frequency.value = freq
          const at = t0 + i * gap
          gain.gain.setValueAtTime(0.0001, at)
          gain.gain.exponentialRampToValueAtTime(0.18 * Math.max(0, Math.min(1, volume)), at + 0.02)
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35)
          osc.connect(gain).connect(audioCtx.destination)
          osc.start(at); osc.stop(at + 0.4)
        })
      } catch { /* audio unavailable — silent degrade */ }
    }

    /** Watch snapshot transitions; fire chime + notification on phase flips. */
    function usePhaseFx(snap) {
      const prev = React.useRef(null)
      React.useEffect(() => {
        if (!snap) return
        const key = (s) => s?.running ? `${s.running.status}:${s.pet.stage}` : `idle:${s.pet.stage}`
        const nowKey = key(snap)
        const before = prev.current
        prev.current = nowKey
        if (!before || before === nowKey) return
        const [statusBefore, stageBefore] = before.split(':')
        const [statusNow, stageNow] = nowKey.split(':')
        if (stageBefore !== stageNow) {
          if (snap.settings.soundEnabled !== false) chime('evolve', snap.settings.volume ?? 0.6)
          if (snap.settings.notificationEnabled !== false) notifyPhase('evolve')
          return
        }
        if (statusNow === 'break' || statusNow === 'longBreak') {
          if (snap.settings.soundEnabled !== false) chime('focus-done', snap.settings.volume ?? 0.6)
          if (snap.settings.notificationEnabled !== false) notifyPhase('focus-done')
        } else if (statusNow === 'waiting' && (statusBefore === 'break' || statusBefore === 'longBreak')) {
          if (snap.settings.soundEnabled !== false) chime('break-done', snap.settings.volume ?? 0.6)
          if (snap.settings.notificationEnabled !== false) notifyPhase('break-done')
        }
      }, [snap?.running?.status, snap?.pet?.stage])
    }

    /* ---------------- pet art (SVG stages) ---------------- */
    /** v0.6.3 装扮（与 pet-engine REDEEM_OUTFIT 的 4 件一一对应, 10 碎片/件）。 */
    const OUTFITS = [
      { id: 'leaf-crown', name: '叶冠', icon: '🍃', desc: '头顶三片嫩叶' },
      { id: 'blush-sticker', name: '腮红贴纸', icon: '✨', desc: '脸颊星星贴纸' },
      { id: 'halo-pendant', name: '光环吊坠', icon: '😇', desc: '头顶金色小光环' },
      { id: 'crown-outline', name: '王冠轮廓', icon: '👑', desc: '金色王冠描边' },
    ]
    const nextOutfitId = (cur) => {
      const i = OUTFITS.findIndex(o => o.id === cur)
      return OUTFITS[(i + 1) % OUTFITS.length].id
    }
    let ppSvgSeq = 0
    /** 宠物表情/姿态 v0.7：渐变身体 + 高光大眼 + 眨眼/呼吸/弹跳动效 + 视线跟随 + 装扮。 */
    function petSvg(stage, mood, runningStatus, size = 56, outfitId = null, gaze = null) {
      const uid = `ppp${++ppSvgSeq}`
      const palettes = {
        sprout: { light: '#b7e3a8', base: '#7dbb6a', dark: '#4c8f3f', leaf: '#3d8b40', leafLight: '#6bbf5f', blush: '#ffd0c4' },
        fruit: { light: '#f78f7f', base: '#e74c3c', dark: '#b42f20', leaf: '#2f9e50', leafLight: '#63c877', blush: '#ffb3a7' },
        glow: { light: '#fbc26d', base: '#e67e22', dark: '#b35f11', leaf: '#2f9e50', leafLight: '#63c877', blush: '#ffd7a8' },
        rainbow: { light: '#ffcf6b', base: '#e74c3c', dark: '#b42f20', leaf: '#2f9e50', leafLight: '#63c877', blush: '#ffb3a7' },
      }
      const c = palettes[stage] ?? palettes.fruit
      const focus = runningStatus === 'focus'
      const paused = runningStatus === 'paused'
      const breakTime = runningStatus === 'break' || runningStatus === 'longBreak'
      const waiting = runningStatus === 'waiting'
      const gx = (gaze?.x ?? 0) * 1.8
      const gy = (gaze?.y ?? 0) * 1.5
      // 动效 class：专注轻浮、休息弹跳、waiting 歪头、暂停/低落缓慢、空闲呼吸
      const anim = breakTime ? 'pp-pet-break'
        : waiting ? 'pp-pet-waiting'
          : focus ? 'pp-pet-focus'
            : paused ? 'pp-pet-sleep'
              : (mood <= 1 ? 'pp-pet-sad' : 'pp-pet-idle')

      // ---- 眼睛 ----
      const eyeOpen = !focus && !paused && mood > 1
      const eyes = eyeOpen
        ? h('g', { className: 'pp-eye' },
            h('ellipse', { cx: 25, cy: 34.5, rx: 3.6, ry: 4.2, fill: '#2c3e50' }),
            h('ellipse', { cx: 39, cy: 34.5, rx: 3.6, ry: 4.2, fill: '#2c3e50' }),
            h('circle', { cx: 25 + gx - 1.1, cy: 34.5 + gy - 1.6, r: 1.5, fill: '#fff' }),
            h('circle', { cx: 39 + gx - 1.1, cy: 34.5 + gy - 1.6, r: 1.5, fill: '#fff' }),
            h('circle', { cx: 25 + gx + 1.2, cy: 34.5 + gy + 1.6, r: .7, fill: '#fff', opacity: .8 }),
            h('circle', { cx: 39 + gx + 1.2, cy: 34.5 + gy + 1.6, r: .7, fill: '#fff', opacity: .8 }))
        : focus
          ? h('g', { className: 'pp-eye' },
              h('path', { d: 'M21.5 35 q3.5 3.2 7 0', stroke: '#2c3e50', strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' }),
              h('path', { d: 'M35.5 35 q3.5 3.2 7 0', stroke: '#2c3e50', strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' }))
          : h('g', { className: 'pp-eye' }, // 暂停/低落：半闭眼
              h('path', { d: 'M21.5 35.5 q3.5 2 7 0', stroke: '#2c3e50', strokeWidth: 2.1, fill: 'none', strokeLinecap: 'round' }),
              h('path', { d: 'M35.5 35.5 q3.5 2 7 0', stroke: '#2c3e50', strokeWidth: 2.1, fill: 'none', strokeLinecap: 'round' }))

      // ---- 眉毛（情绪） ----
      const brows = mood <= 1
        ? h('g', { opacity: .8 },
            h('path', { d: 'M21 29.5 l6 -1.6', stroke: '#8e3b2f', strokeWidth: 1.6, strokeLinecap: 'round' }),
            h('path', { d: 'M43 29.5 l-6 -1.6', stroke: '#8e3b2f', strokeWidth: 1.6, strokeLinecap: 'round' }))
        : mood >= 4
          ? h('g', { opacity: .75 },
              h('path', { d: 'M21.5 28.5 q3.5 -2.4 6.5 -.4', stroke: '#8e3b2f', strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' }),
              h('path', { d: 'M36 28.1 q3 -2 6.5 .4', stroke: '#8e3b2f', strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' }))
          : null

      // ---- 嘴 ----
      const mouth = breakTime
        ? h('g', null,
            h('path', { d: 'M27.5 42.5 q4.5 5 9 0 z', fill: '#c0392b', stroke: '#a93226', strokeWidth: .8, strokeLinejoin: 'round' }),
            h('ellipse', { cx: 32, cy: 45.6, rx: 2.2, ry: 1.3, fill: '#f7a1a1' }))
        : focus
          ? h('ellipse', { cx: 32, cy: 44.5, rx: 1.7, ry: 2.1, fill: '#c0392b' })
          : mood <= 1
            ? h('path', { d: 'M28 46 q4 -3 8 0', stroke: '#b03a2e', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' })
            : mood >= 4
              ? h('path', { d: 'M27.5 42.5 q4.5 6 9 0', stroke: '#b03a2e', strokeWidth: 2.1, fill: 'none', strokeLinecap: 'round' })
              : h('path', { d: 'M28.5 43.5 q3.5 3.4 7 0', stroke: '#b03a2e', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' })

      const glowRing = stage === 'glow' || stage === 'rainbow'
      return h('svg', {
        viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true,
        className: `pp-pet ${anim}`,
      },
        h('defs', null,
          h('radialGradient', { id: `${uid}b`, cx: '34%', cy: '26%', r: '78%' },
            h('stop', { offset: '0%', stopColor: c.light }),
            h('stop', { offset: '58%', stopColor: c.base }),
            h('stop', { offset: '100%', stopColor: c.dark })),
          h('linearGradient', { id: `${uid}l`, x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0%', stopColor: c.leafLight }),
            h('stop', { offset: '100%', stopColor: c.leaf })),
          h('linearGradient', { id: `${uid}g`, x1: '0', y1: '0', x2: '1', y2: '0' },
            h('stop', { offset: '0%', stopColor: '#ffe9a3' }),
            h('stop', { offset: '50%', stopColor: '#f1c40f' }),
            h('stop', { offset: '100%', stopColor: '#e0a92a' }))),
        // 发光果/彩虹王：柔光
        glowRing && h('circle', { cx: 32, cy: 37, r: 27.5, fill: 'none', stroke: stage === 'glow' ? '#f9d976' : '#c39be8', strokeWidth: 2, opacity: .55, className: 'pp-pet-glow' }),
        // ---- 装扮 ----
        outfitId === 'leaf-crown' && h('g', null,
          h('path', { d: 'M22 13 q9 -5 20 0', stroke: '#4c8f3f', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
          h('path', { d: 'M25 12 q-4 -8 1.5 -11 q5 5 3.5 11 z', fill: `url(#${uid}l)`, stroke: '#3d8b40', strokeWidth: .9 }),
          h('path', { d: 'M31.5 10 q-2 -9 5 -11 q4.5 6 1.5 11 z', fill: `url(#${uid}l)`, stroke: '#3d8b40', strokeWidth: .9 }),
          h('path', { d: 'M39 12 q-1 -8 5 -9 q2.5 6 -1.5 10 z', fill: `url(#${uid}l)`, stroke: '#3d8b40', strokeWidth: .9 }),
          h('path', { d: 'M26.5 4.5 L28 9.5', stroke: '#d9f0cf', strokeWidth: .7, opacity: .8 }),
          h('path', { d: 'M34 3 L35.6 8.2', stroke: '#d9f0cf', strokeWidth: .7, opacity: .8 })),
        outfitId === 'halo-pendant' && h('g', null,
          h('ellipse', { cx: 32, cy: 7.5, rx: 11, ry: 3.6, fill: 'none', stroke: '#f7d86b', strokeWidth: 3.2, opacity: .35 }),
          h('ellipse', { cx: 32, cy: 7.5, rx: 10, ry: 3.2, fill: 'none', stroke: `url(#${uid}g)`, strokeWidth: 2.2 }),
          h('circle', { cx: 20, cy: 6, r: 1, fill: '#fff3b0' }),
          h('circle', { cx: 45, cy: 8, r: .8, fill: '#fff3b0' })),
        outfitId === 'crown-outline' && h('g', null,
          h('path', { d: 'M22 13 L22 4.5 L27.5 9 L32 2.5 L36.5 9 L42 4.5 L42 13 Z', fill: 'rgba(241,196,15,.16)', stroke: '#f1c40f', strokeWidth: 2, strokeLinejoin: 'round' }),
          h('circle', { cx: 32, cy: 9.6, r: 1.5, fill: '#f7d86b' }),
          h('circle', { cx: 26.4, cy: 10.4, r: 1, fill: '#f7d86b' }),
          h('circle', { cx: 37.6, cy: 10.4, r: 1, fill: '#f7d86b' })),
        // ---- 头顶茎叶 ----
        h('g', { className: 'pp-leaf-sway' },
          h('path', { d: 'M32 17 C31 12 33 9.5 40 8.5', stroke: '#2f8f43', strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' }),
          h('path', { d: 'M35 11.6 C38 6.4 46 6 49.6 8.6 C46.6 13.6 38.6 14.4 35 11.6 Z', fill: `url(#${uid}l)`, stroke: '#2f8f43', strokeWidth: .8 }),
          h('path', { d: 'M37.5 11 L47 9.2', stroke: '#e3f6d8', strokeWidth: .8, opacity: .8 }),
          h('path', { d: 'M29.6 12.4 C27 8.6 20.6 8.8 18.6 11.8 C21.8 15.4 27.8 15.2 29.6 12.4 Z', fill: `url(#${uid}l)`, stroke: '#2f8f43', strokeWidth: .8, opacity: .92 })),
        // ---- 身体 ----
        h('circle', { cx: 32, cy: 37, r: 21, fill: `url(#${uid}b)` }),
        h('circle', { cx: 32, cy: 37, r: 21, fill: 'none', stroke: 'rgba(0,0,0,.07)', strokeWidth: 1 }),
        h('ellipse', { cx: 24.5, cy: 28.5, rx: 8.4, ry: 5.6, fill: '#fff', opacity: .22, transform: 'rotate(-24 24.5 28.5)' }),
        h('path', { d: 'M14.5 42.5 C18 51 25 57 32 57 C39 57 46.5 51.5 49.5 43', stroke: 'rgba(0,0,0,.10)', strokeWidth: 2.6, fill: 'none', strokeLinecap: 'round' }),
        // ---- 腮红 ----
        h('ellipse', { cx: 19, cy: 41.5, rx: 3.4, ry: 2.4, fill: c.blush, opacity: .6 }),
        h('ellipse', { cx: 45, cy: 41.5, rx: 3.4, ry: 2.4, fill: c.blush, opacity: .6 }),
        // 腮红贴纸画在脸颊之上（否则会被身体遮挡）
        outfitId === 'blush-sticker' && h('g', null,
          h('path', { d: 'M19 40.5 l1.5 3.4 3.6 .5 -2.6 2.5 .6 3.6 -3.1 -1.8 -3.1 1.8 .6 -3.6 -2.6 -2.5 3.6 -.5 z', fill: '#f8d24b', stroke: '#e0a92a', strokeWidth: .7 }),
          h('path', { d: 'M45 40.5 l1.5 3.4 3.6 .5 -2.6 2.5 .6 3.6 -3.1 -1.8 -3.1 1.8 .6 -3.6 -2.6 -2.5 3.6 -.5 z', fill: '#f8d24b', stroke: '#e0a92a', strokeWidth: .7 }),
          h('circle', { cx: 13, cy: 31, r: 1.1, fill: '#ffe9a3' }),
          h('circle', { cx: 51, cy: 32, r: 1.4, fill: '#ffe9a3' })),
        brows, eyes, mouth,
      )
    }
    /** 阶段中文 key（渲染时经 trStage() 翻译）。 */
    const STAGE_TEXT = { sprout: '青芽', fruit: '红果', glow: '发光果', rainbow: '彩虹王' }
    const stageName = (s) => STAGE_TEXT[s] ?? s
    const statusLabel = (s) => ({
      idle: '空闲 — 开始一个番茄钟吧', focus: '专注中,精灵陪你打坐', paused: '已暂停,时间冻结',
      break: '短休中,撒欢一下', longBreak: '长休中,好好放松', waiting: '休息结束,确认后开始下一轮',
    }[s] ?? '')

    /* ---------------- API helper ---------------- */
    const jsonFetch = (url, opts) => fetch(url, opts).then(r => r.json())
    const api = {
      state: () => jsonFetch('/dsh-pomodoro/state'),
      action: (action, extra) => jsonFetch('/dsh-pomodoro/action', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(extra ?? {}) }),
      }),
      settings: (patch) => jsonFetch('/dsh-pomodoro/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      }),
      heatmap: (year) => jsonFetch(`/dsh-pomodoro/heatmap?year=${year}`),
      trend: (weeks) => jsonFetch(`/dsh-pomodoro/trend?weeks=${weeks}`),
      quadrants: () => jsonFetch('/dsh-pomodoro/quadrants'),
      hours: () => jsonFetch('/dsh-pomodoro/hours'),
      days: (n) => jsonFetch(`/dsh-pomodoro/days?days=${n ?? 180}`),
      sessions: (n) => jsonFetch(`/dsh-pomodoro/sessions?days=${n ?? 90}`),
      report: (period) => jsonFetch(`/dsh-pomodoro/report?period=${period}`),
      achievements: () => jsonFetch('/dsh-pomodoro/achievements'),
      audit: () => jsonFetch('/dsh-pomodoro/audit'),
      taskCreate: (payload) => jsonFetch('/dsh-pomodoro/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
      }),
      taskPatch: (id, patch) => jsonFetch(`/dsh-pomodoro/tasks?id=${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
      }),
      taskDelete: (id) => jsonFetch(`/dsh-pomodoro/tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
      groupCreate: (name) => jsonFetch('/dsh-pomodoro/groups', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
      }),
      proposal: (id, verb) => jsonFetch(`/dsh-pomodoro/proposals?id=${encodeURIComponent(id)}&verb=${verb}`, { method: 'POST' }),
    }

    /* ---------------- shared snapshot: SSE push + poll fallback ------- */

    const snapshotStore = { snap: null, listeners: new Set(), offset: 0 }
    let eventSource
    function emitSnapshot(snap) {
      // serverNow 校时 (§11.2): offset = serverNow - Date.now()。
      if (snap?.serverNow != null) snapshotStore.offset = snap.serverNow - Date.now()
      // animationEnabled 同步（§13.6 设置开关即时生效, 与 reduced-motion 双闸门）
      if (snap?.settings && 'animationEnabled' in snap.settings) setAnimationsEnabled(snap.settings.animationEnabled)
      snapshotStore.snap = snap
      for (const fn of snapshotStore.listeners) fn(snap)
    }
    const serverNow = () => Date.now() + (snapshotStore.offset ?? 0)
    function openEvents() {
      if (eventSource) return
      try {
        eventSource = new EventSource('/dsh-pomodoro/events')
        eventSource.addEventListener('snapshot', e => {
          try { emitSnapshot(JSON.parse(e.data)) } catch { /* malformed frame */ }
        })
        eventSource.addEventListener('agent', e => {
          try { emitAgentCtx(JSON.parse(e.data)) } catch { /* malformed frame */ }
        })
        eventSource.onerror = () => { /* browser auto-reconnects; poll covers the gap */ }
      } catch { /* EventSource unavailable — polling only */ }
    }
    function closeEvents() {
      if (!eventSource) return
      try { eventSource.close() } catch { /* already closed */ }
      eventSource = undefined
    }
    function manageEventsByVisibility() {
      if (typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        openEvents()
        void api.state().then(r => { if (r.ok) emitSnapshot(r.snapshot) }).catch(() => {})
      } else {
        closeEvents()
      }
    }

    function useSnapshot() {
      const [snap, setSnap] = React.useState(snapshotStore.snap)
      const refresh = React.useCallback(async () => {
        try { const r = await api.state(); if (r.ok) emitSnapshot(r.snapshot) } catch { /* host unreachable */ }
      }, [])
      React.useEffect(() => {
        snapshotStore.listeners.add(setSnap)
        manageEventsByVisibility()
        document.addEventListener('visibilitychange', manageEventsByVisibility)
        if (!snapshotStore.snap) void refresh()
        const id = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh()
        }, 30_000)
        return () => {
          snapshotStore.listeners.delete(setSnap)
          clearInterval(id)
          document.removeEventListener('visibilitychange', manageEventsByVisibility)
          if (snapshotStore.listeners.size === 0) closeEvents()
        }
      }, [refresh])
      return { snap, refresh }
    }

    /* ---------------- v0.8 DSH Agent 联动（会话 / Agent 动态 / 技能） ---- */

    const agentCtxStore = { ctx: null, listeners: new Set() }
    function emitAgentCtx(ctx) {
      if (!ctx || ctx.ok === false) return
      const prev = agentCtxStore.ctx
      const next = { ...ctx }
      // SSE `agent` 帧不带技能目录（轻量）: 沿用上一次同工作区的技能快照
      if (next.skills === undefined && prev?.skills
        && (next.session?.cwd ?? null) === (prev.session?.cwd ?? null)) {
        next.skills = prev.skills
      }
      agentCtxStore.ctx = next
      for (const fn of [...agentCtxStore.listeners]) fn(next)
    }
    async function fetchAgentContext() {
      try {
        const res = await fetch('/dsh-pomodoro/context', { headers: { accept: 'application/json' } })
        if (!res.ok) return
        emitAgentCtx(await res.json())
      } catch { /* host unreachable — sections stay hidden */ }
    }
    function useAgentContext() {
      const [ctx, setCtx] = React.useState(agentCtxStore.ctx)
      React.useEffect(() => {
        agentCtxStore.listeners.add(setCtx)
        if (!agentCtxStore.ctx) void fetchAgentContext()
        const id = setInterval(() => {
          if (document.visibilityState === 'visible') void fetchAgentContext()
        }, 60_000)
        return () => { agentCtxStore.listeners.delete(setCtx); clearInterval(id) }
      }, [])
      return ctx
    }

    /** 本地展示偏好（设备级 localStorage, 与主题一致不走 Host 设置）。 */
    const PREF_DEFAULTS = { showAgent: true, showContext: true }
    const readPrefs = () => {
      const read = (key, dflt) => {
        try { const v = localStorage.getItem(key); return v == null ? dflt : v === '1' } catch { return dflt }
      }
      return { showAgent: read('pp-show-agent', PREF_DEFAULTS.showAgent), showContext: read('pp-show-context', PREF_DEFAULTS.showContext) }
    }
    const prefsStore = { value: readPrefs(), listeners: new Set() }
    function setPref(name, on) {
      if (!(name in prefsStore.value)) return
      prefsStore.value = { ...prefsStore.value, [name]: !!on }
      try { localStorage.setItem(name === 'showAgent' ? 'pp-show-agent' : 'pp-show-context', on ? '1' : '0') } catch { /* private mode */ }
      for (const fn of [...prefsStore.listeners]) fn(prefsStore.value)
    }
    function usePrefs() {
      const [prefs, setState] = React.useState(prefsStore.value)
      React.useEffect(() => {
        prefsStore.listeners.add(setState)
        return () => { prefsStore.listeners.delete(setState) }
      }, [])
      return prefs
    }

    const TOOL_ICON = {
      bash: '🖥️', terminal: '🖥️', read: '📄', read_file: '📄', write: '✍️', edit: '✏️',
      grep: '🔍', glob: '📂', web_search: '🌐', web_fetch: '🌐', task: '🤖', subagent: '🤖',
      workflow: '🧩', skill: '🎓', job: '⏱️', jobs: '⏱️', todo: '📋', memory: '🧠', default: '🔧',
    }
    const toolIcon = (name) => TOOL_ICON[String(name ?? '').toLowerCase()] ?? TOOL_ICON.default
    const agentToolLine = (agent) => {
      const t = agent?.lastTools?.[0]
      if (!t) return null
      return `${toolIcon(t.name)} ${t.name}${t.ok ? '' : ' ✗'}`
    }

    /** 会话 / 工作区 / Agent 状态条（focus 页顶部）。 */
    function ContextBar({ context, showContext, showAgent }) {
      const session = context?.session
      const agent = context?.agent
      const hasAgent = showAgent && agent && (agent.running || (agent.today?.tools ?? 0) > 0)
      if (!session && !hasAgent) return null
      const label = session?.label || (session?.id ? `会话 ${String(session.id).slice(0, 8)}` : null)
      return h('div', { className: 'pp-context', 'aria-label': '工作上下文' },
        showContext && session?.cwdName && h('span', { className: 'pp-ctag', title: session.cwd ?? '' },
          h('span', { 'aria-hidden': true }, '📁'), session.cwdName),
        showContext && label && h('span', { className: 'pp-ctag pp-ctag-session', title: '最近活跃会话（启发式）' },
          h('span', { 'aria-hidden': true }, '💬'), label),
        hasAgent && h('span', {
          className: `pp-ctag pp-ctag-agent${agent.running ? ' on' : ''}`,
          title: 'DSH Agent 当前活动',
        },
          h('span', { className: 'pp-agent-dot', 'aria-hidden': true }),
          agent.running ? 'Agent 运行中' : 'AI 空闲',
          h('span', { className: 'pp-ctag-sub' }, `今日 ${agent.today?.tools ?? 0} 工具`)),
      )
    }

    /** Live remaining ms, interpolated with the serverNow offset (§11.2). */
    function useRemaining(snap, refresh) {
      const [, tick] = React.useReducer(n => n + 1, 0)
      const r = snap?.running
      // waiting（endsAt 已过期、无时钟）与 paused（endsAt=null 冻结）不需要过期检查——
      // 否则会变成每 1.5s 一次的无限 refresh 循环（打爆 GUI/网络）。
      const expirable = !!r && r.endsAt != null
        && ['focus', 'break', 'longBreak'].includes(r.status)
      React.useEffect(() => {
        if (!r) return
        const id = setInterval(tick, 1000)
        const check = expirable
          ? setInterval(() => {
              if (snap.running?.endsAt != null && snap.running.endsAt <= serverNow()) void refresh()
            }, 1500)
          : null
        return () => { clearInterval(id); if (check) clearInterval(check) }
      }, [r?.id, r?.revision, expirable, refresh])
      if (!r) return null
      return r.endsAt != null ? Math.max(0, r.endsAt - serverNow()) : (r.remainingMs ?? 0)
    }

    const fmt = (ms) => {
      const s = Math.ceil(ms / 1000)
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }
    const fmtClock = (ms) => {
      const s = Math.ceil(ms / 1000)
      return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    }

    /* ---------------- v0.5 shared presentational helpers ---------------- */
    const WEEKDAYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    /** 'YYYY-MM-DD' → 「周日，10月18日」/「Sun, Oct 18」（随界面语言）。 */
    const fmtDateZh = (iso) => {
      if (!iso) return ''
      const [y, m, d] = iso.split('-').map(Number)
      if (!y || !m || !d) return iso
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
      if (i18nStore.locale !== 'zh') {
        try {
          return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(i18nStore.locale, {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
          })
        } catch { /* fall through to zh */ }
      }
      return `${tr(WEEKDAYS_ZH[dow])}，${trf('{m}月{d}日', { m: String(m), d: String(d) })}`
    }
    /** 四象限常量（暖色系, §6.1 色值替换为设计稿色板）。 */
    const QUAD_STYLE = {
      A: { color: '#f15f50', soft: 'var(--pp-red-soft)', icon: '♨', label: '紧急重要' },
      B: { color: '#f5ae42', soft: 'var(--pp-orange-soft)', icon: '★', label: '重要不紧急' },
      C: { color: '#4599e8', soft: 'var(--pp-blue-soft)', icon: 'ϟ', label: '紧急不重要' },
      D: { color: '#4ba66a', soft: 'var(--pp-green-soft)', icon: '❧', label: '其他' },
    }
    const qColor = (q) => QUAD_STYLE[q]?.color ?? '#9aa0a6'
    /** 预估 EXP 曲线：needFor(lv)=30+lv*20（pet-engine §7.1, 仅展示）。 */
    const needFor = (lv) => 30 + lv * 20
    const MOOD_TEXT = ['很低落', '有点蔫', '平静', '不错', '开心', '超开心']
    /* ---- v0.8.1 桌宠互动台词（按状态/心情分组, 连点彩蛋） ---- */
    const PET_TALK = {
      idle: ['陪我待会儿？', '要不要开始一个番茄？', '今天也一起加油', '伸个懒腰，准备开工',
        '我在这儿陪着你', '摸鱼一会儿也没关系', '戳我一下试试？'],
      focus: ['嘘——我在打坐，别打扰', '认真专注中，看我！', '别看我，看任务', '专注的时候我最亮',
        '这一轮我们一起加油', '时间在走，我陪着你'],
      break: ['休息一下，伸个懒腰', '喝口水吧', '陪我跳一跳？', '休息也是正经事', '眼睛也歇一会儿'],
      waiting: ['休息好啦，要开始下一轮吗？', '我准备好了，你呢？', '直接开始，还是再歇会儿？'],
      paused: ['时间被我冻住啦', '暂停中，慢慢来', '想歇就歇，我等你', '进度条在原地等你'],
      low: ['有点累了…', '摸摸头会好一点', '今天已经做得很好了', '要不要休息一下？', '我陪你一起难过一小会儿'],
      rare: ['✨ 今天也辛苦了，偷偷给你加个光环', '🍅 连点我有惊喜哦', '✨ 你专注的样子最好看',
        '🌟 好运分你一半', '🍀 今天也会是好日子'],
      poke: ['嗯？', '怎么啦', '嘿~', '我在呢', '戳我干嘛呀'],
    }
    /** 按当前状态挑一组台词（低落优先, 暂停/专注/休息/等待次之）。 */
    function petTalkPool({ status, paused, mood } = {}) {
      if ((mood ?? 3) <= 1) return PET_TALK.low
      if (paused) return PET_TALK.paused
      if (status === 'focus') return PET_TALK.focus
      if (status === 'break' || status === 'longBreak') return PET_TALK.break
      if (status === 'waiting') return PET_TALK.waiting
      return PET_TALK.idle
    }
    /** 随机取一条, 尽量不与上一条重复。 */
    function pickTalkLine(pool, last) {
      if (!pool?.length) return ''
      let line = pool[Math.floor(Math.random() * pool.length)]
      for (let i = 0; i < 6 && line === last && pool.length > 1; i++) {
        line = pool[Math.floor(Math.random() * pool.length)]
      }
      return line
    }
    /** 爱心/星星粒子（双击互动反馈）。 */
    function makeParticles(n, rare) {
      const icons = rare ? ['✨', '💫', '🌟', '♥'] : ['♥', '❤', '✨', '🍅']
      return Array.from({ length: n }, (_, i) => ({
        id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        icon: icons[Math.floor(Math.random() * icons.length)],
        dx: Math.round(Math.random() * 100 - 50),
        delay: Math.round(Math.random() * 140),
      }))
    }

    /** 热力图 5 档色（§8.2, v0.5 设计稿色板）。 */
    const HEAT5 = ['#f0eeea', '#fbd4ce', '#f6a69b', '#f27668', '#dc4d42']

    /* ---------------- shared UI atoms (v0.4 retained for settings) ---------------- */
    const row = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }
    const card = { background: 'var(--pp-paper)', borderRadius: 12, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
    const mainBtn = (color) => ({
      padding: '8px 20px', borderRadius: 10, cursor: 'pointer', fontSize: 15, fontFamily: FONT,
      border: '1px solid var(--pp-line)', background: 'var(--pp-paper)', color: 'var(--pp-ink)',
    })
    const accentBtn = (color = '#f15f50') => ({
      ...mainBtn(color), background: color, color: '#fff', fontWeight: 600,
    })
    const pill = (active, color = '#f15f50') => ({
      padding: '5px 14px', borderRadius: 16, fontSize: 13, cursor: 'pointer', fontFamily: FONT,
      border: `1px solid ${active ? color : 'var(--pp-line)'}`,
      background: active ? color : 'var(--pp-paper)', color: active ? '#fff' : 'var(--pp-ink)', fontWeight: active ? 600 : 400,
    })
    const inputStyle = {
      width: 72, padding: '5px 8px', borderRadius: 10, border: '1px solid var(--pp-line)',
      background: 'var(--pp-paper)', color: 'var(--pp-ink)', fontFamily: FONT, fontSize: 14,
    }
    /** 装扮弹窗（v0.7）：大预览舞台 + 缩略选择 + 碎片进度条。 */
    function OutfitModal({ snap, refresh, onClose }) {
      const frag = snap.inventory?.dress_fragment?.count ?? 0
      const current = snap.pet.outfitId ?? null
      const [sel, setSel] = React.useState(nextOutfitId(current))
      const [busy, setBusy] = React.useState(false)
      const enough = frag >= 10
      const selObj = OUTFITS.find(o => o.id === sel) ?? OUTFITS[0]

      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])

      const redeem = () => {
        if (!enough || busy) return
        setBusy(true)
        void api.action('redeemOutfit', { itemId: sel }).then(res => {
          setBusy(false)
          if (!res.ok) {
            alert(res.code === 'limit_exceeded' ? '碎片不足，10 个碎片兑 1 件装扮' : '兑换失败，请重试')
            return
          }
          refresh()
          onClose()
        }).catch(() => { setBusy(false); alert('兑换失败，请重试') })
      }

      const spark = (cls, ch) => h('span', { className: `pp-outfit-spark ${cls}`, 'aria-hidden': true }, ch)
      const stage = h('div', { className: 'pp-outfit-stage' },
        h('span', { className: 'pp-outfit-stage-glow', 'aria-hidden': true }),
        spark('s1', '✦'), spark('s2', '✧'), spark('s3', '✦'),
        h('span', { className: 'pp-outfit-stage-pet', 'aria-hidden': true },
          petSvg(snap.pet.stage, Math.max(3, snap.pet.mood ?? 3), null, 148, sel)),
        h('div', { className: 'pp-outfit-stage-name' },
          h('span', null, selObj.name),
          h('small', null, selObj.desc)))

      const picker = h('div', { className: 'pp-outfit-picker', role: 'radiogroup', 'aria-label': '选择装扮' },
        OUTFITS.map(o => {
          const isSel = sel === o.id
          const isCur = current === o.id
          const cls = `pp-outfit-thumb${isSel ? ' active' : ''}${isCur ? ' current' : ''}`
          return h('button', {
            key: o.id, type: 'button', role: 'radio', 'aria-checked': isSel,
            className: cls, title: o.desc, onClick: () => setSel(o.id),
          },
            h('span', { className: 'pp-outfit-art', 'aria-hidden': true },
              petSvg(snap.pet.stage, Math.max(3, snap.pet.mood ?? 3), null, 46, o.id)),
            h('b', null, o.name),
            isCur && h('span', { className: 'pp-outfit-badge' }, '当前'),
            isSel && !isCur && h('span', { className: 'pp-outfit-badge sel' }, '选'))
        }))

      const progress = h('div', { className: 'pp-outfit-progress' },
        h('div', { className: 'pp-outfit-progress-head' },
          h('span', null, '装扮碎片'),
          h('b', null, `${frag} / 10`)),
        h('div', {
          className: 'pp-outfit-bar', role: 'progressbar',
          'aria-valuenow': Math.min(10, frag), 'aria-valuemin': 0, 'aria-valuemax': 10,
          'aria-label': `装扮碎片 ${frag}/10`,
        }, h('i', { style: { width: `${Math.min(100, frag / 10 * 100)}%` } })),
        h('small', null, enough ? '已足够兑换 1 件装扮' : `再收集 ${10 - frag} 个碎片即可兑换`))

      const redeemBtn = h('button', {
        type: 'button', className: 'pp-btn-primary', disabled: !enough || busy, onClick: redeem,
      }, enough ? (busy ? '兑换中…' : '兑换装扮（10 碎片）') : `还差 ${10 - frag} 个碎片`)

      const actions = h('div', { className: 'pp-modal-actions' },
        h('button', { type: 'button', className: 'pp-secondarybtn', onClick: onClose }, '关闭'),
        redeemBtn)

      const card = h('div', {
        className: 'pp-modal pp-outfit-modal', onClick: e => e.stopPropagation(),
      },
        h('h2', null, '🎀　自定义装扮'),
        stage, picker, progress, actions)

      return h('div', {
        className: 'pp-backdrop', role: 'dialog', 'aria-modal': true,
        'aria-label': '自定义装扮', onClick: onClose,
      }, card)
    }

    /* ---------------- 结算面板 (§8.1) ---------------- */

    const SEEN_KEY = 'pp-seen-settlement'
    function SettlementOverlay({ snap, refresh, onClose }) {
      const settleTheme = useTheme()
      const [shown, setShown] = React.useState(0)
      const s = snap.lastSettlement
      const items = s ? [
        { text: `🍅 本次专注 ${fmt((s.focusMinutes ?? 25) * 60_000)}`, big: true },
        s.taskTitle && { text: `「${s.taskTitle}」`, sub: true },
        { text: `+${s.expGained} EXP`, color: '#df4e42', big: true },
        { text: `🔥 连续 ${s.streak} 天`, color: '#c78116' },
        ...(s.leveledUp ? [{ text: `⬆️ 升到 Lv.${s.level}!`, color: '#328b50', big: true }] : []),
        ...(s.achievements ?? []).map(a => ({ text: `🏅 解锁成就「${a.name}」`, color: '#8E44AD' })),
        ...(Number(s.agentToolCount) > 0 ? [{
          text: `🤖 专注期间 Agent 执行 ${s.agentToolCount} 次工具`,
          color: '#5b76d6', sub: true,
        }] : []),
      ].filter(Boolean) : []
      React.useEffect(() => {
        if (items.length === 0 || reduceMotion()) { setShown(items.length); return }
        const timers = items.map((_, i) => setTimeout(() => setShown(i + 1), 250 * (i + 1)))
        return () => timers.forEach(clearTimeout)
      }, [s?.id])
      if (!s) return null
      const petLine = Number(s.agentToolCount) > 0
        ? '你专注的时候，Agent 也没闲着 🤝'
        : ({ sprout: '又一个!我们好棒', fruit: '收获满满,继续加油', glow: '你专注的样子在发光', rainbow: '王者之路,由番茄铺成' }[snap.pet.stage] ?? '干得漂亮!')
      return h('div', {
        role: 'dialog', 'aria-label': '结算面板', onClick: onClose, className: 'pp-pet-host', 'data-theme': settleTheme.effective,
        style: {
          position: 'fixed', inset: 0, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)',
        },
      },
        h('div', {
          onClick: e => e.stopPropagation(),
          className: 'pp-settle',
          style: {
            transform: reduceMotion() ? 'none' : `scale(${shown >= 1 ? 1 : 0.6})`, opacity: shown >= 1 ? 1 : 0,
            transition: `transform 400ms ${EASE_BACK}, opacity 250ms ease`,
          },
        },
          petSvg(snap.pet.stage, snap.pet.mood, null, 64, snap.pet.outfitId),
          h('div', { style: { margin: '12px 0', display: 'grid', gap: 6 } },
            items.map((it, i) => h('div', {
              key: i,
              style: {
                fontSize: it.big ? 24 : it.sub ? 14 : 17, fontWeight: 600, color: it.color ?? 'var(--pp-ink)',
                opacity: shown > i ? 1 : 0, transform: shown > i || reduceMotion() ? 'none' : 'translateY(8px)',
                transition: `all 300ms ${EASE_BACK}`,
              },
            }, it.text))),
          h('div', { style: { fontSize: 13, color: 'var(--pp-muted)', marginBottom: 16 } }, petLine),
          h('div', { style: { display: 'flex', gap: 8, justifyContent: 'center' } },
            h('button', { type: 'button', onClick: onClose, style: UI.ghostBtn() }, '继续'),
            h('button', {
              type: 'button', style: UI.primaryBtn(),
              onClick: () => { onClose(); void api.action('start').then(res => { if (!res.ok && res.code === 'busy') alert('已有进行中的番茄钟'); return res }).then(refresh) },
            }, '再来一个'),
          ),
        ),
      )
    }

    /** 结算去重 (§8.1): id 变化且未看过（localStorage seenSettlementId）才弹。 */
    function useSettlement(snap, refresh) {
      const [openId, setOpenId] = React.useState(null)
      React.useEffect(() => {
        const s = snap?.lastSettlement
        if (!s?.id) return
        let seen = null
        try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') } catch { /* corrupt */ }
        if (seen?.id === s.id) return
        if (s.ts != null && Date.now() - s.ts > 5 * 60_000) {
          try { localStorage.setItem(SEEN_KEY, JSON.stringify({ id: s.id })) } catch { /* storage full */ }
          return
        }
        setOpenId(s.id)
      }, [snap?.lastSettlement?.id])
      const close = React.useCallback(() => {
        const s = snap?.lastSettlement
        if (s?.id) { try { localStorage.setItem(SEEN_KEY, JSON.stringify({ id: s.id })) } catch { /* storage full */ } }
        setOpenId(null)
      }, [snap?.lastSettlement?.id])
      return { openId, close }
    }

    /* ---------------- Desktop pet (shell.overlay) ---------------- */
    function PetOverlay() {
      ensureStyles()
      const theme = useTheme()
      const { snap, refresh } = useSnapshot()
      const remaining = useRemaining(snap, refresh)
      usePhaseFx(snap)
      const { openId, close } = useSettlement(snap, refresh)
      const [pos, setPos] = React.useState(() => {
        try { return JSON.parse(localStorage.getItem('pp-pet-pos') ?? 'null') ?? { x: null, y: null } } catch { return { x: null, y: null } }
      })
      // 收纳状态持久化（刷新后保持）; 收纳后必须能点开恢复
      const [collapsed, setCollapsed] = React.useState(() => {
        try { return localStorage.getItem('pp-pet-collapsed') === '1' } catch { return false }
      })
      const drag = React.useRef(null)
      // 双击宠物 = 打招呼（§12.1）。hooks 必须在下方 if (!snap) 早退之前声明,
      // 否则首帧(null)与有数据帧的 hook 数不一致 → React #310。
      const [petBubble, setPetBubble] = React.useState(null)
      const bubbleTimer = React.useRef(null)
      // v0.8.1 互动：气泡语气 / 连击 / 粒子 / 弹跳
      const [bubbleTone, setBubbleTone] = React.useState('normal')
      const [particles, setParticles] = React.useState([])
      const [popAt, setPopAt] = React.useState(0)
      const lastLine = React.useRef('')
      const comboRef = React.useRef({ n: 0, at: 0 })
      const lastPokeAt = React.useRef(0)
      const didDrag = React.useRef(false)
      const didCollapseClick = React.useRef(false)
      const clickTimer = React.useRef(null)
      // v0.8: 桌宠也是 Agent 活动的小看板（工具气泡节流 2.5s）
      const agentCtx = useAgentContext()
      const prefs = usePrefs()
      const lastAgentTool = agentCtx?.agent?.lastTools?.[0] ?? null
      const toolSeenAt = React.useRef(0)
      const lastToolBubbleAt = React.useRef(0)
      const heroLastLine = React.useRef('')

      const PET_W = 178, PET_H = 44 // 胶囊尺寸（收纳时也能落回同一边界, 不跳动）
      const clamp = (x, y) => ({
        x: Math.max(8, Math.min(window.innerWidth - PET_W, x)),
        y: Math.max(8, Math.min(window.innerHeight - PET_H, y)),
      })
      React.useEffect(() => {
        if (pos.x == null) setPos({ x: window.innerWidth - PET_W - 12, y: window.innerHeight - PET_H - 16 })
      }, [])
      React.useEffect(() => () => { clearTimeout(clickTimer.current) }, [])
      /** 收纳/展开唯一入口: 持久化 + 展开时把胶囊拉回边界内（收纳时是 26px 圆点, 原位置可能贴边）。 */
      const toggleCollapsed = (next) => {
        setCollapsed(next)
        try { localStorage.setItem('pp-pet-collapsed', next ? '1' : '0') } catch { /* storage full */ }
        if (!next) setPos(p => clamp(p.x, p.y))
      }

      const onPointerDown = (e) => {
        drag.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onPointerMove = (e) => {
        if (!drag.current) return
        const dx = e.clientX - drag.current.sx, dy = e.clientY - drag.current.sy
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.current.moved = true
        if (drag.current.moved) setPos(clamp(drag.current.ox + dx, drag.current.oy + dy))
      }
      const onPointerUp = () => {
        const moved = drag.current?.moved
        didDrag.current = !!moved
        didCollapseClick.current = false
        if (moved) {
          const { x, y } = clamp(pos.x, pos.y)
          setPos({ x, y })
          try { localStorage.setItem('pp-pet-pos', JSON.stringify({ x, y })) } catch { /* storage full */ }
        }
        drag.current = null
        // 单击（未拖动）= 展开收纳的小圆点（收纳态唯一的恢复入口）
        if (!moved && collapsed) { didCollapseClick.current = true; toggleCollapsed(false) }
      }
      const onKey = (e) => {
        const step = e.shiftKey ? 32 : 8
        if (e.key === 'ArrowLeft') { setPos(p => clamp(p.x - step, p.y)); e.preventDefault() }
        else if (e.key === 'ArrowRight') { setPos(p => clamp(p.x + step, p.y)); e.preventDefault() }
        else if (e.key === 'ArrowUp') { setPos(p => clamp(p.x, p.y - step)); e.preventDefault() }
        else if (e.key === 'ArrowDown') { setPos(p => clamp(p.x, p.y + step)); e.preventDefault() }
        else if (e.key === 'Enter' || e.key === ' ') { toggleCollapsed(!collapsed); e.preventDefault() }
        else if (e.key === 'Escape') { toggleCollapsed(true) }
      }

      // Agent 跑完工具 → 桌宠冒工具气泡（节流 2.5s; 设置里可关）
      React.useEffect(() => {
        if (!prefs.showAgent || !lastAgentTool?.at) return
        if (lastAgentTool.at <= toolSeenAt.current) return
        toolSeenAt.current = lastAgentTool.at
        const t = Date.now()
        if (t - lastToolBubbleAt.current < 2500) return
        lastToolBubbleAt.current = t
        setPetBubble(`${toolIcon(lastAgentTool.name)} ${lastAgentTool.name}${lastAgentTool.ok ? '' : ' ✗'}`)
        clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setPetBubble(null), 2200)
      }, [lastAgentTool?.at, prefs.showAgent])

      if (!snap) return null
      const r = snap.running
      const status = r?.status
      const busy = status === 'focus' || status === 'break' || status === 'longBreak'
      const scale = Math.max(0.5, Math.min(2, Number(snap.settings.petScale) || 1))
      // §4.1 不变式: 已暂停 = endsAt==null && remainingMs!=null（引擎 PAUSE 不改 status）
      const pausedNow = !!r && r.endsAt == null && r.remainingMs != null
      const stateText = r
        ? (pausedNow ? `已暂停,剩余 ${fmt(remaining ?? 0)}` : status === 'focus' ? `专注中,剩余 ${fmt(remaining ?? 0)}` : status === 'waiting' ? '休息结束,等你确认' : '休息中')
        : `空闲,Lv.${snap.pet.level}`
      const label = collapsed
        ? `番茄精灵:已收纳（${stateText}） — 点击或按 Enter 展开`
        : `番茄精灵:${stateText} — 按 Enter 收纳,Escape 收纳`
      /* ---- 互动 v0.8.1 ---- */
      const say = (text, tone = 'normal', hold = 2600) => {
        setBubbleTone(tone)
        setPetBubble(text)
        clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setPetBubble(null), hold)
      }
      const spawnParticles = (n, rare = false) => {
        const list = makeParticles(n, rare)
        setParticles(prev => [...prev, ...list].slice(-18))
        setTimeout(() => {
          setParticles(prev => {
            const ids = new Set(list.map(p => p.id))
            return prev.filter(p => !ids.has(p.id))
          })
        }, 1400)
      }
      // 双击 = 互动：连击递进 + 粒子 + 弹跳 + 音效 + 偶发彩蛋
      const greet = () => {
        const t = Date.now()
        const combo = comboRef.current
        combo.n = (t - combo.at <= 1800) ? combo.n + 1 : 1
        combo.at = t
        setPopAt(t)
        if (snap.settings.soundEnabled !== false) chime('greet', Number(snap.settings.volume) || 0.5)
        const pool = petTalkPool({ status, paused: pausedNow, mood: snap.pet.mood })
        let line = ''
        let tone = 'normal'
        let hold = 2800
        if (combo.n === 1) {
          const egg = Math.random() < 0.12
          line = pickTalkLine(egg ? PET_TALK.rare : pool, lastLine.current)
          if (egg) { tone = 'rare'; spawnParticles(8, true) } else spawnParticles(5)
        } else if (combo.n === 2) {
          line = '再戳就生气了！'; tone = 'warn'; spawnParticles(3)
        } else if (combo.n === 3) {
          line = '好吧好吧，给你看个宝贝 ✨'; tone = 'rare'; hold = 3200; spawnParticles(10, true)
        } else {
          line = '呜呜，别戳啦…'; spawnParticles(2); combo.n = 3
        }
        lastLine.current = line
        say(line, tone, hold)
      }
      // 单击 = 小声回应（延时 220ms, 双击会取消；拖动/收纳点击不触发）
      const onPetClick = () => {
        if (didDrag.current || didCollapseClick.current || collapsed) return
        clearTimeout(clickTimer.current)
        clickTimer.current = setTimeout(() => {
          const t = Date.now()
          if (t - lastPokeAt.current < 900) return
          lastPokeAt.current = t
          setPopAt(t)
          spawnParticles(2)
          const line = pickTalkLine(PET_TALK.poke, lastLine.current)
          lastLine.current = line
          say(line, 'normal', 1600)
        }, 220)
      }
      const onPetDoubleClick = (e) => {
        e.stopPropagation()
        clearTimeout(clickTimer.current)
        if (collapsed) { toggleCollapsed(false); return }
        greet()
      }

      const ctl = (label, text, onClick) => h('button', {
        type: 'button', 'aria-label': label,
        onPointerDown: e => e.stopPropagation(),
        onClick: e => { e.stopPropagation(); onClick() },
      }, text)

      return h('div', { className: 'pp-pet-host', 'data-theme': theme.effective, style: { position: 'fixed', left: pos.x, top: pos.y, zIndex: 40, touchAction: 'none' } },
        // petBubble 挂在最外层 fixed 容器, absolute 相对它定位（气泡 top:-30 在胶囊上方）
        h('div', {
          role: 'button', tabIndex: 0, 'aria-label': label, 'aria-live': 'polite',
          onPointerDown, onPointerMove, onPointerUp, onKeyDown: onKey,
          onClick: onPetClick, onDoubleClick: onPetDoubleClick,
          className: collapsed
            ? 'pp-petdot-wrap'
            : `pp-petpill${Date.now() - popAt < 620 ? ' pp-pet-bounce' : ''}`,
          title: collapsed ? '点击展开番茄精灵' : '拖动移动 · 单击回应 · 双击互动（连点有惊喜）',
          style: collapsed
            ? { position: 'relative' }
            : { position: 'relative', cursor: 'grab', outline: 'none' },
          onFocus: e => { e.currentTarget.style.boxShadow = '0 0 0 2px #f15f50' },
          onBlur: e => { e.currentTarget.style.boxShadow = '' },
        },
          petBubble && h('div', {
            className: `pp-pet-bubble${bubbleTone !== 'normal' ? ` ${bubbleTone}` : ''}`,
            role: 'status',
          }, petBubble),
          // 粒子（爱心/星星）在胶囊之上飘散
          particles.map(p => h('span', {
            key: p.id, className: 'pp-heart', 'aria-hidden': true,
            style: { left: `calc(50% + ${p.dx}px)`, animationDelay: `${p.delay}ms` },
          }, p.icon)),
          collapsed
            ? h('span', { className: 'pp-petdot', 'aria-hidden': true })
            : [
                h('span', { key: `art-${popAt}`, style: { display: 'grid', placeItems: 'center', width: 30, height: 30, transform: `scale(${Math.min(scale, 1.4)})`, transformOrigin: 'center' }, 'aria-hidden': true },
                  petSvg(snap.pet.stage, snap.pet.mood, status, 30, snap.pet.outfitId)),
                h('span', { key: 'time', className: 'pp-pettime' }, remaining != null ? fmt(remaining) : `Lv.${snap.pet.level}`),
                prefs.showAgent && agentCtx?.agent?.running && h('span', {
                  key: 'agent', className: 'pp-agent-thought pill', 'aria-hidden': true, title: 'Agent 正在工作',
                }, '···'),
                h('span', { key: 'ctl', className: 'pp-petctl' },
                  (!r || status === 'waiting') && ctl(status === 'waiting' ? '开始下一轮专注' : '开始专注', '▶', () => void api.action('start').then(res => { if (!res.ok && res.code !== 'waiting') alert({ busy: '已有进行中的番茄钟', limit_exceeded: '专注时长需在 5-120 分钟之间' }[res.code] ?? '开始失败'); return res }).then(refresh)),
                  pausedNow && ctl('继续', '⏵', () => void api.action('resume').then(res => { if (!res.ok) alert('当前状态不支持此操作'); return res }).then(refresh)),
                  busy && !pausedNow && ctl('暂停', '⏸', () => void api.action('pause').then(res => { if (!res.ok) alert({ stale: '当前状态不支持此操作', busy: '已有进行中的番茄钟' }[res.code] ?? '操作失败'); return res }).then(refresh)),
                  r && ctl('停止', '⏹', () => void api.action('stop').then(res => { if (!res.ok) alert('当前状态不支持此操作'); return res }).then(refresh)),
                  ctl('收纳桌宠', '—', () => toggleCollapsed(true))),
              ],
        ),
        openId && h(SettlementOverlay, { snap, refresh, onClose: close }),
      )
    }
    const miniBtn = () => ({
      border: '1px solid var(--pp-line)', background: 'var(--pp-paper)', color: 'var(--pp-ink)', borderRadius: 6, fontSize: 11,
      padding: '0 6px', cursor: 'pointer', lineHeight: '18px',
    })

    /* ---------------- v0.5.1 顶部导航全宽面板 (设计稿 1/2) ----------------
     * 2026-10-18 用户确认: 计时与任务合并为一页（左计时/右任务, 底部四象限卡兼
     * 作过滤与拖拽目标）。导航三项: 专注 | 统计 | 设置。 */

    const TABS = [
      { key: 'focus', label: '专注', icon: '◷' },
      { key: 'stats', label: '统计', icon: '▥' },
      { key: 'settings', label: '设置', icon: '⚙' },
    ]
    const TAB_TITLE = { focus: '专注时间', stats: '专注统计', settings: '偏好设置' }

    function PomodoroPanel() {
      ensureStyles()
      const theme = useTheme()
      const { snap, refresh } = useSnapshot()
      const remaining = useRemaining(snap, refresh)
      usePhaseFx(snap)
      const { openId, close } = useSettlement(snap, refresh)
      // v0.5.1: 默认 Tab「专注」= 计时+任务合并页（用户确认, 2026-10-18）。
      const agentCtx = useAgentContext()
      const prefs = usePrefs()
      const [tab, setTab] = React.useState('focus')
      const [quadFilter, setQuadFilter] = React.useState('all') // 象限卡 → 任务区分联动
      const [helpOpen, setHelpOpen] = React.useState(false)
      if (!snap) {
        ensureStyles()
        return h('div', { className: 'pp-app', 'data-theme': theme.effective, style: { padding: 24, color: 'var(--pp-muted)', fontFamily: FONT } }, '正在连接番茄钟服务…')
      }
      const pendingCount = (snap.proposals ?? []).filter(p => p.status === 'pending').length
      const goal = Math.max(1, Number(snap.settings.dailyGoalPomodoros) || 8)
      const done = snap.todayStats?.completed ?? 0
      const stage = trStage(snap.pet.stage)
      const moodText = trMood(snap.pet.mood)
      const goto = (next, filter) => {
        if (filter !== undefined) setQuadFilter(filter)
        setTab(next)
        try { window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }) } catch { /* non-window */ }
      }

      /* ---- v0.9 面板快捷键（修复「不起作用」） ----
       * Space 开始/暂停/继续 · S 停止/跳过休息 · 1/2/3 切模式 · ? 快捷键 · Esc 关弹窗
       *
       * v0.9 之前的两个 bug：
       *  1) 在 window **冒泡**阶段监听，而 DSH 会话输入框常驻焦点 → 只要处于输入态就整体
       *     return，Space/S/1/2/3 永远不触发；
       *  2) 任何 button 获得焦点也整体 return，用户点过一次按钮后快捷键就全失效。
       * 现在的规则：
       *  - 捕获阶段监听，仅当本面板 `.pp-app` 挂载在文档里才介入；
       *  - Esc 始终可用（关结算/快捷键面板）；
       *  - 正在输入（input/textarea/select/contenteditable）或处于弹窗中 → 只放过 Esc；
       *  - 焦点在按钮/链接上时，Space 交给原生 click（防双动作），其余键照常；
       *  - 细分到具体按键，不再「一个键不满足就全盘退出」。 */
      React.useEffect(() => {
        const onKey = (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          if (!document.querySelector('.pp-app')) return
          const el = e.target instanceof Element ? e.target : document.activeElement
          const typing = !!el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]')
          const inModal = !!el?.closest?.('.pp-backdrop, .pp-modal')
          if (e.key === 'Escape') {
            if (openId) { e.preventDefault(); close(); return }
            if (helpOpen) { e.preventDefault(); setHelpOpen(false) }
            return
          }
          if (typing || inModal || helpOpen) return
          const tag = el?.tagName
          const onControl = tag === 'BUTTON' || tag === 'A' || !!el?.closest?.('button, a')
          if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); setHelpOpen(v => !v); return }
          const r = snap?.running
          const paused = !!r && r.endsAt == null && r.remainingMs != null
          const waiting = r?.status === 'waiting'
          const act = (action, extra, msgs) => api.action(action, extra).then(res => {
            if (!res.ok) alert(msgs?.[res.code] ?? '当前状态不支持此操作')
            return res
          }).then(refresh)
          if (e.code === 'Space' || e.key === ' ') {
            if (onControl) return   // 焦点在按钮上：交给原生 click，避免双动作
            e.preventDefault()
            if (!r || waiting) void act('start', undefined, { busy: '已有进行中的番茄钟', limit_exceeded: '专注时长需在 5-120 分钟之间' })
            else if (paused) void act('resume')
            else void act('pause')
            return
          }
          const k = e.key.toLowerCase()
          if (k === 's') { if (r) void act('stop'); return }
          if (k === '1' || k === '2' || k === '3') {
            if (!r || waiting) {
              e.preventDefault()
              void act('setMode', { mode: MODES[Number(k) - 1].key })
            }
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [snap?.running?.id, snap?.running?.status, snap?.running?.revision, openId, helpOpen])

      return h('div', { className: 'pp-app', 'data-theme': theme.effective, style: { fontFamily: FONT, color: 'var(--pp-ink)', minHeight: '100vh' } },
        h('main', null,
          // 顶部 header: 品牌 | 导航 | 档案
          h('header', { className: 'pp-header' },
            h('div', { className: 'pp-brand' },
              h('div', { className: 'pp-logo' }, petSvg(snap.pet.stage, snap.pet.mood, snap.running?.status, 44, snap.pet.outfitId)),
              h('div', null, h('strong', null, '番茄精灵'), h('small', null, '专注 · 任务 · 成长'))),
            h('nav', { className: 'pp-nav', role: 'tablist', 'aria-label': '番茄钟面板' },
              TABS.map(t => h('button', {
                key: t.key, type: 'button', role: 'tab', 'aria-selected': tab === t.key,
                onClick: () => goto(t.key),
              }, h('span', { 'aria-hidden': true, className: 'ico' }, t.icon), tr(t.label)))),
            h('div', { className: 'pp-profile' },
              h('span', { className: 'pp-avatar' }, petSvg(snap.pet.stage, snap.pet.mood, null, 38, snap.pet.outfitId)),
              h('span', null,
                h('strong', null, `Lv.${snap.pet.level} ${stage}`),
                h('small', null, prefs.showAgent && agentCtx?.agent
                  ? h('span', { className: 'pp-agent-mini' },
                      h('span', { className: `pp-agent-dot${agentCtx.agent.running ? ' on' : ''}`, 'aria-hidden': true }),
                      agentCtx.agent.running ? 'Agent 运行中' : 'AI 空闲')
                  : `心情${moodText},今天也要加油呀`))),
          ),
          // 页头: 大标题 + 日期 | 状态 pills
          h('header', { className: 'pp-pagehead' },
            h('div', { className: 'pp-date' },
              h('h1', { style: { color: 'var(--pp-ink)' } }, tr(TAB_TITLE[tab])),
              h('span', null, '▦ ', fmtDateZh(snap.today))),
            h('div', { className: 'pp-pills' },
              h('div', { className: 'pp-pill' }, '🍅 ', `Lv.${snap.pet.level} ${stage}`),
              h('div', { className: 'pp-pill streak' },
                isEn()
                  ? trf('🔥 {n}-day streak', { n: String(snap.todayStats?.streak ?? 0) })
                  : ['🔥 连续 ', h('span', { key: 'n' }, String(snap.todayStats?.streak ?? 0)), ' 天']),
              pendingCount > 0 && h('button', {
                type: 'button', className: 'pp-pill warm', onClick: () => goto('focus'),
                'aria-label': `${pendingCount} 条待确认提议,见下方待确认区`,
              }, `🤖 ${pendingCount} 条待确认`),
              h('button', {
                type: 'button', className: 'pp-pill', onClick: () => setHelpOpen(true),
                title: '快捷键 (?)', 'aria-label': '查看快捷键', style: { cursor: 'pointer' },
              }, '⌨ 快捷键')),
          ),
          // v0.8 上下文条: 当前工作区 / 最近会话 / Agent 状态
          (tab === 'focus' || tab === 'stats') && h(ContextBar, {
            context: agentCtx, showContext: prefs.showContext, showAgent: prefs.showAgent,
          }),
          // 内容区
          tab === 'focus' && h(FocusTab, { snap, refresh, remaining, onNav: goto, quadFilter, setQuadFilter }),
          tab === 'stats' && h(StatsTab, { snap, refresh }),
          tab === 'settings' && h(SettingsTab, { snap, refresh }),
        ),
        openId && h(SettlementOverlay, { snap, refresh, onClose: close }),
        helpOpen && h('div', {
          className: 'pp-backdrop', role: 'dialog', 'aria-modal': true, 'aria-label': '快捷键',
          onClick: () => setHelpOpen(false),
        },
          h('div', { className: 'pp-modal', onClick: e => e.stopPropagation(), style: { width: 'min(100%, 420px)' } },
            h('h2', null, '⌨　快捷键'),
            [
              [['Space'], '开始 / 暂停 / 继续'],
              [['S'], '停止（休息中 = 跳过休息）'],
              [['1', '2', '3'], '切换 标准 / 深度 / 冲刺 模式'],
              [['?'], '显示 / 隐藏本面板'],
              [['Esc'], '关闭弹窗'],
              [['Enter'], '桌宠：展开 / 收纳（聚焦时）'],
            ].map(([keys, desc]) => h('div', { key: desc, className: 'pp-shortcut-row' },
              h('span', { className: 'keys' }, keys.map(k => h('kbd', { key: k, className: 'pp-kbd' }, k))),
              h('span', { className: 'desc' }, desc))),
            h('div', { className: 'pp-actions' },
              h('button', { type: 'button', className: 'pp-secondarybtn', onClick: () => setHelpOpen(false) }, '知道了'))))
      )
    }

    /* ---------------- 专注 Tab = 计时 + 任务合并页 (设计稿 1, v0.5.1) ---------------- */

    function FocusTab({ snap, refresh, remaining, onNav, quadFilter, setQuadFilter }) {
      const r = snap.running
      const status = r?.status
      // §4.1 不变式: 已暂停 = endsAt 为空 且 remainingMs 非空（引擎 PAUSE 不改 status 字段,
      // 只冻结时钟——以不变式判定, 不要依赖 status==='paused'）。
      const paused = !!r && r.endsAt == null && r.remainingMs != null
      const running = !!r && !paused && r.endsAt != null
        && ['focus', 'break', 'longBreak'].includes(status)
      const allActive = snap.tasks.filter(t => t.status === 'active').sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      const mode = r?.mode ?? snap.settings.mode ?? 'standard'
      const modeDef = MODES.find(m => m.key === mode) ?? MODES[0]
      const [taskOpen, setTaskOpen] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [dragId, setDragId] = React.useState(null)
      const [dragOverQ, setDragOverQ] = React.useState(null)
      const [outfitOpen, setOutfitOpen] = React.useState(false)
      const fragCount2 = snap.inventory?.dress_fragment?.count ?? 0
      const [customMin, setCustomMin] = React.useState(() => {
        const base = Number(snap.settings.focusMin) || 25
        return Math.max(5, Math.min(120, base))
      })
      // v0.8: Agent 动态 → 宠物工具气泡（节流, 开关可关）
      const agentCtx = useAgentContext()
      const prefs = usePrefs()
      const lastAgentTool = agentCtx?.agent?.lastTools?.[0] ?? null
      const toolSeenAt = React.useRef(0)
      const lastToolBubbleAt = React.useRef(0)
      // ---- 宠物互动（v0.7）：视线跟随 + 点击反应 ----
      const [gaze, setGaze] = React.useState(null)
      const [petBubble, setPetBubble] = React.useState(null)
      const [popAt, setPopAt] = React.useState(0)
      const bubbleTimer = React.useRef(null)
      const gazeRaf = React.useRef(0)
      React.useEffect(() => () => { clearTimeout(bubbleTimer.current); if (gazeRaf.current) cancelAnimationFrame(gazeRaf.current) }, [])
      const onPetMove = (e) => {
        if (gazeRaf.current) return
        const el = e.currentTarget
        const px = e.clientX, py = e.clientY
        gazeRaf.current = requestAnimationFrame(() => {
          gazeRaf.current = 0
          const r = el.getBoundingClientRect()
          if (!r.width) return
          setGaze({ x: (px - r.left) / r.width - .5, y: (py - r.top) / r.height - .5 })
        })
      }
      const onPetLeave = () => setGaze(null)
      const petLine = () => {
        const pool = petTalkPool({ status: r?.status, paused: r && r.endsAt == null && r.remainingMs != null, mood: snap.pet.mood })
        const line = pickTalkLine(pool, heroLastLine.current)
        heroLastLine.current = line
        return line
      }
      const pokePet = () => {
        setPopAt(Date.now())
        setPetBubble(petLine())
        if (snap.settings.soundEnabled !== false) chime('greet', Number(snap.settings.volume) || 0.5)
        clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setPetBubble(null), 2600)
      }
      const petPopClass = () => (Date.now() - popAt < 600 ? ' pp-pet-pop' : '')
      // Agent 跑完工具 → 宠物冒一个工具气泡（1.6s 显示, 1.5s 节流, 可在设置关闭）
      React.useEffect(() => {
        if (!prefs.showAgent || !lastAgentTool?.at) return
        if (lastAgentTool.at <= toolSeenAt.current) return
        toolSeenAt.current = lastAgentTool.at
        const t = Date.now()
        if (t - lastToolBubbleAt.current < 1500) return
        lastToolBubbleAt.current = t
        setPetBubble(`${toolIcon(lastAgentTool.name)} ${lastAgentTool.name}${lastAgentTool.ok ? '' : ' ✗'}`)
        clearTimeout(bubbleTimer.current)
        bubbleTimer.current = setTimeout(() => setPetBubble(null), 1800)
      }, [lastAgentTool?.at, prefs.showAgent])
      const activeTask = snap.tasks.find(t => t.id === snap.activeTaskId)
      const goal = Math.max(1, Number(snap.settings.dailyGoalPomodoros) || 8)
      const done = snap.todayStats?.completed ?? 0
      const stage = trStage(snap.pet.stage)
      const moodText = trMood(snap.pet.mood)
      const need = needFor(snap.pet.level)
      const exp = Math.max(0, snap.pet.exp ?? 0)
      const proposals = (snap.proposals ?? []).filter(p => p.status === 'pending')
      const filter = quadFilter ?? 'all'
      const visibleQuads = QUADRANTS.filter(q => filter === 'all' || filter === q.key)
      const visibleActive = allActive.filter(t => filter === 'all' || visibleQuads.some(q => q.key === t.quadrant))

      // 圆环进度: 运行中/暂停中都按剩余量算（暂停冻结在暂停处, 不归零）; SVG 保证正圆。
      const total = (r?.focusMinutes ?? modeDef.min) * 60_000
      const frac = r && remaining != null && total > 0 ? 1 - remaining / total : 0
      const RING_R = 100, RING_C = 2 * Math.PI * RING_R
      const ringColor = status === 'break' || status === 'longBreak' ? '#4ba66a' : '#f15f50'
      const caption = !r ? '准备开始专注'
        : paused ? '已暂停，休息一下也好'
        : running && remaining != null && remaining <= 0 ? '本轮完成，结算中…'
        : status === 'focus' ? '正在专注…'
        : status === 'waiting' ? '休息结束，确认后开始下一轮'
        : '休息中，撒欢一下'

      const start = (focusMinutes) => api.action('start', {
        ...(focusMinutes != null ? { focusMinutes } : {}),
        taskId: snap.activeTaskId ?? undefined, mode,
      }).then(res => {
        if (!res.ok && res.code === 'limit_exceeded') alert('专注时长需在 5-120 分钟之间')
        return res
      }).then(refresh)

      // waiting（休息已结束）没有时钟可暂停（§4.3: 下一轮必须用户确认）——
      // 主按钮此时是「开始下一轮」（START 会在同一次写中终态化旧行, §4.3.1）。
      const startLabel = !r || status === 'waiting' ? '▶　开始专注'
        : paused ? '▶　继续专注'
        : status === 'focus' ? 'Ⅱ　暂停专注'
        : 'Ⅱ　暂停休息'
      const onStartClick = () => {
        if (!r || status === 'waiting') return void start()
        if (paused) return void api.action('resume').then(refresh)
        void api.action('pause').then(refresh)
      }
      /** 所有非 ok 返回给可见反馈（此前静默吞掉 → 「点了没反应」）。 */
      const runAction = (action) => () => void api.action(action).then(res => {
        if (!res.ok) {
          const msg = {
            stale: '当前状态不支持此操作,已为你刷新',
            busy: '已有进行中的番茄钟',
            already_settled: '本轮已结算,无需重复操作',
            invalid_state: '当前状态不支持此操作',
            limit_exceeded: '超过允许的上限（专注 5-120 分钟）',
          }[res.code] ?? `操作失败（${res.code ?? '未知'}）`
          alert(msg)
        }
        return res
      }).then(refresh)
      const onStartTask = (t) => () => void api.action('start', { taskId: t.id })
        .then(res => { if (!res.ok && res.code === 'busy') alert('已有进行中的番茄钟'); return res })
        .then(refresh)

      /** 拖拽落点（§6.4）: 落到象限区=换象限（追加到末尾）; 落到具体任务卡=插入其前（同象限内排序）。
       *  sortOrder 取相邻任务中值, 无邻位时用 ±1 边界。 */
      const dropToQuadrant = (q) => {
        if (!dragId) return
        const siblings = allActive.filter(t => t.quadrant === q.key && t.id !== dragId)
        const dragged = allActive.find(t => t.id === dragId)
        const patch = { quadrant: q.key }
        if (siblings.length) {
          const maxSort = Math.max(...siblings.map(t => t.sortOrder ?? 0))
          patch.sortOrder = (dragged?.quadrant === q.key ? Math.max(dragged.sortOrder ?? 0, maxSort) : maxSort) + 1
        }
        void api.taskPatch(dragId, patch).then(refresh)
        setDragId(null)
        setDragOverQ(null)
      }
      const dropToCard = (target) => {
        if (!dragId || dragId === target.id) return setDragId(null)
        const targetSort = target.sortOrder ?? 0
        const between = allActive.filter(t =>
          t.quadrant === target.quadrant && t.id !== dragId
          && ((t.sortOrder ?? 0) < targetSort))
        const lower = between.length ? Math.max(...between.map(t => t.sortOrder ?? 0)) : targetSort - 2
        void api.taskPatch(dragId, { quadrant: target.quadrant, sortOrder: (lower + targetSort) / 2 }).then(refresh)
        setDragId(null)
        setDragOverQ(null)
      }
      const dropZone = (q) => ({
        onDragOver: e => { e.preventDefault(); setDragOverQ(q.key) },
        onDragLeave: () => setDragOverQ(cur => (cur === q.key ? null : cur)),
        onDrop: () => dropToQuadrant(q),
      })

      return h('div', null,
        h('div', { className: 'pp-grid' },
        // 左列: 计时卡 + 今日进度
        h('section', { className: 'pp-col' },
          h('article', { className: 'pp-card' },
            // hero: 宠物插画 + 圆环倒计时
            h('div', { className: 'pp-hero' },
              h('div', { className: 'pp-hero-art' },
                h('span', { className: 'pp-leaf', 'aria-hidden': true }, '🌿'),
                h('span', { className: 'pp-spark', 'aria-hidden': true }, '♡'),
                prefs.showAgent && agentCtx?.agent?.running && h('span', {
                  className: 'pp-agent-thought', 'aria-hidden': true, title: 'Agent 正在工作',
                }, '· · ·'),
                h('button', {
                  type: 'button', className: `pp-pet-live pp-bigtomato${petPopClass()}`,
                  'aria-label': '摸摸番茄精灵', title: '点我互动',
                  onPointerMove: onPetMove, onPointerLeave: onPetLeave, onClick: pokePet,
                  style: { border: 0, background: 'transparent', padding: 0, cursor: 'pointer' },
                },
                  petSvg(snap.pet.stage, snap.pet.mood, status, 132, snap.pet.outfitId, gaze),
                  petBubble && h('span', { className: 'pp-pet-bubble', role: 'status' }, petBubble))),
              h('div', { className: 'pp-ringwrap' },
                h('div', { className: 'pp-ringbox' },
                  h('svg', {
                    viewBox: '0 0 230 230', role: 'img',
                    'aria-label': r ? `${statusLabel(status)} ${fmtClock(remaining ?? 0)}` : '空闲,准备开始专注',
                  },
                    h('circle', { cx: 115, cy: 115, r: RING_R, fill: 'none', stroke: 'var(--pp-line)', strokeWidth: 14 }),
                    h('circle', {
                      cx: 115, cy: 115, r: RING_R, fill: 'none', stroke: ringColor, strokeWidth: 14, strokeLinecap: 'round',
                      strokeDasharray: `${RING_C}`, strokeDashoffset: `${RING_C * (1 - Math.min(1, Math.max(0, frac)))}`,
                      transform: 'rotate(-90 115 115)',
                      style: { transition: 'stroke-dashoffset 1s linear' },
                    })),
                  h('div', { className: 'pp-ring-inner' },
                    h('div', { style: { transform: 'scale(.5)', height: 26 } }, petSvg(snap.pet.stage, snap.pet.mood, status, 26, snap.pet.outfitId)),
                    h('div', { className: 'pp-time' }, r ? fmtClock(remaining ?? 0) : `${modeDef.min}:00`),
                    h('div', { className: 'pp-caption' }, caption))))),
            // 模式三卡（运行中禁用: SET_MODE 仅 idle/waiting）
            h('div', { className: 'pp-modes', role: 'group', 'aria-label': '专注模式' },
              MODES.map(m => h('button', {
                key: m.key, type: 'button', className: 'pp-mode', 'aria-pressed': mode === m.key,
                // SET_MODE 仅 idle/waiting（§4.5）; focus/break/paused 锁定
                disabled: !!r && !paused && status !== 'waiting',
                title: !!r && !paused && status !== 'waiting' ? '计时中不可切换模式' : undefined,
                onClick: () => void api.action('setMode', { mode: m.key }).then(res => { if (!res.ok) alert('当前状态不支持此操作'); return res }).then(refresh),
              },
                h('strong', null, `${{ standard: '🍅', deep: '🌿', sprint: '⚡' }[m.key]} ${m.label.replace(/\s*\d+$/, '')}`),
                h('small', null, `${m.min} 分钟`)))),
            // 任务选择器（popover, 复用 setTask）
            h('div', { style: { position: 'relative', margin: '0 24px 17px' } },
              h('button', {
                type: 'button', className: 'pp-taskselect', onClick: () => setTaskOpen(o => !o), 'aria-expanded': taskOpen,
                'aria-haspopup': 'listbox',
              },
                h('span', {
                  'aria-hidden': true,
                  style: { width: 8, height: 8, borderRadius: '50%', background: activeTask ? qColor(activeTask.quadrant) : '#c9cdd2', flexShrink: 0 },
                }),
                h('span', { style: { flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  activeTask ? `本轮任务:${activeTask.title}` : '选择一个任务（可选）'),
                h('span', { 'aria-hidden': true }, '›')),
              taskOpen && h('div', {
                role: 'listbox', 'aria-label': '选择任务',
                style: { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 6, ...card, padding: 8, maxHeight: 220, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' },
              },
                h('button', {
                  type: 'button', role: 'option', 'aria-selected': !snap.activeTaskId,
                  onClick: () => { setTaskOpen(false); void api.action('setTask', { taskId: null }).then(refresh) },
                  style: { ...taskOpt(false), width: '100%' },
                }, '未分类（不绑定任务）'),
                allActive.map(t => h('button', {
                  key: t.id, type: 'button', role: 'option', 'aria-selected': t.id === snap.activeTaskId,
                  onClick: () => { setTaskOpen(false); void api.action('setTask', { taskId: t.id }).then(refresh) },
                  style: { ...taskOpt(t.id === snap.activeTaskId), width: '100%' },
                },
                  h('span', { 'aria-hidden': true, style: { color: qColor(t.quadrant) } }, '●'),
                  ` ${t.title}`)))),
            // 主控制行
            h('div', { className: 'pp-primaryrow' },
              h('button', { type: 'button', className: 'pp-startbtn', onClick: onStartClick }, startLabel),
              h('button', { type: 'button', className: 'pp-secondarybtn', onClick: () => onNav('settings') }, '⚙ 快速设置')),
            // 一次性自定义时长（focusMinutes [5,120], D19/D20）——idle 与 waiting 均可自定义开钟
            (!r || status === 'waiting') && h('div', { className: 'pp-custommin' },
              h('label', { htmlFor: 'pp-focus-min' }, '自定义时长'),
              h(NumField, {
                id: 'pp-focus-min', value: customMin, min: 5, max: 120,
                label: '自定义专注时长（5–120 分钟, 回车开始）',
                onInput: setCustomMin,
                onChange: setCustomMin,
                onEnter: (n) => { setCustomMin(n); void start(n) },
              }),
              h('span', { className: 'pp-custommin-unit' }, '分 · 回车开始')),
            (running || status === 'waiting') && h('div', { style: { fontSize: 12, color: 'var(--pp-muted)', textAlign: 'center', padding: '0 24px 18px' } },
              `本轮第 ${(snap.pet.rounds ?? 0) + 1} 个番茄 · 距长休还差 ${Math.max(0, (snap.settings.roundsPerLong ?? 4) - (snap.pet.rounds ?? 0))} 个`),
          ),
          // 今日进度卡
          h('article', { className: 'pp-card' },
            h('div', { className: 'pp-cardhead' }, h('h2', null, '◴　今日进度'), h('span', { className: 'pp-subtle' }, '继续保持 ✨')),
            h('div', { className: 'pp-progressbody' },
              h('div', {
                role: 'progressbar', 'aria-valuenow': done, 'aria-valuemin': 0, 'aria-valuemax': goal,
                'aria-label': `今日完成 ${done}/${goal} 个番茄`,
                className: 'pp-progressline',
              },
                h('div', { className: 'pp-track' }, h('i', { style: { width: `${Math.min(100, done / goal * 100)}%` } })),
                h('span', { className: 'pp-count' }, `${done} / ${goal} 个番茄`)),
              h('div', { className: 'pp-tomatorow', 'aria-hidden': true },
                Array.from({ length: goal }, (_, i) => h('span', { key: i, style: { filter: i < done ? 'none' : 'grayscale(1)', opacity: i < done ? 1 : .45 } }, '🍅'))),
              h('div', { className: 'pp-subtle', style: { marginTop: 10 } },
                '已专注 ', h('strong', { style: { color: 'var(--pp-ink)' } }, String(snap.todayStats?.focusMinutes ?? 0)), ' 分钟')),
          ),
        ),
        // 右列: 今天的任务（过滤+四象限分区+拖拽） + 桌宠状态
        h('section', { className: 'pp-col' },
          h('article', { className: 'pp-card' },
            h('div', { className: 'pp-cardhead' },
              h('h2', null, '▣　今天的任务'),
              h('button', {
                type: 'button', className: 'pp-secondarybtn', style: { padding: '9px 14px' },
                onClick: () => setCreating(true),
              }, '＋ 新建任务')),
            // 待确认提议 (D16): Agent 提议在合并页同样可见可操作
            proposals.length > 0 && h('div', {
              role: 'region', 'aria-label': '待确认提议', className: 'pp-proposalcard',
              style: { margin: '0 18px 12px' },
            },
              h('div', { style: { fontSize: 14, fontWeight: 650, marginBottom: 6 } }, `🤖 待确认提议 (${proposals.length})`),
              proposals.map(p => {
                const payload = safeParse(p.payload)
                const desc = p.type === 'task_create'
                  ? `新建任务「${payload.title}」 ${payload.quadrant ?? 'B'} 🍅×${payload.estimatedPomodoros ?? 1}`
                  : `修改任务 ${payload.taskId}: ${JSON.stringify(payload.patch ?? {})}`
                return h('div', { key: p.id, className: 'pp-proposalrow' },
                  h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, desc),
                  h('button', {
                    type: 'button', onClick: () => void api.proposal(p.id, 'confirm').then(res => { if (!res.ok) alert(res.summary ?? '执行失败'); return res }).then(refresh),
                    style: UI.primaryBtn({ padding: '5px 12px', fontSize: 12 }),
                  }, '确认'),
                  h('button', {
                    type: 'button', onClick: () => void api.proposal(p.id, 'reject').then(refresh),
                    style: UI.ghostBtn({ padding: '5px 12px', fontSize: 12 }),
                  }, '拒绝'))
              })),
            // 象限过滤 chips
            h('div', { className: 'pp-filters', role: 'group', 'aria-label': '象限过滤', style: { padding: '0 18px 10px' } },
              h('button', { type: 'button', style: UI.chip(filter === 'all', '#df4e42', 'var(--pp-red-soft)'), onClick: () => setQuadFilter('all') }, '全部'),
              QUADRANTS.map(q => h('button', {
                key: q.key, type: 'button',
                style: UI.chip(filter === q.key, QUAD_STYLE[q.key].color, QUAD_STYLE[q.key].soft),
                onClick: () => setQuadFilter(q.key),
              }, `${q.key} ${trQuad(q.key)}`))),
            // 四象限分区（拖拽换象限/排序, §6.4）
            h('div', { style: { padding: '0 0 8px' } },
              visibleQuads.map(q => {
                const list = allActive.filter(t => t.quadrant === q.key)
                const st = QUAD_STYLE[q.key]
                const empty = list.length === 0
                return h('div', {
                  key: q.key, ...dropZone(q),
                  className: `pp-dropzone${empty ? ' pp-dropzone-empty' : ''}${dragOverQ === q.key ? ' pp-dropzone-over' : ''}`,
                },
                  h('div', { className: 'pp-qhead', style: { color: st.color } },
                    `▼ ${q.key} ${trQuad(q.key)}`,
                    list.length > 0 && h('span', { className: 'pp-qcount' }, String(list.length))),
                  list.length
                    ? h('div', { className: 'pp-tasklist' }, list.map(t => h(TaskRow, {
                        key: t.id, task: t, snap, refresh, draggable: true,
                        onStart: onStartTask(t),
                        onDragStart: () => setDragId(t.id),
                        onDragEnd: () => { setDragId(null); setDragOverQ(null) },
                        onDragOver: e => e.preventDefault(),
                        onDrop: () => dropToCard(t),
                      })))
                    : dragId ? h('div', { className: 'pp-drophint' }, '松开即可移入此象限') : null)
              }),
              // 已完成折叠区（保留 30 天, §6.4）
              (() => {
                const doneList = snap.tasks.filter(t => t.status === 'done' && (filter === 'all' || filter === t.quadrant))
                if (doneList.length === 0) return null
                return h('details', { style: { margin: '10px 18px 0', borderTop: '1px solid var(--pp-line)', paddingTop: 10 } },
                  h('summary', { style: { fontSize: 13, fontWeight: 650, cursor: 'pointer', color: 'var(--pp-muted)' } }, `已完成 (${doneList.length})`),
                  h('div', { style: { display: 'grid', gap: 8, marginTop: 10 } },
                    doneList.map(t => h('div', { key: t.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: .75 } },
                      h('span', { 'aria-hidden': true, style: { color: qColor(t.quadrant) } }, '●'),
                      h('span', { style: { flex: 1, textDecoration: 'line-through', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title),
                      h('span', null, `🍅${t.completedPomodoros ?? 0}`),
                      h('button', {
                        type: 'button', 'aria-label': `重新打开任务 ${t.title}`,
                        onClick: () => void api.taskPatch(t.id, { status: 'active', completedAt: null }).then(refresh),
                        style: miniBtn(),
                      }, '↺'),
                      h('button', {
                        type: 'button', 'aria-label': `删除任务 ${t.title}`,
                        onClick: () => void api.taskDelete(t.id).then(refresh),
                        style: { ...miniBtn(), color: '#df4e42' },
                      }, '×')))))
              })())),
          h('article', { className: 'pp-card' },
            h('div', { className: 'pp-cardhead' },
              h('h2', null, '🐾　桌宠状态'),
              h('button', {
                type: 'button', className: 'pp-secondarybtn', style: { padding: '9px 14px' },
                onClick: () => setOutfitOpen(true),
              }, `自定义装扮 · ${fragCount2}/10　›`)),
            h('div', { className: 'pp-petcontent' },
              h('div', { style: { textAlign: 'center' } },
                h('button', {
                  type: 'button', className: `pp-pet-live${petPopClass()}`,
                  'aria-label': '摸摸番茄精灵', title: '点我互动',
                  onPointerMove: onPetMove, onPointerLeave: onPetLeave, onClick: pokePet,
                  style: { border: 0, background: 'transparent', padding: 0, cursor: 'pointer' },
                },
                  petSvg(snap.pet.stage, snap.pet.mood, snap.running?.status, 112, snap.pet.outfitId, gaze),
                  petBubble && h('span', { className: 'pp-pet-bubble', role: 'status' }, petBubble))),
              h('div', { className: 'pp-petinfo' },
                h('h3', null, `Lv.${snap.pet.level}　${stage}`),
                h('div', {
                  className: 'pp-expline', role: 'progressbar', 'aria-valuenow': exp, 'aria-valuemin': 0, 'aria-valuemax': need,
                  'aria-label': `经验 ${exp}/${need}`,
                }, h('i', { style: { width: `${Math.min(100, exp / need * 100)}%` } })),
                h('div', { className: 'pp-subtle', style: { textAlign: 'right', marginTop: 6 } }, `${exp} / ${need} EXP`),
                h('div', { className: 'pp-mood' }, '心情 ',
                  h('span', { 'aria-hidden': true, style: { color: '#f15f50', letterSpacing: 2 } },
                    '♥'.repeat(snap.pet.mood ?? 3) + '♡'.repeat(5 - (snap.pet.mood ?? 3))),
                  h('span', { style: { color: 'var(--pp-muted)', fontWeight: 400 } }, moodText)),
                h('div', { className: 'pp-subtle', style: { marginTop: 8 } },
                  '装扮 · ', (() => { const o = OUTFITS.find(x => x.id === snap.pet.outfitId); return o ? `${o.icon} ${o.name}` : '未装扮' })()),
                h('div', { className: 'pp-note' },
                  { sprout: '小芽正在扎根,陪你打坐。', fruit: '状态不错,陪你再专注一轮。', glow: '光环在闪,专注在涨。', rainbow: '王者风范,继续专注。' }[snap.pet.stage] ?? '陪你专注每一轮。'))))),
        ),
        // 底部: 任务分布（比例条 + 图例 chips, 点击图例联动过滤）
        (() => {
          const counts = QUADRANTS.map(q => ({ key: q.key, label: trQuad(q.key), color: QUAD_STYLE[q.key].color, soft: QUAD_STYLE[q.key].soft, n: allActive.filter(t => t.quadrant === q.key).length }))
          const total = counts.reduce((n, c) => n + c.n, 0)
          return h('section', { className: 'pp-card pp-dist', 'aria-label': '任务分布' },
            h('div', { className: 'pp-dist-head' },
              h('h2', null, '任务分布'),
              h('span', { className: 'pp-dist-sub' }, total > 0 ? `进行中 ${total} 个 · 点击图例按象限过滤` : '暂无进行中任务')),
            h('div', {
              className: 'pp-dist-bar', role: 'img',
              'aria-label': counts.map(c => `${c.key} ${c.label} ${c.n} 个`).join('，'),
            },
              total > 0
                ? counts.filter(c => c.n > 0).map(c => h('span', {
                    key: c.key, className: 'pp-dist-seg',
                    style: { flexGrow: c.n, background: c.color },
                  }))
                : h('span', { className: 'pp-dist-seg pp-dist-empty', style: { flexGrow: 1 } })),
            h('div', { className: 'pp-dist-legend' },
              counts.map(c => h('button', {
                key: c.key, type: 'button',
                className: `pp-dist-chip${filter === c.key ? ' active' : ''}`,
                style: { '--qc': c.color, '--qs': c.soft },
                onClick: () => setQuadFilter(filter === c.key ? 'all' : c.key),
                'aria-pressed': filter === c.key,
                'aria-label': `${c.key} ${c.label},${c.n} 个进行中任务,点击${filter === c.key ? '取消' : ''}过滤`,
              },
                h('i', { 'aria-hidden': true }),
                h('span', null, `${c.key}　${c.label}`),
                h('b', null, String(c.n))))))
        })(),
        // 新建任务弹窗
        creating && h(NewTaskModal, { snap, onClose: () => setCreating(false), onDone: () => { setCreating(false); refresh() } }),
        outfitOpen && h(OutfitModal, { snap, refresh, onClose: () => setOutfitOpen(false) }),
      )
    }
    const taskOpt = (selected) => ({
      display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', borderRadius: 8, fontSize: 14,
      border: 'none', cursor: 'pointer', fontFamily: FONT, color: 'var(--pp-ink)', textAlign: 'left',
      background: selected ? 'var(--pp-bg)' : 'transparent',
    })

    /** 任务行（计时页/任务页共用）: 象限色条 + 勾选 + 标题 + 分组签 + 番茄串 + 操作。 */
    function TaskRow({ task: t, snap, refresh, compact, onStart, draggable, onDragStart, onDragEnd, onDragOver, onDrop }) {
      const groups = snap.groups ?? []
      const gname = t.groupId ? groups.find(g => g.id === t.groupId)?.name : null
      const st = QUAD_STYLE[t.quadrant] ?? { color: '#9aa0a6', soft: 'var(--pp-gray-soft)' }
      const total = Math.max(t.estimatedPomodoros ?? 0, t.completedPomodoros ?? 0)
      // 番茄串: 最多 6 个点, 其余用 「n/m」数字表达（避免 16 个点时右侧挤成一团）
      const dots = Array.from({ length: Math.min(total, 6) }, (_, i) => i < (t.completedPomodoros ?? 0))
      return h('div', {
        draggable: !!draggable,
        onDragStart, onDragEnd, onDragOver, onDrop,
        className: `pp-task${t.status === 'done' ? ' pp-taskdone' : ''}`,
        style: { opacity: 1 },
      },
        h('div', { className: 'pp-bar', style: { background: t.status === 'done' ? '#c7d5c9' : st.color }, 'aria-hidden': true }),
        h('input', {
          type: 'checkbox', 'aria-label': `完成任务 ${t.title}`, checked: false,
          onChange: () => void api.taskPatch(t.id, { status: 'done', completedAt: Date.now() }).then(refresh),
        }),
        h('div', { className: 'pp-taskname' },
          h('span', null, t.title),
          gname && h('span', { className: 'pp-tag', style: { background: 'var(--pp-gray-soft)', color: 'var(--pp-muted)' } }, `#${gname}`)),
        h('div', { className: 'pp-taskmeta' },
          h('span', { className: 'pp-strand', role: 'img', 'aria-label': `番茄串 ${t.completedPomodoros ?? 0}/${t.estimatedPomodoros ?? 0}` },
            dots.map((filled, i) => h('span', {
              key: i, className: `dot${filled ? '' : ' empty'}`, 'aria-hidden': true,
              style: filled ? { background: st.color } : undefined,
            }))),
          h('span', { className: 'pp-count' }, `${t.completedPomodoros ?? 0}/${t.estimatedPomodoros ?? 0}`),
          h('span', { className: 'pp-taskhover' },
            h('button', { type: 'button', 'aria-label': `对「${t.title}」开钟`, onClick: onStart, style: miniBtn() }, '▶'),
            !compact && h('button', {
              type: 'button', 'aria-label': `删除任务 ${t.title}`,
              onClick: () => { if (confirm(`删除任务「${t.title}」?`)) void api.taskDelete(t.id).then(refresh) },
              style: { ...miniBtn(), color: '#df4e42' },
            }, '×'))),
        h('span', { 'aria-hidden': true, style: { color: 'var(--pp-muted)' } }, '›'))
    }

    /* ---------------- 统计 Tab (设计稿 2, §8) ---------------- */

    /** 统计数据拉取。deps 变化（如最新结算 id）时重拉，保证统计页与番茄钟联动。
     *  v0.5 增加 /days（180 天逐日聚合, 周柱状/目标完成率/环比用）。 */
    function useStatsData(reloadKey) {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        // allSettled: 单个子接口失败不再让整页统计变 0（v0.6.1）
        void Promise.allSettled([api.heatmap(), api.quadrants(), api.hours(), api.days(180), api.achievements(), api.sessions(90)])
          .then(([heatmap, quadrants, hours, days, achievements, sessions]) => setData({
            heatmap: heatmap.status === 'fulfilled' ? heatmap.value : null,
            quadrants: quadrants.status === 'fulfilled' ? quadrants.value : null,
            hours: hours.status === 'fulfilled' ? hours.value : null,
            days: days.status === 'fulfilled' ? days.value : null,
            achievements: achievements.status === 'fulfilled' ? achievements.value : null,
            sessions: sessions.status === 'fulfilled' ? sessions.value : null,
          }))
          .catch(() => setData({ error: true }))
      }, [reloadKey])
      return data
    }

    /** 骨架条（加载态占位, 尺寸可调）。 */
    const Skel = ({ w = 60, ht = 12, r = 6 }) => h('span', { className: 'pp-skel', style: { width: w, height: ht, borderRadius: r } })

    /** 成就卡（v0.6.1）：18 个成就的解锁墙 + 碎片进度。 */
    /** 稀有度文本（渲染时经 trRarity() 翻译）。 */
    const RARITY_TEXT = { '普通': '普通', '稀有': '稀有', '史诗': '史诗', '传说': '传说' }
    const RARITY = {
      '普通': { color: '#8a9099', soft: 'var(--pp-gray-soft)' },
      '稀有': { color: '#4599e8', soft: 'var(--pp-blue-soft)' },
      '史诗': { color: '#8e6fd8', soft: '#f2edfc' },
      '传说': { color: '#d98e18', soft: 'var(--pp-orange-soft)' },
    }
    function AchievementsCard({ data }) {
      if (!data) {
        return h('article', { className: 'pp-card pp-achv' },
          h('div', { className: 'pp-achv-head' }, h('h3', null, '🏅　成就'), h('span', { className: 'pp-achv-prog' }, h(Skel, { w: 90, ht: 12 }))),
          h('div', { className: 'pp-achv-grid' },
            Array.from({ length: 8 }, (_, i) => h('span', { key: i, className: 'pp-skel pp-skel-block', style: { height: 36, borderRadius: 11 } }))))
      }
      const cat = data.achievements?.catalogue
      if (!cat?.length) return null
      const unlocked = cat.filter(a => a.unlockedAt)
      const pct = Math.round(unlocked.length / cat.length * 100)
      return h('article', { className: 'pp-card pp-achv' },
        h('div', { className: 'pp-achv-head' },
          h('h3', null, '🏅　成就'),
          h('span', { className: 'pp-achv-prog' },
            h('span', null, `${unlocked.length} / ${cat.length}`),
            h('div', {
              className: 'pp-achv-bar', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100,
              'aria-label': `成就进度 ${pct}%`,
            }, h('i', { style: { width: `${pct}%` } })))),
        h('div', { className: 'pp-achv-grid' },
          cat.map(a => {
            const r = RARITY[a.rarity] ?? RARITY['普通']
            const on = !!a.unlockedAt
            return h('div', {
              key: a.id, className: `pp-achv-chip${on ? ' on' : ''}`, style: { '--rc': r.color, '--rs': r.soft },
              title: `${a.name} · ${trRarity(a.rarity)}${a.fragment ? ` · ${trf('奖励 {n} 个装扮碎片', { n: String(a.fragment) })}` : ''}${on ? tr(' · 已解锁') : tr(' · 未解锁')}`,
            },
              h('span', { className: 'medal', 'aria-hidden': true }, on ? '🏅' : '🔒'),
              h('b', null, a.name),
              h('small', null, trRarity(a.rarity)))
          })))
    }

    /** 近半年/全年切换共用: 同一份年 cells, 客户端按窗口裁剪。
     *  返回 {cells, minutes, completed, pomodoroDeltaPct, focusDeltaPct}。 */
    function sliceCells(cells, range, daysRows) {
      if (!cells?.length) return null
      const winDays = range === 'year' ? cells.length : 183
      const cut = cells.slice(Math.max(0, cells.length - winDays))
      const minutes = cut.reduce((n, c) => n + (c.focusMinutes ?? 0), 0)
      const completed = cut.reduce((n, c) => n + (c.completed ?? 0), 0)
      // 环比: 窗口后半 vs 前半（等长对比, 无服务端口径依赖）
      const half = Math.floor(cut.length / 2)
      const cur = cut.slice(half), prev = cut.slice(0, half)
      const sum = (arr, k) => arr.reduce((n, c) => n + (c[k] ?? 0), 0)
      const pct = (a, b) => b > 0 ? Math.round((a - b) / b * 100) : (a > 0 ? null : 0)
      return {
        cells: cut, minutes, completed,
        pomodoroDeltaPct: pct(sum(cur, 'completed'), sum(prev, 'completed')),
        focusDeltaPct: pct(sum(cur, 'focusMinutes'), sum(prev, 'focusMinutes')),
      }
    }

    /** 会话标签清洗：系统注入消息（time-context/system-reminder…）不当作会话名。 */
    const looksInjectedLabel = (raw) => {
      const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
      if (!s) return true
      if (s.startsWith('<') || s.includes('<system-reminder>')) return true
      return /^(time sampled|elapsed since|browser time zone|system reminder|runtime context|available skills|skill catalog|plan mode)/i.test(s)
    }
    const cleanSessionLabel = (s) => {
      const raw = String(s.dshSessionLabel ?? '').replace(/\s+/g, ' ').trim()
      if (raw && !looksInjectedLabel(raw)) return raw.length > 32 ? `${raw.slice(0, 31)}…` : raw
      if (s.dshCwdName) {
        const cwd = String(s.dshCwdName)
        return `${cwd.length > 18 ? `${cwd.slice(0, 17)}…` : cwd} 会话`
      }
      if (s.dshSessionId) return `会话 ${String(s.dshSessionId).slice(0, 8)}`
      return '未命名会话'
    }
    const SESS_COLORS = ['#5b76d6', '#7f95e8', '#a3b2f0', '#c3ccf6', '#dfe4fb']
    const fmtHours = (minutes) => `${Math.round((Number(minutes) || 0) / 60 * 10) / 10}`

    /** v0.8.3 按会话：占比条 + 排行榜式列表（数据来自结算行上的 DSH 会话字段）。 */
    function SessionStatsCard({ sessions }) {
      const rows = (sessions ?? []).filter(s => s.settledAt && (s.dshSessionId || s.dshCwdName || s.dshSessionLabel))
      if (!rows.length) return null
      const map = new Map()
      for (const s of rows) {
        const key = s.dshSessionId ?? s.dshSessionLabel ?? s.dshCwdName ?? 'unknown'
        const cur = map.get(key) ?? { key, label: cleanSessionLabel(s), cwdName: s.dshCwdName ?? null, count: 0, minutes: 0, agentTools: 0 }
        cur.count += 1
        cur.minutes += Number(s.focusMinutes) || 0
        cur.agentTools += Number(s.agentToolCount) || 0
        if (!cur.cwdName && s.dshCwdName) cur.cwdName = s.dshCwdName
        if (!cur.label || cur.label === '未命名会话') cur.label = cleanSessionLabel(s)
        map.set(key, cur)
      }
      const all = [...map.values()].sort((a, b) => b.minutes - a.minutes)
      const top = all.slice(0, 5)
      const total = all.reduce((n, r) => n + r.minutes, 0) || 1
      const totalTools = all.reduce((n, r) => n + r.agentTools, 0)
      return h('article', { className: 'pp-card pp-agentcard' },
        h('div', { className: 'pp-agentcard-head' },
          h('h3', null, '🗂　按会话'),
          h('span', { className: 'pp-agentcard-sum' },
            `${all.length} 个会话 · ${fmtHours(total)}h`, totalTools > 0 ? ` · 🤖 ${totalTools} 次工具` : '')),
        h('div', {
          className: 'pp-sharebar', role: 'img', 'aria-label': '会话时长占比',
          title: top.map(r => `${r.label} ${fmtHours(r.minutes)}h`).join(' · '),
        }, top.map((r, i) => h('i', {
          key: r.key,
          style: { width: `${Math.max(3, Math.round(r.minutes / total * 100))}%`, background: SESS_COLORS[i] ?? SESS_COLORS[4] },
        }))),
        h('div', { className: 'pp-sesslist' },
          top.map((r, i) => h('div', {
            key: r.key, className: 'pp-sessrow',
            title: [r.label, r.cwdName && `📁 ${r.cwdName}`, `${fmtHours(r.minutes)}h`].filter(Boolean).join(' · '),
          },
            h('span', {
              className: 'pp-sessavatar', 'aria-hidden': true,
              style: { background: `linear-gradient(135deg, ${SESS_COLORS[i] ?? SESS_COLORS[4]}, #4a63c8)` },
            }, String(i + 1)),
            h('div', { className: 'pp-sessmain' },
              h('b', null, r.label),
              h('span', null, [
                r.cwdName && `📁 ${r.cwdName}`,
                `${r.count} 个番茄`,
                r.agentTools > 0 && `🤖 ${r.agentTools}`,
              ].filter(Boolean).join(' · '))),
            h('span', { className: 'pp-sesstime' }, `${fmtHours(r.minutes)}h`)))),
        h('p', { className: 'pp-agentcard-note' }, '番茄自动归属到当时的 DSH 会话与工作区'))
    }

    /** v0.8.3 工作区技能：行式列表（名称 + 描述 + 复制），点击复制 /name。 */
    function SkillCard({ skills, showAgent }) {
      const [copied, setCopied] = useState(null)
      const items = (skills?.items ?? []).filter(s => s.userInvocable !== false)
      if (!showAgent || !items.length) return null
      const copy = (name) => {
        const done = () => { setCopied(name); setTimeout(() => setCopied(null), 1600) }
        try {
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(`/${name}`).then(done).catch(done)
          else done()
        } catch { done() }
      }
      return h('article', { className: 'pp-card pp-agentcard' },
        h('div', { className: 'pp-agentcard-head' },
          h('h3', null, '🎓　工作区技能'),
          h('span', { className: 'pp-agentcard-sum' }, `${items.length} 个 · 点击复制`)),
        h('div', { className: 'pp-skilllist' },
          items.slice(0, 8).map(s => h('button', {
            key: s.name, type: 'button', className: 'pp-skillrow',
            title: `${s.name}${s.description ? ` — ${s.description}` : ''}`, onClick: () => copy(s.name),
          },
            h('span', { className: 'pp-skillicon', 'aria-hidden': true }, '🧩'),
            h('span', { className: 'pp-skillmain' },
              h('b', null, s.name),
              h('small', null, s.description || '无描述')),
            h('span', { className: `pp-skillact${copied === s.name ? ' done' : ''}` }, copied === s.name ? '已复制' : '复制')))),
        h('p', { className: 'pp-agentcard-note' }, '在对话里输入 /名称 即可调用'))
    }

    function StatsTab({ snap }) {
      // 新结算落账后重拉统计（联动: 结算面板出现 → 数字刷新）
      const data = useStatsData(snap?.lastSettlement?.id ?? (snap?.todayStats?.completed ?? 0))
      const agentCtx = useAgentContext()
      const prefs = usePrefs()
      const [report, setReport] = React.useState(null)
      const [share, setShare] = React.useState(null)
      const [heatMetric, setHeatMetric] = React.useState('pomodoros')
      const [range, setRange] = React.useState('half') // half=近半年 | year=全年
      const dist = data?.quadrants?.distribution ?? {}
      const distTotal = ['A', 'B', 'C', 'D', 'uncategorized'].reduce((n, k) => n + (dist[k] ?? 0), 0)
      const bRatio = distTotal > 0 ? Math.round((dist.B ?? 0) / distTotal * 100) : 0
      const year = data?.heatmap
      const sliced = sliceCells(year?.cells, range)
      const goal = Math.max(1, Number(snap.settings.dailyGoalPomodoros) || 8)
      // 目标完成率: 本月已完成 ÷ (dailyGoal × 本月已过天数)。
      // 已过天数用日历推导（本月 1 日 → today），不依赖 days 表行数——
      // 无番茄的日子在 days 表没有行, 行数会低估分母导致完成率虚高。
      const daysRows = data?.days?.days ?? []
      const monthPrefix = (snap.today ?? '').slice(0, 7)
      const monthDays = daysRows.filter(r => (r.date ?? '').startsWith(monthPrefix))
      const monthCompleted = monthDays.reduce((n, r) => n + (r.completed ?? 0), 0)
      // 已过天数 = (today - 本月1日)/1天 + 1; today 由 Host 快照给出（时区口径一致）。
      const [ty, tm, td] = (snap.today ?? '').split('-').map(Number)
      const monthElapsed = ty && tm && td ? td : 0
      const monthHasData = monthCompleted > 0
      const goalRate = monthHasData && monthElapsed > 0
        ? Math.min(100, Math.round(monthCompleted / Math.max(1, goal * monthElapsed) * 100))
        : null
      const avgHours = sliced && daysRows.length > 0
        ? Math.round(sliced.minutes / daysRows.length / 60 * 10) / 10
        : null
      const longestStreak = year?.yearTotals?.longestStreak ?? 0
      const peak = peakHour(data?.hours?.hours)
      const loading = !data
      const noData = !loading && (sliced?.completed ?? 0) === 0
      const skelVal = (w) => h(Skel, { w, ht: 26, r: 8 })
      const insight = peak != null
        ? `✨ 你的高效时段是${{ morning: '上午', afternoon: '下午', evening: '晚上', night: '深夜' }[peakSlot(peak)]}。试着把最重要的任务安排在精力充沛的时候吧。`
        : '✨ 完成第一个番茄后,这里会出现你的时段洞察。'

      return h('div', null,
        // 「你的专注足迹」+ 近半年/全年
        h('div', { className: 'pp-statshead' },
          h('div', null,
            h('h2', null, '你的专注足迹'),
            h('p', null, '每一次专注,都在慢慢累积成就感。坚持自己的节奏就很好。')),
          h('div', { className: 'pp-rangeswitch', role: 'group', 'aria-label': '统计范围' },
            h('button', { type: 'button', 'aria-pressed': range === 'half', onClick: () => setRange('half') }, '近半年'),
            h('button', { type: 'button', 'aria-pressed': range === 'year', onClick: () => setRange('year') }, '全年'))),
        // 四统计卡
        h('div', { className: 'pp-statcards' },
          h('article', { className: 'pp-card pp-statcard' },
            h('div', { className: 'pp-statlabel' }, '🍅　累计番茄'),
            h('div', { className: 'pp-statvalue' }, loading ? skelVal(76) : String(sliced?.completed ?? 0)),
            h('div', { className: 'pp-statfoot' },
              loading ? h(Skel, { w: 110 })
                : sliced?.pomodoroDeltaPct != null && h('span', null,
                    sliced.pomodoroDeltaPct > 0
                      ? h('span', { className: 'pp-up' }, `↗ ${sliced.pomodoroDeltaPct}%`)
                      : sliced.pomodoroDeltaPct < 0
                        ? h('span', { className: 'pp-down' }, `↘ ${Math.abs(sliced.pomodoroDeltaPct)}%`)
                        : h('span', null, '→ 持平'),
                    '　较上一周期'))),
          h('article', { className: 'pp-card pp-statcard' },
            h('div', { className: 'pp-statlabel' }, '◷　专注总时长'),
            h('div', { className: 'pp-statvalue' },
              loading ? skelVal(96) : `${Math.round((sliced?.minutes ?? 0) / 60 * 10) / 10}`,
              !loading && h('span', { style: { fontSize: 14, fontWeight: 600 } }, ' 小时')),
            h('div', { className: 'pp-statfoot' }, loading ? h(Skel, { w: 100 }) : (avgHours != null ? ['平均每天 ', h('strong', null, `${avgHours} 小时`)] : '—'))),
          h('article', { className: 'pp-card pp-statcard' },
            h('div', { className: 'pp-statlabel' }, '🔥　最长连续'),
            h('div', { className: 'pp-statvalue' }, loading ? skelVal(56) : String(longestStreak), !loading && h('span', { style: { fontSize: 14, fontWeight: 600 } }, ' 天')),
            h('div', { className: 'pp-statfoot' }, loading ? h(Skel, { w: 120 }) : (longestStreak > 0 ? '继续保持这个节奏' : '完成第一个番茄后开始记录'))),
          h('article', { className: 'pp-card pp-statcard' },
            h('div', { className: 'pp-statlabel' }, '◎　目标完成率'),
            h('div', { className: 'pp-statvalue' },
              loading ? skelVal(64) : (goalRate != null ? String(goalRate) : '—'),
              !loading && goalRate != null ? h('span', { style: { fontSize: 14, fontWeight: 600 } }, '%') : null),
            h('div', { className: 'pp-statfoot' }, '本月目标完成情况'))),
        // 热力图卡
        h('article', { className: 'pp-card', style: { padding: '22px 24px', marginBottom: 18 } },
          h('div', { className: 'pp-heathead' },
            h('div', null,
              h('h3', null, '专注时间热力图'),
              h('p', null, '用颜色记录每一天的专注强度,颜色越深代表专注时间越长。')),
            h('div', { style: { display: 'grid', gap: 8, justifyItems: 'end' } },
              h('div', { className: 'pp-legend' },
                h('span', null, '少'),
                [0, 1, 2, 3, 4].map(l => h('i', { key: l, className: 'pp-heatcell', 'data-l': l, 'aria-hidden': true })),
                h('span', null, '多')),
              h(HeatmapToggle, { metric: heatMetric, onChange: setHeatMetric }))),
          loading
            ? h('div', { className: 'pp-skel pp-skel-block', style: { height: 132, width: '100%' } })
            : noData
              ? h('div', { className: 'pp-empty' },
                  h('b', null, '完成第一个番茄后，这里会有你的数据'),
                  h('span', null, '热力图会按天记录专注强度，颜色越深投入越多。'))
              : data?.heatmap?.ok && h(Heatmap, { cells: sliced?.cells ?? [], metric: heatMetric }),
          h('div', { className: 'pp-heatnote' },
            h('span', null, '📌 提示:将鼠标悬停在色块上,可查看当天专注时长。'),
            h('span', null, `${range === 'year' ? '全年' : '近半年'}共专注 ${Math.round((sliced?.minutes ?? 0) / 60 * 10) / 10} 小时 · ${sliced?.completed ?? 0} 个番茄 · B 区占 ${bRatio}%`))),
        // 下半: 每周柱状 + 时段分布
        h('div', { className: 'pp-statslower' },
          h('article', { className: 'pp-card pp-panel' },
            h('h3', null, '📈　每周专注时长'),
            loading
              ? h('div', { className: 'pp-skel pp-skel-block', style: { height: 170, width: '100%' } })
              : h(WeeklyBars, { daysRows, today: snap.today })),
          h('article', { className: 'pp-card pp-panel' },
            h('h3', null, '🎯　专注时段分布'),
            loading
              ? h('div', { className: 'pp-skel pp-skel-block', style: { height: 140, width: '100%' } })
              : h(HourDist, { hours: data?.hours?.hours ?? [] }),
            h('div', { className: 'pp-insight' }, insight))),
        // 成就墙（v0.6.1）
        h(AchievementsCard, { data }),
        // v0.8.3: 按会话 / 工作区技能（并排自适应, 只有一张时占满）
        (() => {
          const sessionRows = data?.sessions?.sessions ?? []
          const sessionsOn = prefs.showContext && sessionRows.some(s => s.settledAt && (s.dshSessionId || s.dshCwdName || s.dshSessionLabel))
          const skillsOn = prefs.showAgent && (agentCtx?.skills?.items ?? []).filter(s => s.userInvocable !== false).length > 0
          if (!sessionsOn && !skillsOn) return null
          return h('div', { className: `pp-agentgrid${!sessionsOn || !skillsOn ? ' single' : ''}` },
            sessionsOn && h(SessionStatsCard, { sessions: sessionRows }),
            skillsOn && h(SkillCard, { skills: agentCtx?.skills, showAgent: true }))
        })(),
        // 报告（保留: 生成周报/月报 + 分享卡片）
        h('div', { style: { display: 'flex', gap: 8, marginTop: 18 } },
          h('button', { type: 'button', onClick: () => void api.report('week').then(r => setReport(r.report)), style: UI.ghostBtn() }, '生成本周报告'),
          h('button', { type: 'button', onClick: () => void api.report('month').then(r => setReport(r.report)), style: UI.ghostBtn() }, '生成本月报告')),
        report && (() => {
          const cur = report.current ?? report.summary ?? {}
          const delta = report.deltaPercent
          return h('div', { className: 'pp-card', style: { fontSize: 13, lineHeight: 1.6, padding: 16, marginTop: 12 } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } },
              `${report.period === 'month' ? '月报' : '周报'} ${report.start ?? ''}${report.end ? ` ~ ${report.end}` : ''}`),
            h('div', null, `完成 ${cur.completed ?? 0} 个番茄 · 专注 ${cur.focusMinutes ?? 0} 分钟 · 活跃 ${cur.activeDays ?? 0} 天 · +${cur.expGained ?? 0} EXP`),
            delta != null && h('div', null,
              `上期 ${report.previous?.completed ?? 0} 个,${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}%`),
            report.insight && h('div', { style: { color: 'var(--pp-muted)' } }, report.insight),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
              h('button', { type: 'button', onClick: () => setShare({ portrait: true }), style: UI.primaryBtn({ padding: '6px 14px', fontSize: 12 }) }, '分享 · 竖版'),
              h('button', { type: 'button', onClick: () => setShare({ portrait: false }), style: UI.ghostBtn({ padding: '6px 14px', fontSize: 12 }) }, '横版'),
              h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', onClick: () => setReport(null), style: UI.ghostBtn({ padding: '5px 12px', fontSize: 12 }) }, '收起')),
            share && h(ShareCardModal, {
              report, snap, dist, streak: snap.todayStats?.streak ?? 0, portrait: share.portrait,
              onClose: () => setShare(null),
            }))
        })(),
      )
    }

    function peakSlot(hour) {
      const h = ((hour % 24) + 24) % 24
      if (h >= 8 && h < 12) return 'morning'
      if (h >= 12 && h < 18) return 'afternoon'
      if (h >= 18 && h < 22) return 'evening'
      return 'night'
    }

    function peakHour(hours) {
      if (!hours?.length) return null
      let best = -1, bestSum = 0
      for (let i = 0; i < 24; i++) {
        const sum = (hours[i] ?? 0) + (hours[(i + 1) % 24] ?? 0)
        if (sum > bestSum) { bestSum = sum; best = i }
      }
      return bestSum > 0 ? best : null
    }

    /** 热力图 (§8.2, 设计稿 2): 周一对齐、月份标签、行标「周一/周三/周五/周日」。
     *  cells: [{date, completed, focusMinutes}]（近半年或全年, 升序）。 */
    function Heatmap({ cells, metric = 'pomodoros' }) {
      if (!cells?.length) return null
      const size = 14, gap = 5
      const value = (c) => metric === 'minutes' ? (c.focusMinutes ?? 0) : (c.completed ?? 0)
      const level = (n) => metric === 'minutes'
        ? (n >= 100 ? 4 : n >= 50 ? 3 : n >= 25 ? 2 : n >= 1 ? 1 : 0)
        : (n >= 7 ? 4 : n >= 5 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0)
      const unit = metric === 'minutes' ? ' 分钟' : ' 个番茄'
      // 起始列对齐周一: 首格前的空位
      const first = cells[0].date
      const [fy, fm, fd] = first.split('-').map(Number)
      const lead = (new Date(Date.UTC(fy, fm - 1, fd)).getUTCDay() + 6) % 7
      const grid = [...Array(lead).fill(null), ...cells]
      const cols = Math.ceil(grid.length / 7)
      const cellH = size + gap
      // 月份标签: 扫描每列**所有 7 格**, 取该列内最早出现的「月份变化」——
      // 只看周一格会漏掉周中开始的新月份（如某月 1 日是周四）。
      const monthMarks = []
      let lastMonth = null
      for (let c = 0; c < cols; c++) {
        for (let row = 0; row < 7; row++) {
          const cell = grid[c * 7 + row]
          if (!cell) continue
          const m = Number(cell.date.slice(5, 7))
          if (m !== lastMonth) { monthMarks.push({ col: c, label: `${m}月` }); lastMonth = m; break }
        }
      }
      const W = cols * cellH, H = 7 * cellH
      return h('div', { className: 'pp-heatmap', style: { overflowX: 'auto' } },
        // 月份行
        h('div', { style: { position: 'relative', height: 16, marginLeft: 34 } },
          monthMarks.map(mk => h('span', {
            key: mk.col + mk.label, className: 'pp-heatlabel',
            style: { position: 'absolute', left: mk.col * cellH, top: 0, whiteSpace: 'nowrap' },
          }, mk.label))),
        h('div', { style: { display: 'flex', gap: 8 } },
          // 行标
          h('div', { style: { display: 'grid', gridTemplateRows: `repeat(7, ${size}px)`, gap, paddingTop: 0, flexShrink: 0 } },
            ['周一', '', '周三', '', '周五', '', '周日'].map((d, i) => h('span', { key: i, className: 'pp-heatlabel', style: { height: size, lineHeight: `${size}px` } }, d))),
          h('div', { role: 'img', 'aria-label': `每日专注热力图,${cells.length} 天,口径:${metric === 'minutes' ? '专注分钟' : '番茄数'}`,
            style: { display: 'grid', gridTemplateRows: `repeat(7, ${size}px)`, gridAutoFlow: 'column', gridTemplateColumns: `repeat(${cols}, ${size}px)`, gap } },
            grid.map((c, i) => c
              ? h('span', {
                  key: c.date, className: 'pp-heatcell', 'data-l': level(value(c)),
                  title: `${c.date} · ${value(c)}${unit}`,
                })
              : h('span', { key: `pad-${i}`, 'aria-hidden': true })))),
      )
    }
    function HeatmapToggle({ metric, onChange }) {
      return h('div', { style: { display: 'flex', gap: 4, padding: 3, background: 'var(--pp-line)', borderRadius: 9 } },
        h('button', { type: 'button', 'aria-pressed': metric === 'pomodoros', onClick: () => onChange('pomodoros'),
          style: { border: 0, background: metric === 'pomodoros' ? 'var(--pp-paper)' : 'transparent', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: metric === 'pomodoros' ? '#df4e42' : 'var(--pp-muted)', fontWeight: metric === 'pomodoros' ? 650 : 400 } }, '番茄数'),
        h('button', { type: 'button', 'aria-pressed': metric === 'minutes', onClick: () => onChange('minutes'),
          style: { border: 0, background: metric === 'minutes' ? 'var(--pp-paper)' : 'transparent', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: metric === 'minutes' ? '#df4e42' : 'var(--pp-muted)', fontWeight: metric === 'minutes' ? 650 : 400 } }, '专注分钟'))
    }

    /** 每周专注时长柱状图（本周一~周日, days.rows 聚合, 设计稿 2 样式）。 */
    function WeeklyBars({ daysRows, today }) {
      const rows = daysRows ?? []
      const dow = (iso) => { const [y, m, d] = iso.split('-').map(Number); return (new Date(Date.UTC(y, m - 1, d))).getUTCDay() }
      const mondayOffset = (dow(today) + 6) % 7
      const week = Array.from({ length: 7 }, (_, i) => {
        const iso = addIsoDays(today, i - mondayOffset)
        const row = rows.find(r => r.date === iso)
        return { label: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][i], hours: (row?.focusMinutes ?? 0) / 60, future: iso > today }
      })
      if (week.every(w => w.hours === 0)) {
        return h('div', { className: 'pp-empty' },
          h('b', null, '本周还没有专注记录'),
          h('span', null, '开始一个番茄，这里会画出每天的投入曲线'))
      }
      const max = Math.max(1, ...week.map(w => w.hours))
      return h('div', { className: 'pp-barchart', role: 'img', 'aria-label': '本周每日专注时长柱状图' },
        week.map(w => h('div', { key: w.label, className: 'pp-barcol' },
          h('div', {
            className: 'pp-bar',
            title: `${w.label}:${Math.round(w.hours * 10) / 10} 小时`,
            style: { height: `${Math.max(2, w.hours / max * 100)}%`, opacity: w.future ? .3 : 1 },
          }),
          h('span', null, w.label))))
    }
    /** 'YYYY-MM-DD' ± n 天 → 'YYYY-MM-DD'（UTC 安全）。 */
    function addIsoDays(iso, n) {
      const [y, m, d] = iso.split('-').map(Number)
      const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000)
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
    }

    /** 专注时段分布（24 桶 → 上午/下午/晚上/深夜, 设计稿 2）。 */
    function HourDist({ hours }) {
      const buckets = hours?.length ? hours : Array(24).fill(0)
      const segs = [
        { label: '上午 8–12', range: [8, 12] },
        { label: '下午 12–18', range: [12, 18] },
        { label: '晚上 18–22', range: [18, 22] },
        { label: '深夜 22–08', range: [22, 24], wrap: [0, 8] },
      ]
      const total = buckets.reduce((n, v) => n + v, 0)
      const rows = segs.map(s => {
        let n = 0
        for (let h = s.range[0]; h < s.range[1]; h++) n += buckets[h] ?? 0
        if (s.wrap) for (let h = s.wrap[0]; h < s.wrap[1]; h++) n += buckets[h] ?? 0
        return { ...s, n, pct: total > 0 ? Math.round(n / total * 100) : 0 }
      })
      if (total === 0) return h('div', { className: 'pp-empty' },
        h('b', null, '暂无时段数据'),
        h('span', null, '完成几个番茄后，这里会显示你一天中的高效时段'))
      return h('div', { className: 'pp-hourlist' },
        rows.map(r => h('div', { key: r.label, className: 'pp-hourrow' },
          h('span', { className: 'pp-heatlabel', style: { fontSize: 12, color: 'var(--pp-muted)' } }, r.label),
          h('div', { className: 'pp-track', role: 'img', 'aria-label': `${r.label} 占 ${r.pct}%` },
            h('i', { style: { width: `${r.pct}%`, background: 'linear-gradient(90deg,#f58b7e,#ef5f51)' } })),
          h('strong', { style: { textAlign: 'right', fontSize: 12 } }, `${r.pct}%`))))
    }

    /* ---------------- 分享卡片 (§8.5, D14) ---------------- */

    /** 宠物阶段配色（§8.5: 青芽绿/红果红/发光果金/彩虹王渐变; v0.5 暖纸色）。 */
    const STAGE_THEME = {
      sprout: { bg: '#F0F5EC', fg: '#2D5A27', accent: '#7DBB6A' },
      fruit: { bg: '#FBEFEC', fg: '#7A2318', accent: '#F15F50' },
      glow: { bg: '#FCF5E8', fg: '#7A5310', accent: '#F5AE42' },
      rainbow: { bg: '#F4F0FB', fg: '#3D2A63', accent: '#8E44AD' },
    }

    /**
     * Canvas 绘制分享卡片并导出 PNG。D14: 默认只含聚合数字,不含任务名。
     * portrait: 1080×1920(社媒) | false: 1200×630(链接预览)。
     */
    function drawShareCard(canvas, { report, snap, dist, streak, portrait, showTaskNames, topTasks }) {
      const W = portrait ? 1080 : 1200, H = portrait ? 1920 : 630
      canvas.width = W; canvas.height = H
      const g = canvas.getContext('2d')
      const theme = STAGE_THEME[snap?.pet?.stage] ?? STAGE_THEME.fruit
      const cur = report?.current ?? {}
      const prev = report?.previous ?? {}
      const delta = report?.deltaPercent

      g.fillStyle = theme.bg; g.fillRect(0, 0, W, H)
      // 顶部色带 + 标题
      g.fillStyle = theme.accent; g.fillRect(0, 0, W, 10)
      g.fillStyle = theme.fg
      g.font = `700 ${portrait ? 64 : 44}px ${FONT}`
      g.fillText(portrait ? (report?.period === 'month' ? '本月专注报告' : '本周专注报告') : '番茄专注报告', 64, portrait ? 150 : 92)
      g.font = `400 ${portrait ? 30 : 20}px ${FONT}`
      g.fillStyle = theme.fg + '99'
      if (report?.start) g.fillText(`${report.start}${report.end ? ` ~ ${report.end}` : ''}`, 64, portrait ? 200 : 126)

      // 核心数字（D14: 聚合数字）
      const nums = [
        { v: `${Math.round((cur.focusMinutes ?? 0) / 60 * 10) / 10}h`, l: '专注时长' },
        { v: `${cur.completed ?? 0}`, l: '完成番茄' },
        { v: `${streak ?? 0}天`, l: '连续打卡' },
      ]
      const colW = portrait ? (W - 128) / 3 : 220
      nums.forEach((n, i) => {
        const x = 64 + i * colW, y = portrait ? 420 : 240
        g.fillStyle = theme.fg
        g.font = `800 ${portrait ? 88 : 52}px ${FONT}`
        g.fillText(n.v, x, y)
        g.font = `400 ${portrait ? 28 : 18}px ${FONT}`
        g.fillStyle = theme.fg + '88'
        g.fillText(n.l, x, y + (portrait ? 44 : 28))
      })
      if (delta != null) {
        g.fillStyle = theme.accent
        g.font = `600 ${portrait ? 34 : 22}px ${FONT}`
        g.fillText(`比上期${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}%`, 64, portrait ? 540 : 310)
      }

      // 象限分布环形图
      const segs = QUADRANTS.map(q => ({ ...q, n: dist?.[q.key] ?? 0 })).filter(s => s.n > 0)
      if ((dist?.uncategorized ?? 0) > 0) segs.push({ key: '?', label: '未分类', color: '#B0B0B8', n: dist.uncategorized })
      const distTotal = segs.reduce((n, s) => n + s.n, 0)
      if (distTotal > 0) {
        const cx = portrait ? W / 2 : 940, cy = portrait ? 1150 : 330, R = portrait ? 260 : 110
        let a0 = -Math.PI / 2
        for (const s of segs) {
          const a1 = a0 + (s.n / distTotal) * Math.PI * 2
          g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, a1); g.closePath()
          g.fillStyle = s.color; g.fill()
          a0 = a1
        }
        g.beginPath(); g.arc(cx, cy, R * 0.55, 0, Math.PI * 2); g.fillStyle = theme.bg; g.fill()
        g.fillStyle = theme.fg; g.font = `700 ${portrait ? 44 : 24}px ${FONT}`
        g.textAlign = 'center'; g.fillText(`${distTotal}`, cx, cy + (portrait ? 14 : 8)); g.textAlign = 'left'
        // 图例
        g.font = `400 ${portrait ? 28 : 17}px ${FONT}`
        segs.forEach((s, i) => {
          const ly = portrait ? 1500 + i * 44 : 430
          g.fillStyle = s.color; g.fillRect(portrait ? W / 2 - 200 : 800, ly - (portrait ? 22 : 14), 20, 20)
          g.fillStyle = theme.fg
          g.fillText(`${s.label} ${Math.round(s.n / distTotal * 100)}%`, portrait ? W / 2 - 168 : 830, ly)
        })
      }

      // 宠物形象（按当前阶段）+ 一句文案
      const stageLine = { sprout: '青芽正在努力扎根', fruit: '红果越结越多了', glow: '你专注的样子在发光', rainbow: '王者之路,由番茄铺成' }[snap?.pet?.stage] ?? '今天的你也很棒'
      g.fillStyle = theme.fg
      g.font = `500 ${portrait ? 40 : 26}px ${FONT}`
      g.fillText(stageLine, 64, portrait ? 1800 : 560)
      g.font = `400 ${portrait ? 26 : 16}px ${FONT}`
      g.fillStyle = theme.fg + '77'
      g.fillText(trf('Lv.{lv} {stage} · 番茄精灵', { lv: String(snap?.pet?.level ?? 1), stage: trStage(snap?.pet?.stage) }), 64, portrait ? 1848 : 588)
      g.textAlign = 'right'
      g.fillText('🍅 dsh-pomodoro-pet', W - 64, portrait ? 1848 : 588)
      g.textAlign = 'left'

      // 可选任务名（D14: 用户手动开启才显示,默认关）
      if (showTaskNames && topTasks?.length) {
        g.font = `400 ${portrait ? 26 : 15}px ${FONT}`
        g.fillStyle = theme.fg + 'aa'
        topTasks.slice(0, portrait ? 8 : 4).forEach((t, i) => {
          g.fillText(`· ${t.title} ×${t.completedPomodoros}`, 64, (portrait ? 620 : 360) + i * (portrait ? 38 : 22))
        })
      }
    }

    function ShareCardModal({ report, snap, dist, streak, portrait, onClose }) {
      const canvasRef = React.useRef(null)
      const [showTaskNames, setShowTaskNames] = React.useState(false)
      const topTasks = React.useMemo(() =>
        (snap?.tasks ?? []).filter(t => (t.completedPomodoros ?? 0) > 0)
          .sort((a, b) => (b.completedPomodoros ?? 0) - (a.completedPomodoros ?? 0)).slice(0, 8),
      [snap?.tasks])
      React.useEffect(() => {
        if (canvasRef.current) {
          drawShareCard(canvasRef.current, { report, snap, dist, streak, portrait, showTaskNames, topTasks })
        }
      }, [report, snap, dist, streak, portrait, showTaskNames, topTasks])
      const exportPng = () => {
        const url = canvasRef.current.toDataURL('image/png')
        const a = document.createElement('a')
        a.href = url
        a.download = `pomodoro-pet-share-${portrait ? '1080x1920' : '1200x630'}-${new Date().toISOString().slice(0, 10)}.png`
        a.click()
      }
      return h('div', {
        role: 'dialog', 'aria-modal': true, 'aria-label': '分享卡片预览',
        onClick: onClose,
        style: {
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        },
      },
        h('div', {
          onClick: e => e.stopPropagation(),
          style: { ...card, maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 10, justifyItems: 'center' },
        },
          h('canvas', {
            ref: canvasRef,
            style: { maxWidth: portrait ? 300 : 480, height: 'auto', borderRadius: 10, boxShadow: '0 2px 12px rgba(0,0,0,0.15)' },
          }),
          h('label', { style: { ...row, fontSize: 13, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: showTaskNames, onChange: e => setShowTaskNames(e.target.checked), style: { accentColor: '#f15f50' } }),
            '显示任务名（默认隐藏,注意隐私）'),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { type: 'button', onClick: exportPng, style: UI.primaryBtn({ padding: '8px 18px', fontSize: 13 }) }, '下载 PNG'),
            h('button', { type: 'button', onClick: onClose, style: UI.ghostBtn({ padding: '8px 18px', fontSize: 13 }) }, '关闭'))))
    }

    /* TasksTab 已并入 FocusTab（v0.5.1: 计时+任务合并页）。 */

    /** 新建任务弹窗（标题/分组/象限/预估; 默认 B 象限, §6.1 产品价值观）。 */
    /** v0.8.2 数字输入：可清空重输（不再把 1 卡死），回车/失焦夹取范围后提交。
     *  - onFocus 全选 → 直接输入想要的数字即可覆盖
     *  - 只接受纯数字字符（避免 e/-/. 干扰）
     *  - onEnter(值) 用于「回车开钟」这类快捷提交 */
    function NumField({ id, value, min, max, step = 1, label, unit, onChange, onInput, onEnter, width, className }) {
      const [draft, setDraft] = React.useState(String(value ?? ''))
      const focused = React.useRef(false)
      React.useEffect(() => {
        if (!focused.current) setDraft(String(value ?? ''))
      }, [value])
      const clamp = (n) => Math.min(max, Math.max(min, Math.round(n)))
      const commit = (raw) => {
        const parsed = Number(String(raw ?? '').trim())
        const next = Number.isFinite(parsed) && String(raw ?? '').trim() !== '' ? clamp(parsed) : (Number(value) || min)
        setDraft(String(next))
        if (next !== value) onChange?.(next)
        return next
      }
      return h('input', {
        id, type: 'text', inputMode: 'numeric', autoComplete: 'off',
        className: `pp-numfield${className ? ` ${className}` : ''}`,
        value: draft, 'aria-label': label, title: label,
        style: width != null ? { width } : undefined,
        onFocus: (e) => { focused.current = true; try { e.currentTarget.select() } catch { /* noop */ } },
        onChange: (e) => {
          const v = e.target.value
          if (!/^\d*$/.test(v)) return
          setDraft(v)
          // 实时把有效数字同步给父组件（不夹取、不落库），让 +/− 与提示用最新值
          if (v !== '' && Number(v) !== value) onInput?.(Number(v))
        },
        onBlur: () => { focused.current = false; commit(draft) },
        onKeyDown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); const next = commit(draft); onEnter?.(next) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); const next = clamp((Number(draft) || value) + step); setDraft(String(next)); onChange?.(next) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); const next = clamp((Number(draft) || value) - step); setDraft(String(next)); onChange?.(next) }
        },
      })
    }

    function NewTaskModal({ snap, onClose, onDone }) {
      // Escape 关闭（键盘可达性, §13.10）
      React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [onClose])
      const [title, setTitle] = React.useState('')
      const [quadrant, setQuadrant] = React.useState(snap.settings.defaultQuadrant ?? 'B')
      const [estimate, setEstimate] = React.useState(1)
      const groups = snap.groups ?? []
      const [groupId, setGroupId] = React.useState('')
      const submit = (e) => {
        e?.preventDefault?.()
        if (!title.trim()) return
        void api.taskCreate({ title: title.trim(), quadrant, estimatedPomodoros: Math.max(1, Math.min(50, Number(estimate) || 1)), groupId: groupId || null })
          .then(res => {
            if (!res.ok) {
              alert({ not_found: '分组不存在', limit_exceeded: '超出允许的上限', invalid: '任务内容不合法' }[res.code] ?? `创建失败（${res.code ?? '未知'}）`)
              return
            }
            onDone()
          })
          .catch(() => alert('创建失败,请重试'))
      }
      return h('div', {
        className: 'pp-backdrop', role: 'dialog', 'aria-modal': true, 'aria-label': '新建任务',
        onClick: onClose,
      },
        h('form', { className: 'pp-modal', onClick: e => e.stopPropagation(), onSubmit: submit },
          h('h2', null, '🌱 新建任务'),
          h('label', { htmlFor: 'pp-task-title' }, '任务名称'),
          h('input', {
            id: 'pp-task-title', type: 'text', value: title, autoFocus: true, maxLength: 80,
            placeholder: '例如:完成设计稿',
            onChange: e => setTitle(e.target.value),
          }),
          groups.length > 0 && h('div', null,
            h('label', { htmlFor: 'pp-task-group' }, '分组'),
            h('select', { id: 'pp-task-group', value: groupId, onChange: e => setGroupId(e.target.value) },
              h('option', { value: '' }, '无分组'),
              groups.map(g => h('option', { key: g.id, value: g.id }, `# ${g.name}`)))),
          h('div', null,
            h('label', null, '优先级（象限）'),
            h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
              QUADRANTS.map(q => h('button', {
                key: q.key, type: 'button',
                style: UI.chip(quadrant === q.key, QUAD_STYLE[q.key].color, QUAD_STYLE[q.key].soft),
                onClick: () => setQuadrant(q.key), 'aria-pressed': quadrant === q.key,
              }, `${q.key} ${QUAD_STYLE[q.key].label}`)))),
          h('div', { className: 'pp-field' },
            h('div', { className: 'pp-field-head' },
              h('label', { htmlFor: 'pp-task-est' }, '预估番茄数'),
              h('span', { className: 'pp-field-hint' }, `≈ ${Math.max(1, Number(estimate) || 1) * (Number(snap.settings.focusMin) || 25)} 分钟`)),
            h('div', { className: 'pp-stepper' },
              h('button', {
                type: 'button', className: 'pp-step-btn', 'aria-label': '减少预估番茄数',
                disabled: estimate <= 1, onClick: () => setEstimate(v => Math.max(1, (Number(v) || 1) - 1)),
              }, '−'),
              h(NumField, { id: 'pp-task-est', value: estimate, min: 1, max: 50, label: '预估番茄数', onInput: setEstimate, onChange: setEstimate }),
              h('span', { className: 'pp-stepper-unit' }, '个'),
              h('button', {
                type: 'button', className: 'pp-step-btn', 'aria-label': '增加预估番茄数',
                disabled: estimate >= 50, onClick: () => setEstimate(v => Math.min(50, (Number(v) || 1) + 1)),
              }, '+'))),
          h('div', { className: 'pp-actions' },
            h('button', { type: 'button', className: 'pp-secondarybtn', onClick: onClose }, '取消'),
            h('button', { type: 'submit', style: UI.primaryBtn() }, '创建任务')))
      )
    }

    /* ---------------- 设置 Tab (§13.6) ---------------- */

    /** 设置页（v0.6）：双列紧凑分组卡 + 说明文案 + 可输入步进器 + 默认值恢复。 */
    function SettingsTab({ snap, refresh }) {
      const theme = useTheme()
      const prefs = usePrefs()
      const [draft, setDraft] = React.useState(() => ({ ...snap.settings }))
      const [savedAt, setSavedAt] = React.useState(0)
      const [notifyState, setNotifyState] = React.useState(
        typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
      const [auditRows, setAuditRows] = React.useState(null)
      const [achievements, setAchievements] = React.useState(null)
      const [outfitOpen, setOutfitOpen] = React.useState(false)
      React.useEffect(() => { void api.achievements().then(setAchievements).catch(() => {}) }, [])
      const d = draft
      const set = (key, value) => setDraft(prev => ({ ...prev, [key]: value }))

      /* 立即持久化（增量 patch），ok:false 也算失败 */
      const persist = (patch) => {
        void api.settings(patch)
          .then(res => {
            if (!res?.ok) { alert('保存失败,请重试'); return }
            setSavedAt(Date.now()); refresh()
          })
          .catch(() => alert('保存失败,请重试'))
      }
      const savedHint = savedAt > 0 && Date.now() - savedAt < 2500

      /* ---------- 原子控件 ---------- */
      const sw = (key, label) => h('button', {
        type: 'button', role: 'switch', 'aria-checked': !!d[key], 'aria-label': label, className: 'pp-switch',
        onClick: () => { const v = !d[key]; set(key, v); persist({ [key]: v }) },
      }, h('span', { 'aria-hidden': true }))

      const stepper = (key, min, max, stepv, unit, label) => {
        const v = Number(d[key]) || min
        const clamp = (n) => Math.min(max, Math.max(min, Math.round(n * 100) / 100))
        const commit = (n) => { const nv = clamp(n); set(key, nv); persist({ [key]: nv }) }
        return h('span', { className: 'pp-step' },
          h('button', { type: 'button', 'aria-label': `减少${label ?? ''}`, disabled: v <= min, onClick: () => commit(v - stepv) }, '−'),
          h(NumField, {
            id: `pp-set-${key}`, value: v, min, max, step: stepv,
            label: `${label}（可直接输入, 回车或失焦生效）`,
            onInput: (n) => set(key, n),
            onChange: (n) => commit(n),
          }),
          unit && h('span', { className: 'pp-unit' }, unit),
          h('button', { type: 'button', 'aria-label': `增加${label ?? ''}`, disabled: v >= max, onClick: () => commit(v + stepv) }, '+'))
      }

      const slider = (key, min, max, stepv, fmt, label) => h('span', { className: 'pp-sctrl', style: { display: 'flex', alignItems: 'center', gap: 10 } },
        h('input', {
          type: 'range', min, max, step: stepv, value: Number(d[key]) || 0, 'aria-label': label, className: 'pp-range',
          onChange: e => set(key, Number(e.target.value)),
          onPointerUp: e => persist({ [key]: Number(e.target.value) }),
          onKeyUp: e => { if ('value' in e.target) persist({ [key]: Number(e.target.value) }) },
        }),
        h('span', { className: 'pp-sval' }, fmt(Number(d[key]) || 0)))

      const ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC']
      const tzOptions = (() => {
        const cur = d.statsTimeZone ?? ''
        const list = cur && !ZONES.includes(cur) ? [cur, ...ZONES] : ZONES
        return [{ value: '', label: '跟随系统（推荐）' }, ...list.map(z => ({ value: z, label: z }))]
      })()
      const tzSelect = h('select', {
        className: 'pp-select', value: d.statsTimeZone ?? '', 'aria-label': '统计时区',
        onChange: e => { const v = e.target.value || null; set('statsTimeZone', v); persist({ statsTimeZone: v }) },
      }, tzOptions.map(o => h('option', { key: o.value, value: o.value }, o.label)))

      /* ---------- 布局原子 ---------- */
      const row = (label, hint, control) => h('div', { className: 'pp-setrow2' },
        h('span', { className: 'pp-slabel' },
          h('b', null, label),
          hint && h('small', null, hint)),
        h('span', { className: 'pp-sctrl' }, control))

      const card = (title, icon, children, opts) => h('section', { className: 'pp-card pp-setcard' },
        h('div', { className: 'pp-sethead' },
          h('span', { className: 'pp-seticon', 'aria-hidden': true }, icon),
          h('h3', null, title),
          opts?.extra),
        children.map((c, i) => c && React.cloneElement(c, { key: `r${i}` })))

      const exportData = () => {
        void Promise.all([api.state(), api.heatmap(), api.achievements()])
          .then(([state, heatmap, achievementsRes]) => {
            const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...state, heatmap, achievements: achievementsRes }, null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = `pomodoro-pet-export-${new Date().toISOString().slice(0, 10)}.json`
            a.click()
            URL.revokeObjectURL(a.href)
          })
      }
      const fragCount = achievements ? (achievements.inventory?.['dress_fragment']?.count ?? Object.values(achievements.inventory ?? {})[0]?.count ?? 0) : null

      const resetDefaults = () => {
        if (!confirm('恢复默认设置？任务与统计记录不受影响。')) return
        const defaults = {
          focusMin: 25, breakMin: 5, longBreakMin: 15, roundsPerLong: 4, dailyGoalPomodoros: 8,
          soundEnabled: true, volume: 0.5, notificationEnabled: true, animationEnabled: true,
          petScale: 1, statsTimeZone: null, auditEnabled: true,
        }
        setDraft(prev => ({ ...prev, ...defaults }))
        persist(defaults)
      }

      const clampN = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) * 100) / 100 || min))
      const persistVis = () => {
        setSavedAt(Date.now())
        persist({
          focusMin: clampN(d.focusMin, 5, 120), breakMin: clampN(d.breakMin, 1, 60),
          longBreakMin: clampN(d.longBreakMin, 1, 120), roundsPerLong: clampN(d.roundsPerLong, 2, 12),
          dailyGoalPomodoros: clampN(d.dailyGoalPomodoros, 1, 50),
          soundEnabled: !!d.soundEnabled, notificationEnabled: !!d.notificationEnabled,
          animationEnabled: !!d.animationEnabled, auditEnabled: !!d.auditEnabled,
          volume: clampN(d.volume, 0, 1), petScale: clampN(d.petScale ?? 1, 0.5, 2),
          statsTimeZone: d.statsTimeZone === '' ? null : (d.statsTimeZone ?? null),
        })
      }

      const left = h('div', { className: 'pp-setcol' },
        card('番茄钟', '🍅', [
          row('专注时长', '每个番茄的长度（5–120 分钟）', stepper('focusMin', 5, 120, 5, '分', '专注时长')),
          row('短休时长', '每个番茄后的休息时间', stepper('breakMin', 1, 60, 1, '分', '短休时长')),
          row('长休时长', '连续多轮后的长休息', stepper('longBreakMin', 1, 120, 5, '分', '长休时长')),
          row('长休间隔', '每完成几轮进入一次长休', stepper('roundsPerLong', 2, 12, 1, '轮', '长休间隔')),
          row('每日目标', '今日进度条的目标番茄数', stepper('dailyGoalPomodoros', 1, 50, 1, '个', '每日目标')),
        ]),
        card('声音与提醒', '🔔', [
          row('提示音', '专注结束与休息结束时的提示音', h('span', { className: 'pp-sctrl' },
            h('button', {
              type: 'button', className: 'pp-sbtn',
              onClick: () => chime('focus-done', Number(d.volume) || 0.5),
            }, '试听'),
            sw('soundEnabled', '提示音'))),
          row('音量', '提示音播放音量', slider('volume', 0, 1, 0.05, v => `${Math.round(v * 100)}%`, '音量')),
          row('桌面通知', '页面收起到后台时也能收到提醒',
            notifyState === 'unsupported' ? h('span', { className: 'pp-sstatus muted' }, '浏览器不支持')
              : notifyState === 'granted' ? h('span', { className: 'pp-sstatus ok' }, '✓ 已授权')
                : notifyState === 'denied' ? h('span', { className: 'pp-sstatus warn' }, '已被拒绝，请在浏览器设置中开启')
                  : h('button', { type: 'button', className: 'pp-sbtn', onClick: () => { void ensureNotifyPermission().then(setNotifyState) } }, '申请授权')),
          row('动画效果', '关闭后所有过渡与庆祝动效静止', sw('animationEnabled', '动画效果')),
        ]))

      const right = h('div', { className: 'pp-setcol' },
        card('外观', '🎨', [
          row('主题', '跟随 DSH 的外观设置自动切换（在「设置 → 通用 → 外观」修改）',
            h('span', { className: `pp-sstatus${theme.effective === 'dark' ? '' : ' muted'}`, 'aria-live': 'polite' },
              theme.effective === 'dark' ? '🌙 深色（跟随 DSH）' : '☀️ 浅色（跟随 DSH）')),
        ]),
        card('Agent 联动', '🤖', [
          row('Agent 动态', '宠物冒工具气泡、状态点与结算战绩（本机偏好）',
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': prefs.showAgent, 'aria-label': 'Agent 动态',
              className: 'pp-switch', onClick: () => setPref('showAgent', !prefs.showAgent),
            }, h('span', { 'aria-hidden': true }))),
          row('会话与工作区', '显示最近会话名、工作区目录与「按会话」统计',
            h('button', {
              type: 'button', role: 'switch', 'aria-checked': prefs.showContext, 'aria-label': '会话与工作区',
              className: 'pp-switch', onClick: () => setPref('showContext', !prefs.showContext),
            }, h('span', { 'aria-hidden': true }))),
          row('数据来源', 'DSH 会话事件 + 工具调用事件，仅在本机展示，不上传、不写入导出',
            h('span', { className: 'pp-sstatus muted' }, '本地')),
        ]),
        card('桌宠', '🐾', [
          row('大小', '桌宠浮层的显示比例（0.5–2.0×）', slider('petScale', 0.5, 2, 0.1, v => `${v.toFixed(1)}x`, '桌宠大小')),
          row('归位', '把桌宠移回右下角默认位置',
            h('button', {
              type: 'button', className: 'pp-sbtn',
              onClick: () => { try { localStorage.removeItem('pp-pet-pos') } catch { /* ignore */ } persist({ petPosition: null }) },
            }, '重置位置')),
        ]),
        card('统计', '📊', [
          row('统计时区', '跨日归属按此时区计算（改变不追溯历史）', tzSelect),
        ]),
        card('数据', '🗂', [
          row('装扮碎片', '10 个碎片兑换 1 件装扮（可预览）',
            h('button', {
              type: 'button', className: 'pp-sbtn',
              onClick: () => setOutfitOpen(true),
            }, fragCount != null ? `自定义装扮 · ${fragCount}/10` : '自定义装扮')),
          row('导出数据', '下载 JSON 备份（任务、统计与成就）',
            h('button', { type: 'button', className: 'pp-sbtn', onClick: exportData }, '导出 JSON')),
          row('操作审计', '记录 Agent 每次调用的动作与结果', sw('auditEnabled', '操作审计')),
          row('审计记录', '查看最近操作（最多保留 1000 条）',
            h('button', {
              type: 'button', className: 'pp-sbtn',
              onClick: () => void api.audit().then(res => setAuditRows(res.rows ?? [])).catch(() => setAuditRows([])),
            }, auditRows ? '收起' : '查看')),
        ]),
        auditRows && h('div', { className: 'pp-auditbox' },
          h('div', { style: { fontWeight: 650, marginBottom: 8, fontSize: 12.5 } }, `审计日志 (${auditRows.length})`),
          auditRows.length === 0 && h('div', { style: { color: 'var(--pp-muted)' } }, '暂无记录'),
          ...auditRows.slice(-50).reverse().map(entry => h('div', { key: entry.id, style: { display: 'flex', gap: 10, padding: '3px 0', color: 'var(--pp-muted)', alignItems: 'baseline' } },
            h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, flexShrink: 0 } }, new Date(entry.at).toLocaleTimeString()),
            h('span', { style: { fontWeight: 600, color: entry.result === 'ok' ? '#328b50' : '#df4e42', flexShrink: 0 } }, entry.toolAction),
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.result)))),
        card('关于', 'ℹ️', [
          row('版本', '番茄精灵 · DSH 插件', h('span', { className: 'pp-sstatus muted', style: { fontVariantNumeric: 'tabular-nums' } }, '0.9.3')),
        ]))

      return h('div', { className: 'pp-settings' },
        left, right,
        outfitOpen && h(OutfitModal, { snap, refresh, onClose: () => setOutfitOpen(false) }),
        h('div', { className: 'pp-setfoot' },
          h('span', { className: 'pp-sstatus ok', style: { opacity: savedHint ? 1 : 0, transition: 'opacity .3s' } }, '✓ 已自动保存'),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'pp-sbtn', onClick: () => setDraft({ ...snap.settings }) }, '放弃修改'),
          h('button', { type: 'button', className: 'pp-sbtn', onClick: resetDefaults }, '恢复默认')),
      )
    }

    /* ---------------- v0.9 i18n 出口包装 ----------------
     * 只包两个「顶层」组件：localizeNode 会递归遍历整棵元素树，
     * 因此 FocusTab / StatsTab / SettingsTab / 弹窗 / 桌宠全部覆盖，
     * 且语言切换时随 useLocaleRev() 自动重渲染。 */
    const PomodoroPanelI18n = withI18n((props) => h(PomodoroPanel, props))
    const PetOverlayI18n = withI18n((props) => h(PetOverlay, props))

    /* ---- 测试导出（SSR 冒烟用；不影响运行） ---- */
    const StatsTabI18n = withI18n((props) => h(StatsTab, props))
    const SettingsTabI18n = withI18n((props) => h(SettingsTab, props))
    const NewTaskModalI18n = withI18n((props) => h(NewTaskModal, props))

    /* ---------------- register ---------------- */
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // v0.9: 先装运行时（拿到当前语言），再按语言注册官方词典（供设置页语言列表）
        installLocale(ctx)
        let localeOk = 'skipped'
        try {
          // 挂在 effect 上：fiber 销毁（HMR 重载）时自动注销字典，
          // 否则同名命名空间的 zh 会残留，重载后 register 直接抛 already has locale。
          ctx.effect(() => ctx.locale.register(NS, { zh: ZH_SELF_DICT, en: EN_TEXT }), 'pomodoro-pet: dictionaries')
          localeOk = `ok(${Object.keys(EN_TEXT).length})`
        } catch (error) { localeOk = `fail: ${error.message}` }
        console.log('pomodoro-pet[client]: locale.register =', localeOk, '| locale =', i18nStore.locale)

        // Slot registration follows the M0-probe-verified pattern (pomodoro-probe
        // client.js): each inject wrapped in try/catch so one failing slot
        // doesn't take down the others.
        try {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'pomodoro-pet-overlay', order: 200,
          }, PetOverlayI18n))
          console.log('pomodoro-pet[client]: shell.overlay registered')
        } catch (error) { console.error('pomodoro-pet[client]: shell.overlay FAILED', error) }
        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: 'pomodoro-pet', locale: 'pomodoro.pet',
          }, PomodoroPanelI18n))
          console.log('pomodoro-pet[client]: main panel registered (key pomodoro-pet)')
        } catch (error) { console.error('pomodoro-pet[client]: main FAILED', error) }
        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: 'pomodoro-pet', order: 15,
            label: () => tr('番茄精灵'),
          }, ({ size }) => h('span', { style: { fontSize: size, lineHeight: 1 } }, '🍅')))
          console.log('pomodoro-pet[client]: sidebar.panellist icon registered')
        } catch (error) { console.error('pomodoro-pet[client]: panellist FAILED', error) }
      },
    }
  },
})
