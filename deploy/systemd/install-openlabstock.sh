#!/usr/bin/env bash
set -Eeuo pipefail

# Safe first-install helper for one OpenLabStock systemd instance.
# Runtime data is kept outside the application directory.

SCRIPT_NAME="$(basename "$0")"
APP_DIR="${OPENLABSTOCK_APP_DIR:-/opt/openlabstock}"
DATA_DIR="${OPENLABSTOCK_DATA_DIR:-/var/lib/openlabstock}"
ENV_FILE="${OPENLABSTOCK_ENV_FILE:-/etc/openlabstock/openlabstock.env}"
SERVICE_NAME="${OPENLABSTOCK_SERVICE_NAME:-openlabstock}"
BACKUP_DIR="${OPENLABSTOCK_BACKUP_DIR:-$DATA_DIR/backups}"
SYSTEM_USER="${OPENLABSTOCK_SYSTEM_USER:-openlabstock}"
SYSTEM_GROUP="${OPENLABSTOCK_SYSTEM_GROUP:-openlabstock}"
NODE_BIN="${OPENLABSTOCK_NODE_BIN:-$(command -v node || true)}"

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S%z')" "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

[[ "$(id -u)" == 0 ]] || die '首次安装需要 root 或 sudo。'
for command_name in systemctl curl sha256sum tar awk grep sed install mktemp find stat getent readlink groupadd useradd id od seq journalctl tr sleep rm chmod chown; do need "$command_name"; done
[[ -x "$NODE_BIN" ]] || die '找不到 Node.js。请先安装 Node.js >= 22.12.0。'

PACKAGE=''
MANIFEST=''
INITIAL_PASSWORD="${OPENLABSTOCK_INITIAL_ADMIN_PASSWORD:-}"
PUBLIC_HEALTH_URL=''

usage() {
  cat <<EOF
用法：sudo $SCRIPT_NAME --package 生产包.tar.gz --manifest 发布清单.txt [选项]

首次安装使用默认目录：
  程序：$APP_DIR
  数据：$DATA_DIR
  环境：$ENV_FILE
  服务：$SERVICE_NAME.service

选项：
  --package PATH                 已下载并准备校验的生产包
  --manifest PATH                与生产包同版本的 manifest
  --initial-admin-password TEXT  首次管理员密码；不提供时自动生成一次
  --public-health-url URL        安装后额外检查公网 HTTPS 健康地址
  -h, --help                     显示帮助

已有实例请使用 update-openlabstock.sh update，不要重复运行首次安装。
EOF
}

while (($#)); do
  case "$1" in
    --package) PACKAGE="${2:-}"; shift 2 || die '--package 需要路径' ;;
    --package=*) PACKAGE="${1#*=}"; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 || die '--manifest 需要路径' ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --initial-admin-password) INITIAL_PASSWORD="${2:-}"; shift 2 || die '--initial-admin-password 需要值' ;;
    --initial-admin-password=*) INITIAL_PASSWORD="${1#*=}"; shift ;;
    --public-health-url) PUBLIC_HEALTH_URL="${2:-}"; shift 2 || die '--public-health-url 需要 URL' ;;
    --public-health-url=*) PUBLIC_HEALTH_URL="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done

[[ -n "$PACKAGE" && -f "$PACKAGE" ]] || die '请提供存在的 --package 生产包路径'
[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || die '请提供存在的 --manifest 清单路径'
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || die '服务名包含不安全字符'
[[ "$APP_DIR" == /opt/openlabstock && "$DATA_DIR" == /var/lib/openlabstock && "$ENV_FILE" == /etc/openlabstock/openlabstock.env && "$BACKUP_DIR" == /var/lib/openlabstock/backups && "$SERVICE_NAME" == openlabstock && "$SYSTEM_USER" == openlabstock && "$SYSTEM_GROUP" == openlabstock ]] || die '首次安装使用默认目录和服务名；自定义实例请按 DEPLOYMENT.md 手工配置'
[[ "$PUBLIC_HEALTH_URL" == '' || "$PUBLIC_HEALTH_URL" =~ ^https://[A-Za-z0-9._:/-]+$ ]] || die '公网健康地址必须是 HTTPS URL'

if systemctl cat "$SERVICE_NAME" >/dev/null 2>&1 || [[ -e "$APP_DIR" ]]; then
  die "检测到已有实例，请使用更新脚本：$APP_DIR"
fi

PACKAGE="$(readlink -f "$PACKAGE")"
MANIFEST="$(readlink -f "$MANIFEST")"
PACKAGE_NAME="$(basename "$PACKAGE")"
[[ "$PACKAGE_NAME" =~ ^OpenLabStock-production-[0-9]{8}-r[0-9]+\.tar\.gz$ ]] || die '生产包名称必须是 OpenLabStock-production-YYYYMMDD-rN.tar.gz'

manifest_field() { awk -F': ' -v key="$1" '$1 == key { print substr($0, length(key) + 3); exit }' "$MANIFEST"; }
EXPECTED_HASH="$(manifest_field sha256)"
MANIFEST_VERSION="$(manifest_field version)"
MANIFEST_ARCHIVE="$(basename "$(manifest_field archive)")"
[[ "$EXPECTED_HASH" =~ ^[A-Fa-f0-9]{64}$ ]] || die 'manifest 的 sha256 无效'
[[ "$MANIFEST_ARCHIVE" == "$PACKAGE_NAME" ]] || die "manifest 的 archive 与生产包不一致：$MANIFEST_ARCHIVE != $PACKAGE_NAME"
[[ "$MANIFEST_VERSION" =~ ^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}-r[0-9]+$ ]] || die 'manifest 的 version 无效'
ACTUAL_HASH="$(sha256sum "$PACKAGE" | awk '{print toupper($1)}')"
[[ "$ACTUAL_HASH" == "$(printf '%s' "$EXPECTED_HASH" | tr '[:lower:]' '[:upper:]')" ]] || die "SHA-256 不匹配：实际为 $ACTUAL_HASH"
log "SHA-256 校验通过：$ACTUAL_HASH"

validate_archive() {
  local entry required
  tar -tzf "$PACKAGE" >/dev/null || die '生产包不是有效的 gzip tar'
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* && "$entry" != *'../'* && "$entry" != '..'* ]] || die "生产包包含危险路径：$entry"
    [[ "$entry" != *.sqlite && "$entry" != *.sqlite-* && "$entry" != *.log ]] || die "生产包不应包含数据库或日志：$entry"
  done < <(tar -tzf "$PACKAGE")
  for required in package.json server.mjs storage.mjs password.mjs dist/index.html scripts/backup.mjs deploy/openlabstock.service deploy/systemd/update-openlabstock.sh; do
    tar -tzf "$PACKAGE" | grep -Fx "$required" >/dev/null || die "生产包缺少必需文件：$required"
  done
}
validate_archive

CURRENT_VERSION="$(tar -xOzf "$PACKAGE" package.json | "$NODE_BIN" -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const p=JSON.parse(data); process.stdout.write(String(p.version ?? "")); });')"
[[ "$CURRENT_VERSION" == "$MANIFEST_VERSION" ]] || die "package.json 版本与 manifest 不一致：$CURRENT_VERSION != $MANIFEST_VERSION"
tar -xOzf "$PACKAGE" server.mjs | "$NODE_BIN" --check - >/dev/null || die 'server.mjs 语法检查失败'

if ! getent group "$SYSTEM_GROUP" >/dev/null 2>&1; then groupadd --system "$SYSTEM_GROUP"; fi
if ! id "$SYSTEM_USER" >/dev/null 2>&1; then useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --gid "$SYSTEM_GROUP" "$SYSTEM_USER"; fi
install -d -o root -g root -m 755 /etc/openlabstock
install -d -o "$SYSTEM_USER" -g "$SYSTEM_GROUP" -m 700 "$DATA_DIR" "$BACKUP_DIR"

