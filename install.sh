#!/usr/bin/env bash
# 番茄精灵（Pomodoro Pet）一键安装脚本
#
#   ./install.sh                    # 安装到 ~/.dsh/profiles/web
#   ./install.sh --profile headless # 指定 profile 名
#   ./install.sh --dest ~/dsh-plugins --profile web
#
# 会做：拷插件目录 → 写 profile package.json（dependencies + bundles）
#       → 建软链 → 往 cordis.patch.yml 插入插件行
# 幂等：重复跑不会产生重复条目（会就地更新路径）。
set -euo pipefail

PLUGIN_NAME='@local/dsh-pomodoro-pet'
PKG_DIR_NAME='dsh-pomodoro-pet'
PROFILE='web'
DEST=''
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:?--profile 需要参数}"; shift 2 ;;
    --dest)    DEST="${2:?--dest 需要参数}"; shift 2 ;;
    --home)    DSH_HOME_DIR="${2:?--home 需要参数}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

DEST="${DEST:-$HOME/dsh-plugins}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

say()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
command -v dsh >/dev/null 2>&1 || say '警告: PATH 里找不到 dsh 命令，安装脚本会继续，但装完你可能无法启动。'
[[ -d "$PROFILE_DIR" ]] || die "找不到 profile 目录: $PROFILE_DIR （用 --profile 指定正确名字，或 --home 指定 DSH_HOME）"
command -v node >/dev/null 2>&1 || die '需要 node（用于修改 package.json / 语法自检）'

# ---------- 1. 拷贝插件目录 ----------
TARGET_DIR="$DEST/$PKG_DIR_NAME"
if [[ "$SRC_DIR" != "$TARGET_DIR" ]]; then
  say "拷贝插件到 $TARGET_DIR"
  mkdir -p "$DEST"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude 'node_modules' --exclude '.git' \
      "$SRC_DIR/" "$TARGET_DIR/"
  else
    rm -rf "$TARGET_DIR"
    mkdir -p "$TARGET_DIR"
    ( cd "$SRC_DIR" && tar --exclude='node_modules' --exclude='.git' -cf - . ) | ( cd "$TARGET_DIR" && tar -xf - )
  fi
else
  say "已在目标位置，跳过拷贝: $TARGET_DIR"
fi
ok "插件目录就绪"

# ---------- 2. 语法自检 ----------
say '语法自检'
for f in index.js pet-engine.js achievement-engine.js stats-engine.js client.js agent-bridge.js i18n-en.mjs; do
  [[ -f "$TARGET_DIR/$f" ]] || die "缺少文件: $f"
  node --check "$TARGET_DIR/$f" || die "语法错误: $f"
done
node -e "JSON.parse(require('fs').readFileSync('$TARGET_DIR/package.json','utf8'))" || die 'package.json 不是合法 JSON'
ok '全部文件通过'

# ---------- 3. 写 profile package.json ----------
say "更新 $PROFILE_DIR/package.json"
node - "$PROFILE_DIR/package.json" "$PLUGIN_NAME" "$TARGET_DIR" <<'NODE'
const fs = require('fs')
const [file, name, targetDir] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies ??= {}
pkg.dependencies[name] = `link:${targetDir}`
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('dependencies + bundles 已更新')
NODE
ok 'profile 清单已更新'

# ---------- 4. 建软链 ----------
say '建立 node_modules 软链'
mkdir -p "$PROFILE_DIR/node_modules/@local"
ln -sfn "$TARGET_DIR" "$PROFILE_DIR/node_modules/@local/$PKG_DIR_NAME"
[[ -e "$PROFILE_DIR/node_modules/@local/$PKG_DIR_NAME/index.js" ]] || die '软链建立失败'
ok "软链: $PROFILE_DIR/node_modules/@local/$PKG_DIR_NAME"

# ---------- 5. 插入 cordis.patch.yml ----------
PATCH="$PROFILE_DIR/cordis.patch.yml"
say "更新 $PATCH"
if [[ -f "$PATCH" ]] && grep -q "id: pomodoro-pet" "$PATCH"; then
  ok 'patch 里已有 pomodoro-pet，跳过'
else
  {
    printf '\n# 番茄精灵（Pomodoro Pet）— 由 install.sh 插入\n'
    printf -- '- insert:\n'
    printf '    - id: pomodoro-pet\n'
    printf "      name: '%s'\n" "$PLUGIN_NAME"
    printf '      config: {}\n'
  } >> "$PATCH"
  [[ -f "$PATCH" ]] || die '写 patch 失败'
  ok 'patch 已追加'
fi

# ---------- 6. 提示重启 ----------
cat <<EOF

$(printf '\033[32m════════ 安装完成 ════════\033[0m')

  插件位置 : $TARGET_DIR
  Profile  : $PROFILE_DIR

$(printf '\033[33m下一步：重启 DSH（Host 端代码必须重启才会加载）\033[0m')

  # 在运行 dsh web 的终端里 Ctrl+C，然后：
  dsh web

然后浏览器刷新 http://127.0.0.1:3080 ，侧边栏应出现 🍅「番茄精灵」。

验证：
  curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:3080/dsh-pomodoro/state
  # 期望 200

EOF
