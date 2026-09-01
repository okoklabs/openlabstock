#!/usr/bin/env bash
set -Eeuo pipefail

# Atomic application-directory deployment for a single Node/systemd instance.
# The database is deliberately outside APP_DIR and is never moved by this file.

SCRIPT_NAME="$(basename "$0")"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*"
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

[[ "$(id -u)" == 0 ]] || die "请使用 root 或 sudo 运行此脚本；目录切换和 systemd 操作不能由普通账号完成"
need_command systemctl
need_command curl
need_command sha256sum
need_command tar
need_command flock
need_command node
need_command awk
need_command grep
need_command sed
need_command find
need_command stat
need_command readlink
need_command journalctl
need_command seq

APP_DIR="${OPENLABSTOCK_APP_DIR:-/opt/openlabstock}"
SERVICE_NAME="${OPENLABSTOCK_SERVICE_NAME:-openlabstock}"
DATA_DIR="${OPENLABSTOCK_DATA_DIR:-/var/lib/openlabstock}"
ENV_FILE="${OPENLABSTOCK_ENV_FILE:-/etc/openlabstock/openlabstock.env}"
BACKUP_DIR="${OPENLABSTOCK_BACKUP_DIR:-}"

detect_existing_systemd_layout() {
  # A migration may retain an older unit name. Discover the unit by its
  # Node entry point instead of embedding an instance-specific name or path.
  if [[ -n "${OPENLABSTOCK_APP_DIR:-}" || -n "${OPENLABSTOCK_SERVICE_NAME:-}" || \
        -e /etc/systemd/system/openlabstock.service ]]; then
    return
  fi
  local unit exec_start working_directory environment_files token
  while IFS= read -r unit; do
    [[ "$unit" == *.service && "$unit" != openlabstock.service ]] || continue
    exec_start="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null || true)"
    [[ "$exec_start" == *server.mjs* ]] || continue
    working_directory="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
    [[ -n "$working_directory" && "$working_directory" != / ]] || continue
    SERVICE_NAME="${unit%.service}"
    APP_DIR="$working_directory"
    environment_files="$(systemctl show -p EnvironmentFiles --value "$unit" 2>/dev/null || true)"
    for token in $environment_files; do
      token="${token#-}"
      if [[ "$token" == /* && -f "$token" ]]; then
        ENV_FILE="$token"
        break
      fi
    done
    return
  done < <(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}')
}

detect_existing_systemd_layout
env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

if [[ -z "${OPENLABSTOCK_DATA_DIR:-}" ]]; then
  configured_data_dir="$(env_value DATA_DIR || true)"
  [[ -z "$configured_data_dir" ]] || DATA_DIR="$configured_data_dir"
fi
if [[ -z "${OPENLABSTOCK_BACKUP_DIR:-}" ]]; then
  configured_backup_dir="$(env_value BACKUP_DIR || true)"
  if [[ -n "$configured_backup_dir" ]]; then
    BACKUP_DIR="$configured_backup_dir"
  else
    BACKUP_DIR="$DATA_DIR/backups"
  fi
fi

configured_port="$(env_value PORT || true)"
PORT="${OPENLABSTOCK_PORT:-${configured_port:-4388}}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT 必须是数字：$PORT"
(( PORT >= 1 && PORT <= 65535 )) || die "PORT 超出范围：$PORT"
HEALTH_URL="${OPENLABSTOCK_HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
PUBLIC_HEALTH_URL="${OPENLABSTOCK_PUBLIC_HEALTH_URL:-}"
NODE_BIN="${OPENLABSTOCK_NODE_BIN:-/usr/bin/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node)"

LOCK_FILE="${OPENLABSTOCK_LOCK_FILE:-/run/lock/openlabstock-update.lock}"
install -d -m 755 "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
flock -n 9 || die "已有另一个更新或回滚正在运行，请等待它完成"

service_user() {
  local value
  value="$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ -n "$value" && "$value" != "root" && "$value" != "-" ]]; then
    printf '%s' "$value"
  else
    stat -c '%U' "$APP_DIR" 2>/dev/null || printf 'root'
  fi
}

service_group() {
  local value
  value="$(systemctl show -p Group --value "$SERVICE_NAME" 2>/dev/null || true)"
  if [[ -n "$value" && "$value" != "-" ]]; then
    printf '%s' "$value"
  else
    stat -c '%G' "$APP_DIR" 2>/dev/null || printf 'root'
  fi
}

SERVICE_USER="$(service_user)"
SERVICE_GROUP="$(service_group)"

require_service() {
  systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || die "找不到 systemd 服务：${SERVICE_NAME}.service"
}

read_version() {
  local directory="$1"
  [[ -f "$directory/package.json" ]] || return 1
  "$NODE_BIN" -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!p.version) process.exit(2); process.stdout.write(String(p.version));' "$directory/package.json"
}

validate_version() {
  local version="$1"
  [[ "$version" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}-r[0-9]+$ ]] || die "package.json version 格式无效：$version"
}

validate_release_tree() {
  local package="$1" entry
  tar -tzf "$package" >/dev/null || die "生产包不是有效的 gzip tar：$package"
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* && "$entry" != *"../"* && "$entry" != ".."* ]] || die "生产包包含危险路径：$entry"
    [[ "$entry" != *.sqlite && "$entry" != *.sqlite-* && "$entry" != *.log ]] || die "生产包不应包含数据库或日志：$entry"
  done < <(tar -tzf "$package")
  for entry in package.json server.mjs storage.mjs password.mjs dist/index.html scripts/backup.mjs; do
    tar -tzf "$package" | grep -Fxq "$entry" || die "生产包缺少必需文件：$entry"
  done
}

verify_health() {
  local expected_version="$1" body
  body="$(curl --silent --show-error --fail --max-time 5 "$HEALTH_URL")" || return 1
  "$NODE_BIN" -e 'const body=JSON.parse(process.argv[1]); const expected=process.argv[2]; if (body.ok !== true || body.version !== expected) process.exit(1);' "$body" "$expected_version" || return 1
  if [[ -n "$PUBLIC_HEALTH_URL" ]]; then
    curl --silent --show-error --fail --max-time 10 "$PUBLIC_HEALTH_URL" >/dev/null || return 1
  fi
}

wait_for_health() {
  local expected_version="$1" attempt body=''
  for attempt in $(seq 1 30); do
    if verify_health "$expected_version"; then
      log "健康检查通过：$expected_version"
      return 0
    fi
    body="$(curl --silent --show-error --max-time 3 "$HEALTH_URL" 2>&1 || true)"
    [[ -n "$body" ]] && log "等待服务就绪（${attempt}/30）：${body:0:240}"
    sleep 1
  done
  systemctl status "$SERVICE_NAME" --no-pager >&2 || true
  journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
  return 1
}

run_as_service() {
  if [[ "$SERVICE_USER" == root ]]; then
    env "$@"
  else
    command -v runuser >/dev/null 2>&1 || die "缺少 runuser，无法以 ${SERVICE_USER} 运行备份"
    runuser -u "$SERVICE_USER" -- env "$@"
  fi
}

consistent_backup() {
  [[ -f "$DATA_DIR/labstock.sqlite" ]] || die "找不到数据库：$DATA_DIR/labstock.sqlite"
  [[ -f "$APP_DIR/scripts/backup.mjs" ]] || die "当前程序缺少 scripts/backup.mjs，无法在更新前备份"
  id "$SERVICE_USER" >/dev/null 2>&1 || die "systemd 服务账号不存在：$SERVICE_USER"
  install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 700 "$BACKUP_DIR"
  log "开始 SQLite 一致性备份"
  run_as_service DATA_DIR="$DATA_DIR" BACKUP_DIR="$BACKUP_DIR" BACKUP_RETENTION_DAYS="${OPENLABSTOCK_BACKUP_RETENTION_DAYS:-30}" "$NODE_BIN" "$APP_DIR/scripts/backup.mjs"
}

package_path() {
  local value="$1"
  [[ -f "$value" ]] || die "找不到生产包：$value"
  readlink -f "$value"
}

extract_release() {
  local package="$1" staging="$2"
  install -d -o root -g root -m 755 "$staging"
  tar --extract --gzip --file "$package" --directory "$staging" --no-same-owner
  chown -R root:root "$staging"
  chmod -R a+rX "$staging"
  [[ -f "$staging/server.mjs" && -f "$staging/dist/index.html" ]] || die "解包后缺少运行时文件"
  "$NODE_BIN" --check "$staging/server.mjs"
  local version
  version="$(read_version "$staging")" || die "无法读取候选版本 package.json"
  validate_version "$version"
  printf '%s' "$version"
}

latest_previous() {
  local candidate
  while IFS= read -r candidate; do
    if [[ -f "$candidate/server.mjs" && -f "$candidate/package.json" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done < <(find "$(dirname "$APP_DIR")" -mindepth 1 -maxdepth 1 -type d -name "$(basename "$APP_DIR")-previous-*" -printf '%T@ %p\n' 2>/dev/null | sort -nr | sed 's/^[^ ]* //')
  return 1
}

timestamped_dir() {
  local suffix="$1"
  printf '%s-%s-%s' "$APP_DIR" "$suffix" "$(date -u +%Y%m%dT%H%M%SZ)-$$"
}

UPDATE_OLD_MOVED=0
UPDATE_NEW_MOVED=0
UPDATE_SERVICE_STOPPED=0
UPDATE_PREVIOUS=''
UPDATE_FAILED=''
UPDATE_STAGING=''
UPDATE_EXPECTED_VERSION=''

restore_after_failure() {
  local status="$1" restored_version=''
  trap - EXIT INT TERM
  if (( UPDATE_OLD_MOVED )); then
    log "新版本未通过检查，开始自动恢复旧程序目录"
    systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if (( UPDATE_NEW_MOVED )) && [[ -e "$APP_DIR" ]]; then
      UPDATE_FAILED="${UPDATE_FAILED:-$(timestamped_dir failed-update)}"
      mv "$APP_DIR" "$UPDATE_FAILED" || true
      log "失败程序已保留：$UPDATE_FAILED"
    fi
    if [[ -e "$UPDATE_PREVIOUS" && ! -e "$APP_DIR" ]]; then
      mv "$UPDATE_PREVIOUS" "$APP_DIR" || true
    fi
    if [[ -e "$APP_DIR" ]]; then
      restored_version="$(read_version "$APP_DIR" 2>/dev/null || true)"
      if [[ -n "$restored_version" ]] && systemctl start "$SERVICE_NAME" >/dev/null 2>&1 && wait_for_health "$restored_version"; then
        log "自动回滚完成，当前版本：$restored_version"
      else
        log "自动回滚未通过健康检查，请执行：journalctl -u $SERVICE_NAME -n 120 --no-pager"
      fi
    else
      log "无法找到旧程序目录，服务保持停止状态"
    fi
  elif (( UPDATE_SERVICE_STOPPED )); then
    # A failure before the first directory move must not leave a healthy
    # existing release offline.
    log "目录尚未切换，重新启动当前程序"
    systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || true
    current_version="$(read_version "$APP_DIR" 2>/dev/null || true)"
    [[ -z "$current_version" ]] || wait_for_health "$current_version" || true
  fi
  if [[ -n "$UPDATE_STAGING" && -e "$UPDATE_STAGING" ]]; then
    rm -rf -- "$UPDATE_STAGING"
  fi
  exit "$status"
}

update_install() {
  local package="$1" expected_hash="${2:-}" actual_hash staging candidate_version current_version
  require_service
  [[ -d "$APP_DIR" ]] || die "当前程序目录不存在：$APP_DIR"
  [[ -f "$APP_DIR/server.mjs" ]] || die "当前程序目录不完整：$APP_DIR"
  package="$(package_path "$package")"
  if [[ -n "$expected_hash" ]]; then
    [[ "$expected_hash" =~ ^[A-Fa-f0-9]{64}$ ]] || die '--sha256 必须是 64 位十六进制字符串'
    actual_hash="$(sha256sum "$package" | awk '{print toupper($1)}')"
    [[ "$actual_hash" == "$(printf '%s' "$expected_hash" | tr '[:lower:]' '[:upper:]')" ]] || die "SHA-256 不匹配：实际为 $actual_hash"
    log "SHA-256 校验通过：$actual_hash"
  else
    log "未提供 --sha256；建议核对发布清单中的 SHA-256"
  fi
  validate_release_tree "$package"
  staging="$(timestamped_dir staging)"
  UPDATE_STAGING="$staging"
  candidate_version="$(extract_release "$package" "$staging")"
  current_version="$(read_version "$APP_DIR" 2>/dev/null || true)"
  [[ "$candidate_version" != "$current_version" ]] || log "警告：候选版本与当前版本相同（$candidate_version）"
  UPDATE_EXPECTED_VERSION="$candidate_version"

  # Install the failure trap before the backup as well, so a failed backup
  # removes only this run's staging directory and never touches the service.
  trap 'restore_after_failure $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  consistent_backup
  UPDATE_PREVIOUS="$(timestamped_dir previous)"
  UPDATE_FAILED="$(timestamped_dir failed-update)"

  log "停止 $SERVICE_NAME.service，切换到 $candidate_version"
  systemctl stop "$SERVICE_NAME"
  UPDATE_SERVICE_STOPPED=1
  mv "$APP_DIR" "$UPDATE_PREVIOUS"
  UPDATE_OLD_MOVED=1
  mv "$staging" "$APP_DIR"
  UPDATE_NEW_MOVED=1
  UPDATE_STAGING=''
  systemctl start "$SERVICE_NAME"
  wait_for_health "$candidate_version"
  trap - EXIT INT TERM
  log "更新完成：$candidate_version"
  log "上一版本保留在：$UPDATE_PREVIOUS（确认稳定后再手工 prune）"
}

rollback_install() {
  local target="${1:-}" current_version target_version failed_dir restored_version
  require_service
  if [[ -z "$target" ]]; then
    target="$(latest_previous || true)"
  else
    target="$(readlink -f "$target")"
  fi
  [[ -n "$target" && -d "$target" ]] || die "没有找到可回滚的 previous 目录"
  [[ -f "$target/server.mjs" ]] || die "回滚目录不完整：$target"
  target_version="$(read_version "$target" 2>/dev/null || true)"
  validate_version "$target_version"
  [[ -d "$APP_DIR" ]] || die "当前程序目录不存在：$APP_DIR"
  current_version="$(read_version "$APP_DIR" 2>/dev/null || true)"
  [[ "$target" != "$APP_DIR" ]] || die '回滚目标不能是当前程序目录'
  failed_dir="$(timestamped_dir failed-rollback)"

  trap 'restore_after_failure $?' EXIT
  # For rollback, the currently running release is the directory that must be
  # restored if anything fails. It becomes the previous location after the
  # first move; the selected target is only moved after that succeeds.
  UPDATE_PREVIOUS="$failed_dir"
  UPDATE_FAILED="$(timestamped_dir failed-rollback-recovery)"
  UPDATE_OLD_MOVED=0
  UPDATE_NEW_MOVED=0
  log "停止 $SERVICE_NAME.service，回滚到 $target_version"
  systemctl stop "$SERVICE_NAME"
  UPDATE_SERVICE_STOPPED=1
  mv "$APP_DIR" "$failed_dir"
  UPDATE_OLD_MOVED=1
  mv "$target" "$APP_DIR"
  UPDATE_NEW_MOVED=1
  systemctl start "$SERVICE_NAME"
  wait_for_health "$target_version"
  trap - EXIT INT TERM
  log "回滚完成：$target_version"
  log "被回滚的程序保留在：$failed_dir"
  log "注意：本命令只切换程序，不自动恢复数据库；如需恢复数据，请使用已验证的 SQLite 备份并先停止服务"
}

status_install() {
  require_service
  printf '程序目录：%s\n服务：%s.service\n数据目录：%s\n健康地址：%s\n' "$APP_DIR" "$SERVICE_NAME" "$DATA_DIR" "$HEALTH_URL"
  printf '当前版本：%s\n' "$(read_version "$APP_DIR" 2>/dev/null || printf '未知')"
  if previous="$(latest_previous || true)"; then
    printf '可回滚版本：%s (%s)\n' "$previous" "$(read_version "$previous" 2>/dev/null || printf '未知')"
  else
    printf '可回滚版本：无\n'
  fi
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  if version="$(read_version "$APP_DIR" 2>/dev/null || true)" && [[ -n "$version" ]]; then
    verify_health "$version" && log '健康检查：通过' || log '健康检查：失败'
  fi
}

prune_install() {
  local days="${1:-30}" confirm="${2:-}" candidate
  [[ "$days" =~ ^[0-9]+$ ]] || die 'prune 天数必须是非负整数'
  (( days >= 7 )) || die '为保留应急回滚窗口，prune 至少保留 7 天'
  [[ "$confirm" == --yes ]] || die "该操作会永久删除旧程序目录；确认后重新执行：$SCRIPT_NAME prune $days --yes"
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    log "删除旧程序目录：$candidate"
    rm -rf -- "$candidate"
  done < <(find "$(dirname "$APP_DIR")" -mindepth 1 -maxdepth 1 -type d \( -name "$(basename "$APP_DIR")-previous-*" -o -name "$(basename "$APP_DIR")-failed-*" \) -mtime +"$days" -print)
}

usage() {
  cat <<EOF
用法：sudo $SCRIPT_NAME <命令> [参数]

命令：
  update <生产包.tar.gz> [--sha256 HASH]
      备份数据库，校验并解包生产包，切换程序；失败自动恢复旧目录。
  rollback [previous目录]
      切回最近的 previous 目录；失败自动恢复当前程序目录。
  status
      查看目录、版本、systemd 状态和健康检查。
  prune <保留天数> --yes
      删除超过保留天数的 previous/failed 程序目录（不触碰数据库）。

默认目录是 /opt/openlabstock、/var/lib/openlabstock 和 openlabstock.service。
如果现有实例保留了旧服务名，脚本会根据 systemd 的 Node server.mjs、工作目录和环境文件自动发现；
也可以用 OPENLABSTOCK_APP_DIR、OPENLABSTOCK_SERVICE_NAME、OPENLABSTOCK_DATA_DIR、
OPENLABSTOCK_ENV_FILE、OPENLABSTOCK_BACKUP_DIR 显式指定，避免依赖自动发现。
EOF
}

command_name="${1:-}"
shift || true
case "$command_name" in
  update)
    package="${1:-}"
    shift || true
    [[ -n "$package" ]] || die 'update 需要生产包路径'
    hash=''
    while (($#)); do
      case "$1" in
        --sha256) hash="${2:-}"; shift 2 || die '--sha256 需要哈希值' ;;
        --sha256=*) hash="${1#*=}"; shift ;;
        *) die "未知参数：$1" ;;
      esac
    done
    update_install "$package" "$hash"
    ;;
  rollback)
    [[ $# -le 1 ]] || die 'rollback 最多接受一个目录参数'
    rollback_install "${1:-}"
    ;;
  status)
    [[ $# -eq 0 ]] || die 'status 不接受参数'
    status_install
    ;;
  prune)
    [[ $# -le 2 ]] || die 'prune 用法：prune <保留天数> --yes'
    prune_install "${1:-30}" "${2:-}"
    ;;
  -h|--help|help|'')
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac


