#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.docker.example"
EXPORT_DIR="$ROOT_DIR/backup-exports"

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die '未安装 Docker Engine。请先按 Docker 官方 Ubuntu 文档安装 Engine 与 Compose 插件。'
  docker compose version >/dev/null 2>&1 || die '缺少 Docker Compose v2 插件。'
  docker info >/dev/null 2>&1 || die '当前账号无法连接 Docker；请使用有权限的维护账号。'
}

need_env() {
  [[ -f "$ENV_FILE" ]] || die '缺少 .env。首次部署请运行：bash deploy/docker/openlabstock.sh init'
}

compose() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

replace_env() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "$ROOT_DIR/.env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

generated_password() {
  od -An -N16 -tx1 /dev/urandom | tr -d ' \n'
}

package_version() {
  local version
  version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -n 1)"
  [[ -n "$version" ]] || die '无法从 package.json 读取应用版本。'
  printf '%s' "$version"
}

health() {
  compose exec -T app node -e "fetch('http://127.0.0.1:4388/api/health').then(async r=>{console.log(await r.text());if(!r.ok)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})"
}

backup() {
  need_env
  compose exec -T app node scripts/backup.mjs
  local latest
  latest="$(compose exec -T app sh -lc 'ls -1t /var/backups/openlabstock/labstock-*.sqlite | head -n 1' | tr -d '\r')"
  [[ -n "$latest" ]] || die '容器内没有找到刚生成的备份。'
  install -d -m 700 "$EXPORT_DIR"
  compose cp "app:$latest" "$EXPORT_DIR/"
  printf '已额外导出到宿主机：%s/%s\n' "$EXPORT_DIR" "$(basename "$latest")"
}

init_install() {
  [[ ! -e "$ENV_FILE" ]] || die '.env 已存在。已有部署请使用 up 或 update，不要重复初始化。'
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet openlabstock 2>/dev/null; then
    die '检测到原生 openlabstock.service 正在运行。请先做一致性备份并按 Docker 文档完成迁移，不能让两套服务同时写库。'
  fi

  cp "$ENV_EXAMPLE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  local password
  password="$(generated_password)"
  replace_env INITIAL_ADMIN_PASSWORD "$password"
  replace_env OPENLABSTOCK_IMAGE_VERSION "$(package_version)"

  compose config --quiet
  compose build --pull
  if ! compose up -d --wait; then
    compose logs --tail=100 app >&2 || true
    die '首次启动失败；数据卷不会被自动删除。'
  fi

  # The password is needed only to hash the initial owner account. Recreate the
  # container without the plaintext secret once the database exists.
  replace_env INITIAL_ADMIN_PASSWORD ''
  compose up -d --force-recreate --wait
  health
  printf '\n首次部署完成。\n登录账号：admin\n初始密码：%s\n请登录后立即修改，并妥善保存系统所有者账号。\n' "$password"
}

update_install() {
  need_env
  backup
  replace_env OPENLABSTOCK_IMAGE_VERSION "$(package_version)"
  local current_id
  current_id="$(compose images -q app | head -n 1)"
  if [[ -n "$current_id" ]]; then docker image tag "$current_id" openlabstock:rollback; fi
  compose build --pull
  if ! compose up -d --wait; then
    compose logs --tail=100 app >&2 || true
    die '新版本未通过健康检查。可运行：bash deploy/docker/openlabstock.sh rollback'
  fi
  health
}

rollback_install() {
  need_env
  docker image inspect openlabstock:rollback >/dev/null 2>&1 || die '没有找到 openlabstock:rollback 镜像。'
  local tag
  tag="$(awk -F= '$1 == "OPENLABSTOCK_IMAGE_TAG" { print substr($0, index($0, "=") + 1) }' "$ENV_FILE" | tail -n 1)"
  docker image tag openlabstock:rollback "openlabstock:${tag:-latest}"
  compose up -d --force-recreate --wait
  health
}

usage() {
  cat <<'EOF'
用法：bash deploy/docker/openlabstock.sh <命令>

  init      首次部署：生成所有者密码、构建、启动并清除明文初始化密码
  up        启动现有部署并等待健康检查
  update    先备份，再构建和切换新镜像
  backup    生成一致性备份，并复制一份到 ./backup-exports
  rollback  切回 update 前保留的本机镜像
  status    查看容器、健康状态与版本
  logs      持续查看应用日志
  down      停止容器；不会删除数据库卷或备份卷
  smoke     使用独立临时卷执行 Docker 端到端验收，不接触正式数据
EOF
}

need_docker
case "${1:-}" in
  init) init_install ;;
  up) need_env; compose up -d --wait; health ;;
  update) update_install ;;
  backup) backup ;;
  rollback) rollback_install ;;
  status) need_env; compose ps; health ;;
  logs) need_env; compose logs -f --tail=100 app ;;
  down) need_env; compose down ;;
  smoke) bash "$SCRIPT_DIR/smoke-test.sh" ;;
  *) usage; exit 1 ;;
esac