GENERATED_PASSWORD=0
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -z "$INITIAL_PASSWORD" && -t 0 ]]; then
    read -r -s -p '首次系统所有者密码（直接回车则自动生成）：' INITIAL_PASSWORD
    printf '\n'
  fi
  if [[ -z "$INITIAL_PASSWORD" ]]; then
    INITIAL_PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
    GENERATED_PASSWORD=1
  fi
  [[ "$INITIAL_PASSWORD" != *$'\n'* && "$INITIAL_PASSWORD" != *$'\r'* ]] || die '初始密码不能包含换行'
  ESCAPED_PASSWORD="${INITIAL_PASSWORD//\\/\\\\}"
  ESCAPED_PASSWORD="${ESCAPED_PASSWORD//\"/\\\"}"
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=4388
DATA_DIR=$DATA_DIR
BACKUP_DIR=$BACKUP_DIR
INSTANCE_ID=example-lab-prod
TRUST_PROXY=1
COOKIE_SECURE=1
SESSION_MAX_AGE_DAYS=15
SQLITE_BUSY_TIMEOUT_MS=10000
DATABASE_UPLOAD_MAX_BYTES=104857600
INITIAL_ADMIN_PASSWORD="$ESCAPED_PASSWORD"
EOF
  chmod 640 "$ENV_FILE"
  chown root:"$SYSTEM_GROUP" "$ENV_FILE"
fi

STAGING="$(mktemp -d /opt/openlabstock-install.XXXXXX)"
cleanup() { [[ -z "$STAGING" ]] || rm -rf -- "$STAGING"; }
trap cleanup EXIT
tar -xzf "$PACKAGE" -C "$STAGING" --no-same-owner
chown -R root:root "$STAGING"
chmod -R a+rX "$STAGING"
mv "$STAGING" "$APP_DIR"
STAGING=''

SERVICE_FILE="$(mktemp /tmp/openlabstock.service.XXXXXX)"
sed -e "s#/opt/openlabstock#$APP_DIR#g" -e "s#/usr/bin/node#$NODE_BIN#g" "$APP_DIR/deploy/openlabstock.service" >"$SERVICE_FILE"
install -o root -g root -m 644 "$SERVICE_FILE" "/etc/systemd/system/$SERVICE_NAME.service"
rm -f -- "$SERVICE_FILE"
install -o root -g root -m 755 "$APP_DIR/deploy/systemd/update-openlabstock.sh" /usr/local/sbin/openlabstock-update

systemctl daemon-reload
systemctl enable "$SERVICE_NAME.service" >/dev/null
systemctl start "$SERVICE_NAME.service"
HEALTH_URL='http://127.0.0.1:4388/api/health'
for attempt in $(seq 1 30); do
  if body="$(curl --silent --show-error --fail --max-time 3 "$HEALTH_URL" 2>/dev/null)" && "$NODE_BIN" -e 'const p=JSON.parse(process.argv[1]); if (p.ok !== true || p.version !== process.argv[2]) process.exit(1)' "$body" "$CURRENT_VERSION"; then
    log "安装完成，健康检查通过：$CURRENT_VERSION"
    if [[ -n "$PUBLIC_HEALTH_URL" ]]; then curl --fail --show-error --max-time 10 "$PUBLIC_HEALTH_URL" >/dev/null || die "公网健康检查失败：$PUBLIC_HEALTH_URL"; fi
    if (( GENERATED_PASSWORD )); then
      printf '\n首次系统所有者密码（只显示这一次）：%s\n' "$INITIAL_PASSWORD"
      printf '登录后请立即修改密码，并从 %s 删除 INITIAL_ADMIN_PASSWORD。\n' "$ENV_FILE"
    fi
    printf '\n后续操作：\n  状态：sudo /usr/local/sbin/openlabstock-update doctor\n  备份：sudo /usr/local/sbin/openlabstock-update backup\n  更新：sudo /usr/local/sbin/openlabstock-update update <包.tar.gz> --manifest <清单.txt>\n'
    exit 0
  fi
  sleep 1
done
systemctl status "$SERVICE_NAME" --no-pager >&2 || true
journalctl -u "$SERVICE_NAME" -n 80 --no-pager >&2 || true
die '服务启动或健康检查失败；程序目录和日志已保留，请先排查后再重试。'
