#!/usr/bin/env bash
set -Eeuo pipefail

# Release-based operator entry point for a single OpenLabStock instance.
# It deliberately downloads a fixed GitHub Release, verifies its manifest, and
# delegates the actual switch to the tested systemd or Docker helper.

SCRIPT_NAME="$(basename "$0")"
REPO="${OPENLABSTOCK_REPO:-okoklabs/openlabstock}"
MODE="${OPENLABSTOCK_DEPLOY_MODE:-auto}"
ACTION="install"
RELEASE=""
PACKAGE=""
MANIFEST=""
APP_DIR=""
PUBLIC_HEALTH_URL=""
SERVICE_NAME=""
DATA_DIR=""
ENV_FILE=""
BACKUP_DIR=""
UPDATE_SCRIPT=""
WORK_DIR=""

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

usage() {
  cat <<'EOF'
OpenLabStock 固定版本安装与运维入口

用法：
  sudo bash deploy/openlabstock.sh install --release YYYYMMDD-rN
  sudo bash deploy/openlabstock.sh update  --release YYYYMMDD-rN
  sudo bash deploy/openlabstock.sh status
  sudo bash deploy/openlabstock.sh doctor
  sudo bash deploy/openlabstock.sh backup
  sudo bash deploy/openlabstock.sh rollback

选项：
  --release TAG       从 GitHub Releases 下载固定版本并校验 manifest
  --package PATH      离线使用已下载的生产包（必须同时提供 --manifest）
  --manifest PATH     与生产包同版本的发布清单
  --repo OWNER/REPO   GitHub 仓库，默认 okoklabs/openlabstock
  --mode MODE         auto（默认）、systemd 或 docker；auto 会识别已有实例，首次安装优先使用可用 Docker
  --app-dir PATH      程序目录；systemd 默认 /opt/openlabstock，Docker 默认 /opt/openlabstock-docker
  --public-health-url 安装或更新后额外检查公网 HTTPS 健康地址
  --service-name NAME systemd 服务名（高级自定义部署）
  --data-dir PATH     systemd 数据目录（高级自定义部署）
  --env-file PATH     systemd 环境文件（高级自定义部署）
  --backup-dir PATH   systemd 备份目录（高级自定义部署）
  --update-script PATH systemd 更新辅助脚本路径（默认 /usr/local/sbin/openlabstock-update）
  -h, --help          显示帮助

安全边界：
  - 只接受固定版本标签，不自动追踪未知的 latest；
  - 先核对 manifest 中的 SHA-256，再解包；
  - systemd 更新前生成 SQLite 一致性备份，失败自动恢复旧程序目录；
  - 不移动、删除或覆盖数据库目录；回滚只切换程序，不恢复数据库。
EOF
}

require_absolute_path() {
  local label="$1" value="$2"
  [[ "$value" =~ ^/[A-Za-z0-9._/@-]+$ ]] || die "$label 必须是不含 shell 字符的绝对路径：$value"
}

require_safe_name() {
  local label="$1" value="$2"
  [[ "$value" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "$label 包含不安全字符：$value"
}

parse_args() {
  [[ $# -gt 0 ]] || return
  case "$1" in
    install|update|status|doctor|backup|rollback|help) ACTION="$1"; shift ;;
    -h|--help) usage; exit 0 ;;
  esac
  while (($#)); do
    case "$1" in
      --release) RELEASE="${2:-}"; shift 2 || die '--release 需要版本标签' ;;
      --release=*) RELEASE="${1#*=}"; shift ;;
      --package) PACKAGE="${2:-}"; shift 2 || die '--package 需要路径' ;;
      --package=*) PACKAGE="${1#*=}"; shift ;;
      --manifest) MANIFEST="${2:-}"; shift 2 || die '--manifest 需要路径' ;;
      --manifest=*) MANIFEST="${1#*=}"; shift ;;
      --repo) REPO="${2:-}"; shift 2 || die '--repo 需要 owner/repository' ;;
      --repo=*) REPO="${1#*=}"; shift ;;
      --mode) MODE="${2:-}"; shift 2 || die '--mode 需要 auto、systemd 或 docker' ;;
      --mode=*) MODE="${1#*=}"; shift ;;
      --app-dir) APP_DIR="${2:-}"; shift 2 || die '--app-dir 需要路径' ;;
      --app-dir=*) APP_DIR="${1#*=}"; shift ;;
      --public-health-url) PUBLIC_HEALTH_URL="${2:-}"; shift 2 || die '--public-health-url 需要 URL' ;;
      --public-health-url=*) PUBLIC_HEALTH_URL="${1#*=}"; shift ;;
      --service-name) SERVICE_NAME="${2:-}"; shift 2 || die '--service-name 需要名称' ;;
      --service-name=*) SERVICE_NAME="${1#*=}"; shift ;;
      --data-dir) DATA_DIR="${2:-}"; shift 2 || die '--data-dir 需要路径' ;;
      --data-dir=*) DATA_DIR="${1#*=}"; shift ;;
      --env-file) ENV_FILE="${2:-}"; shift 2 || die '--env-file 需要路径' ;;
      --env-file=*) ENV_FILE="${1#*=}"; shift ;;
      --backup-dir) BACKUP_DIR="${2:-}"; shift 2 || die '--backup-dir 需要路径' ;;
      --backup-dir=*) BACKUP_DIR="${1#*=}"; shift ;;
      --update-script) UPDATE_SCRIPT="${2:-}"; shift 2 || die '--update-script 需要路径' ;;
      --update-script=*) UPDATE_SCRIPT="${1#*=}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "未知参数：$1（使用 --help 查看用法）" ;;
    esac
  done
}

parse_args "$@"

[[ "$MODE" == auto || "$MODE" == systemd || "$MODE" == docker ]] || die '--mode 只能是 auto、systemd 或 docker'
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die '--repo 必须是 owner/repository'
if [[ -n "$RELEASE" ]]; then
  [[ "$RELEASE" =~ ^[0-9]{8}-r[0-9]+$ ]] || die '--release 必须是 YYYYMMDD-rN，例如 20260918-r1'
fi
if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
  [[ "$PUBLIC_HEALTH_URL" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || die '--public-health-url 必须是 HTTPS URL'
fi

[[ "$(id -u)" == 0 ]] || die '请使用 root 或 sudo 运行；脚本需要安装服务、切换程序目录或操作 Docker'

if [[ "$MODE" == auto ]]; then
  if [[ -e /etc/systemd/system/openlabstock.service || -f /opt/openlabstock/server.mjs ]]; then
    MODE=systemd
  elif [[ -f /opt/openlabstock-docker/.env ]]; then
    MODE=docker
  elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    MODE=docker
  else
    MODE=systemd
  fi
  log "自动选择部署模式：$MODE"
fi

if [[ "$MODE" == systemd ]]; then
  APP_DIR="${APP_DIR:-/opt/openlabstock}"
  SERVICE_NAME="${SERVICE_NAME:-openlabstock}"
  DATA_DIR="${DATA_DIR:-/var/lib/openlabstock}"
  ENV_FILE="${ENV_FILE:-/etc/openlabstock/openlabstock.env}"
  BACKUP_DIR="${BACKUP_DIR:-/var/lib/openlabstock/backups}"
  UPDATE_SCRIPT="${UPDATE_SCRIPT:-/usr/local/sbin/openlabstock-update}"
  require_absolute_path '--app-dir' "$APP_DIR"
  require_absolute_path '--data-dir' "$DATA_DIR"
  require_absolute_path '--env-file' "$ENV_FILE"
  require_absolute_path '--backup-dir' "$BACKUP_DIR"
  require_absolute_path '--update-script' "$UPDATE_SCRIPT"
  require_safe_name '--service-name' "$SERVICE_NAME"
else
  APP_DIR="${APP_DIR:-/opt/openlabstock-docker}"
  require_absolute_path '--app-dir' "$APP_DIR"
fi

need curl
need sha256sum
need tar
need awk
need mktemp
need date
need install
need find
need mv
need rm
need grep
need readlink
need cp
need sed
need sort
need head

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
}
trap cleanup EXIT

validate_archive() {
  local archive="$1" entry required
  tar -tzf "$archive" >/dev/null || die "生产包不是有效的 gzip tar：$archive"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* && "$entry" != *'../'* && "$entry" != '..'* ]] || die "生产包包含危险路径：$entry"
    [[ "$entry" != *.sqlite && "$entry" != *.sqlite-* && "$entry" != *.log ]] || die "生产包不应包含数据库或日志：$entry"
  done < <(tar -tzf "$archive")
  for required in package.json server.mjs storage.mjs password.mjs dist/index.html scripts/backup.mjs; do
    tar -tzf "$archive" | grep -Fx "$required" >/dev/null || die "生产包缺少必需文件：$required"
  done
  if [[ "$MODE" == systemd ]]; then
    for required in deploy/openlabstock.service deploy/systemd/install-openlabstock.sh deploy/systemd/update-openlabstock.sh; do
      tar -tzf "$archive" | grep -Fx "$required" >/dev/null || die "生产包缺少必需文件：$required"
    done
  else
    for required in Dockerfile compose.yaml deploy/docker/openlabstock.sh; do
      tar -tzf "$archive" | grep -Fx "$required" >/dev/null || die "生产包缺少必需文件：$required"
    done
  fi
}

