#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/compose.yaml"
RUN_ID="$(date -u +%Y%m%d%H%M%S)-$$"
PROJECT="openlabstock-smoke-$RUN_ID"
ENV_FILE="$(mktemp "${TMPDIR:-/tmp}/openlabstock-smoke.XXXXXX.env")"
EXPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openlabstock-smoke-export.XXXXXX")"
PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
MATERIAL_NAME="Docker smoke $RUN_ID"
INITIAL_TAG="smoke-initial-$RUN_ID"
CANDIDATE_TAG="smoke-candidate-$RUN_ID"
ROLLBACK_TAG="smoke-rollback-$RUN_ID"
STARTED=0
INITIAL_IMAGE=''
CANDIDATE_IMAGE=''

die() {
  printf 'Docker 验收失败：%s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"
}

compose() {
  docker compose --project-directory "$ROOT_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

replace_env() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "${TMPDIR:-/tmp}/openlabstock-smoke-env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$ENV_FILE"
}

start_compose() {
  if ! compose up "$@"; then
    compose logs --tail=200 app >&2 || true
    die '应用容器未通过启动或健康检查'
  fi
}

cleanup() {
  local status="$1" image
  trap - EXIT INT TERM
  if [[ "$STARTED" == 1 ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  for image in "openlabstock:$INITIAL_TAG" "openlabstock:$CANDIDATE_TAG" "openlabstock:$ROLLBACK_TAG"; do
    docker image rm "$image" >/dev/null 2>&1 || true
  done
  if [[ -n "$CANDIDATE_IMAGE" ]]; then docker image rm "$CANDIDATE_IMAGE" >/dev/null 2>&1 || true; fi
  rm -f -- "$ENV_FILE"
  rm -rf -- "$EXPORT_DIR"
  if [[ $status -eq 0 ]]; then
    printf '\nDocker 端到端验收通过；临时容器、网络和测试卷已清理。\n'
  else
    printf '\n临时 Docker 测试资源已清理，正式数据未被访问。\n' >&2
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

api_check() {
  local create_material="$1"
  compose exec -T \
    -e SMOKE_PASSWORD="$PASSWORD" \
    -e SMOKE_MATERIAL="$MATERIAL_NAME" \
    -e SMOKE_CREATE="$create_material" \
    app node --input-type=module <<'NODE'
const base = 'http://127.0.0.1:4388';
const login = await fetch(`${base}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: process.env.SMOKE_PASSWORD }),
});
if (!login.ok) throw new Error(`登录失败：${login.status} ${await login.text()}`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('登录响应没有会话 Cookie');

const request = async (pathname, options = {}) => {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname}：${response.status} ${JSON.stringify(payload)}`);
  return payload;
};

let bootstrap = await request('/api/bootstrap');
let material = bootstrap.materials.find((item) => item.name === process.env.SMOKE_MATERIAL);
if (!material && process.env.SMOKE_CREATE === '1') {
  const created = await request('/api/materials', {
    method: 'POST',
    body: JSON.stringify({
      name: process.env.SMOKE_MATERIAL,
      category: 'Docker 验收',
      spec: 'temporary',
      unit: '件',
      safetyStock: 0,
    }),
  });
  material = created.material;
  bootstrap = await request('/api/bootstrap');
}
if (!material || !bootstrap.materials.some((item) => item.id === material.id)) {
  throw new Error('容器重建后未找到测试耗材，数据卷持久化失败');
}
console.log(JSON.stringify({ version: bootstrap.version, materialId: material.id }));
NODE
}

need_command docker
need_command awk
need_command od
docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2 插件'
docker info >/dev/null 2>&1 || die '当前账号无法连接 Docker Engine'

cat > "$ENV_FILE" <<EOF
COMPOSE_PROJECT_NAME=$PROJECT
OPENLABSTOCK_BIND_IP=127.0.0.1
OPENLABSTOCK_PORT=0
OPENLABSTOCK_IMAGE_TAG=$INITIAL_TAG
OPENLABSTOCK_IMAGE_VERSION=smoke-initial
TRUST_PROXY=0
COOKIE_SECURE=0
SESSION_MAX_AGE_DAYS=15
SQLITE_BUSY_TIMEOUT_MS=10000
DATABASE_UPLOAD_MAX_BYTES=104857600
BACKUP_RETENTION_DAYS=30
OPENLABSTOCK_MEMORY_LIMIT=512m
OPENLABSTOCK_CPU_LIMIT=1.0
INITIAL_ADMIN_PASSWORD=$PASSWORD
EOF
chmod 600 "$ENV_FILE"

printf '1/7 校验 Compose 并构建镜像\n'
compose config --quiet
compose build --pull

printf '2/7 首次启动并等待健康检查\n'
STARTED=1
start_compose -d --wait
container_id="$(compose ps -q app)"
[[ -n "$container_id" ]] || die '没有找到 app 容器'
[[ "$(compose ps -q app | wc -l | tr -d ' ')" == 1 ]] || die '必须且只能运行一个 app 容器'

binding="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "4388/tcp") 0).HostIp}}:{{(index (index .NetworkSettings.Ports "4388/tcp") 0).HostPort}}' "$container_id")"
[[ "$binding" == 127.0.0.1:* ]] || die "端口没有限制在回环地址：$binding"
[[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "openlabstock:$INITIAL_TAG")" == 'smoke-initial' ]] || die '镜像版本标签不正确'
compose exec -T app node -e "fetch('http://127.0.0.1:4388/api/health').then(async r=>{if(!r.ok)throw new Error(await r.text());return r.json()}).then(v=>console.log(JSON.stringify(v)))"

printf '3/7 校验非 root、只读根目录和安全限制\n'
# The substitutions must run inside the container, not in the host shell.
# shellcheck disable=SC2016
compose exec -T app sh -c 'test "$(id -u)" != 0 && test -w /var/lib/openlabstock && test -w /var/backups/openlabstock && ! touch /app/.write-test 2>/dev/null'
security_state="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.PidsLimit}}' "$container_id")"
[[ "$security_state" == true\|false\|*ALL*\|*no-new-privileges*\|128 ]] || die "容器安全参数异常：$security_state"

printf '4/7 登录并写入隔离测试数据\n'
api_check 1
INITIAL_IMAGE="$(docker inspect -f '{{.Image}}' "$container_id")"
docker image tag "$INITIAL_IMAGE" "openlabstock:$ROLLBACK_TAG"

printf '5/7 清除初始化密码并重建，验证数据持久化\n'
replace_env INITIAL_ADMIN_PASSWORD ''
start_compose -d --force-recreate --wait
[[ -z "$(compose exec -T app printenv INITIAL_ADMIN_PASSWORD | tr -d '\r\n')" ]] || die '重建后容器仍持有明文初始化密码'
api_check 0

printf '6/7 生成备份并导出到临时宿主机目录\n'
compose exec -T app node scripts/backup.mjs
latest_backup="$(compose exec -T app sh -lc 'ls -1t /var/backups/openlabstock/labstock-*.sqlite | head -n 1' | tr -d '\r')"
[[ -n "$latest_backup" ]] || die '备份卷内没有生成 SQLite 备份'
compose cp "app:$latest_backup" "$EXPORT_DIR/"
[[ -s "$EXPORT_DIR/$(basename "$latest_backup")" ]] || die '宿主机备份导出为空'

printf '7/7 模拟更新与镜像回滚，复核数据仍存在\n'
replace_env OPENLABSTOCK_IMAGE_TAG "$CANDIDATE_TAG"
replace_env OPENLABSTOCK_IMAGE_VERSION 'smoke-candidate'
compose build
start_compose -d --wait
container_id="$(compose ps -q app)"
CANDIDATE_IMAGE="$(docker inspect -f '{{.Image}}' "$container_id")"
[[ "$CANDIDATE_IMAGE" != "$INITIAL_IMAGE" ]] || die '候选镜像与初始镜像没有形成不同版本'
api_check 0

docker image tag "openlabstock:$ROLLBACK_TAG" "openlabstock:$CANDIDATE_TAG"
start_compose -d --force-recreate --wait
container_id="$(compose ps -q app)"
[[ "$(docker inspect -f '{{.Image}}' "$container_id")" == "$INITIAL_IMAGE" ]] || die '容器没有切回初始镜像'
api_check 0