prepare_release() {
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openlabstock-release.XXXXXX")"
  local archive_name manifest_name expected actual archive_field manifest_version manifest_release package_version
  if [[ -n "$PACKAGE" || -n "$MANIFEST" ]]; then
    [[ -n "$PACKAGE" && -n "$MANIFEST" ]] || die '离线模式必须同时提供 --package 和 --manifest'
    [[ -f "$PACKAGE" && -f "$MANIFEST" ]] || die '找不到 --package 或 --manifest 文件'
    PACKAGE="$(readlink -f "$PACKAGE")"
    MANIFEST="$(readlink -f "$MANIFEST")"
  else
    [[ -n "$RELEASE" ]] || die '安装或更新需要 --release，或同时提供 --package 和 --manifest'
    archive_name="OpenLabStock-production-${RELEASE}.tar.gz"
    manifest_name="OpenLabStock-production-${RELEASE}.manifest.txt"
    PACKAGE="$WORK_DIR/$archive_name"
    MANIFEST="$WORK_DIR/$manifest_name"
    log "下载固定版本 $REPO@$RELEASE"
    curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 600 \
      "https://github.com/$REPO/releases/download/$RELEASE/$archive_name" -o "$PACKAGE"
    curl --fail --location --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 \
      "https://github.com/$REPO/releases/download/$RELEASE/$manifest_name" -o "$MANIFEST"
  fi

  expected="$(awk -F': ' '$1 == "sha256" { print toupper($2); exit }' "$MANIFEST")"
  archive_field="$(awk -F': ' '$1 == "archive" { print $2; exit }' "$MANIFEST")"
  manifest_version="$(awk -F': ' '$1 == "version" { print $2; exit }' "$MANIFEST")"
  manifest_release="$(awk -F': ' '$1 == "release" { print $2; exit }' "$MANIFEST")"
  [[ "$expected" =~ ^[A-F0-9]{64}$ ]] || die 'manifest 缺少有效的 sha256 字段'
  [[ "$(basename "$archive_field")" == "$(basename "$PACKAGE")" ]] || die 'manifest 的 archive 与生产包文件名不一致'
  [[ "$manifest_version" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}-r[0-9]+$ ]] || die 'manifest 缺少有效的 version 字段'
  [[ "$manifest_release" =~ ^[0-9]{8}-r[0-9]+$ ]] || die 'manifest 缺少有效的 release 字段'
  if [[ -n "$RELEASE" && "$manifest_release" != "$RELEASE" ]]; then
    die "manifest 的 release 与 --release 不一致：$manifest_release != $RELEASE"
  fi
  package_version="$(tar -xOzf "$PACKAGE" package.json | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [[ "$package_version" == "$manifest_version" ]] || die "package.json 版本与 manifest 不一致：$package_version != $manifest_version"
  actual="$(sha256sum "$PACKAGE" | awk '{print toupper($1)}')"
  [[ "$actual" == "$expected" ]] || die "SHA-256 不匹配：实际为 $actual，清单为 $expected"
  log "SHA-256 校验通过：$actual"
  validate_archive "$PACKAGE"
}

extract_release() {
  local target="$WORK_DIR/source"
  install -d -m 755 "$target"
  tar -xzf "$PACKAGE" -C "$target" --no-same-owner
  printf '%s' "$target"
}

systemd_env() {
  export OPENLABSTOCK_APP_DIR="$APP_DIR"
  export OPENLABSTOCK_SERVICE_NAME="$SERVICE_NAME"
  export OPENLABSTOCK_DATA_DIR="$DATA_DIR"
  export OPENLABSTOCK_ENV_FILE="$ENV_FILE"
  export OPENLABSTOCK_BACKUP_DIR="$BACKUP_DIR"
  if [[ -n "$PUBLIC_HEALTH_URL" ]]; then export OPENLABSTOCK_PUBLIC_HEALTH_URL="$PUBLIC_HEALTH_URL"; fi
}

systemd_action() {
  local source helper install_args=()
  source="$(extract_release)"
  helper="$source/deploy/systemd/update-openlabstock.sh"
  case "$ACTION" in
    install)
      [[ ! -e "$APP_DIR" ]] || die "已检测到程序目录：$APP_DIR；已有实例请使用 update"
      systemd_env
      if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
        install_args+=(--public-health-url "$PUBLIC_HEALTH_URL")
      fi
      bash "$source/deploy/systemd/install-openlabstock.sh" \
        --package "$PACKAGE" --manifest "$MANIFEST" \
        "${install_args[@]}"
      ;;
    update)
      [[ -d "$APP_DIR" ]] || die "找不到程序目录：$APP_DIR；首次部署请使用 install"
      systemd_env
      bash "$helper" update "$PACKAGE" --manifest "$MANIFEST"
      install -o root -g root -m 755 "$helper" "$UPDATE_SCRIPT"
      log "已安装本次版本的更新辅助脚本：$UPDATE_SCRIPT"
      ;;
    status|doctor|backup|rollback)
      [[ -x "$UPDATE_SCRIPT" ]] || die "找不到更新辅助脚本：$UPDATE_SCRIPT；请先完成首次安装"
      systemd_env
      bash "$UPDATE_SCRIPT" "$ACTION"
      ;;
  esac
}

docker_require() {
  need docker
  docker compose version >/dev/null 2>&1 || die '缺少 Docker Compose v2 插件'
  docker info >/dev/null 2>&1 || die '当前账号无法连接 Docker Engine'
}

docker_action() {
  local source previous failed current
  docker_require
  case "$ACTION" in
    install)
      [[ ! -e "$APP_DIR" ]] || die "已检测到 Docker 程序目录：$APP_DIR；已有实例请使用 update"
      source="$(extract_release)"
      mv "$source" "$APP_DIR"
      WORK_DIR=''
      bash "$APP_DIR/deploy/docker/openlabstock.sh" init
      ;;
    update)
      [[ -f "$APP_DIR/.env" ]] || die "找不到 Docker 部署：$APP_DIR/.env；首次部署请使用 install"
      source="$(extract_release)"
      cp -a "$APP_DIR/.env" "$source/.env"
      if [[ -d "$APP_DIR/backup-exports" ]]; then cp -a "$APP_DIR/backup-exports" "$source/backup-exports"; fi
      previous="${APP_DIR}.previous-$(date -u +%Y%m%dT%H%M%SZ)-$$"
      failed="${APP_DIR}.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
      mv "$APP_DIR" "$previous"
      mv "$source" "$APP_DIR"
      WORK_DIR=''
      if ! bash "$APP_DIR/deploy/docker/openlabstock.sh" update; then
        mv "$APP_DIR" "$failed" || true
        mv "$previous" "$APP_DIR" || true
        bash "$APP_DIR/deploy/docker/openlabstock.sh" up || true
        die "Docker 更新未通过健康检查，已恢复旧程序目录：$APP_DIR"
      fi
      log "Docker 更新完成；旧程序目录保留在：$previous"
      ;;
    status|backup)
      [[ -f "$APP_DIR/.env" ]] || die "找不到 Docker 部署：$APP_DIR/.env"
      bash "$APP_DIR/deploy/docker/openlabstock.sh" "$ACTION"
      ;;
    rollback)
      [[ -f "$APP_DIR/.env" ]] || die "找不到 Docker 部署：$APP_DIR/.env"
      previous="$(find "$(dirname "$APP_DIR")" -mindepth 1 -maxdepth 1 -type d -name "$(basename "$APP_DIR").previous-*" -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed 's/^[^ ]* //' | head -n 1)"
      [[ -n "$previous" && -d "$previous" ]] || die "没有找到可回滚的 Docker 程序目录"
      current="${APP_DIR}.failed-rollback-$(date -u +%Y%m%dT%H%M%SZ)-$$"
      # The Docker helper keeps the previous image under the rollback tag.
      # Retag it before swapping source directories so the restored compose
      # files and the restored image stay on the same release.
      bash "$APP_DIR/deploy/docker/openlabstock.sh" rollback
      log "停止当前 Docker 实例，切换到：$previous"
      bash "$APP_DIR/deploy/docker/openlabstock.sh" down || true
      mv "$APP_DIR" "$current"
      mv "$previous" "$APP_DIR"
      if ! bash "$APP_DIR/deploy/docker/openlabstock.sh" up; then
        mv "$APP_DIR" "$previous"
        mv "$current" "$APP_DIR"
        bash "$APP_DIR/deploy/docker/openlabstock.sh" up || true
        die "Docker 程序目录回滚后健康检查失败，已恢复原目录：$APP_DIR"
      fi
      log "Docker 回滚完成；被回滚的程序目录保留在：$current"
      ;;
    doctor)
      [[ -f "$APP_DIR/.env" ]] || die "找不到 Docker 部署：$APP_DIR/.env"
      bash "$APP_DIR/deploy/docker/openlabstock.sh" status
      ;;
  esac
}

case "$ACTION" in
  help) usage; exit 0 ;;
  install|update) prepare_release ;;
esac

if [[ "$MODE" == systemd ]]; then
  systemd_action
else
  docker_action
fi
