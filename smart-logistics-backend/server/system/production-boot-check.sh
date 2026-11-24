#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
project=imsop-remediation-production-check
stage_revision=''
if [[ "${1:-}" == --stage-image && "$#" == 3 ]]; then
  stage_image="$2"
  stage_revision="$3"
  [[ "$stage_image" =~ ^ghcr\.io/druhustle/imsop-backend@sha256:[a-f0-9]{64}$ &&
     "$stage_revision" =~ ^[a-f0-9]{40}$ ]] || {
    echo 'Expected the immutable published Logistics image and its full source revision' >&2
    exit 2
  }
  metadata=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.source"}}' "$stage_image")
  [[ "$metadata" == "linux/arm64 $stage_revision https://github.com/DruHustle/smart-logistics" ]] || {
    echo 'The local Logistics artifact differs from the expected ARM64 source' >&2
    exit 2
  }
  export IMSOP_TEST_IMAGE="$stage_image"
  project=$(python3 -c 'import secrets; print("imsop-stage-" + secrets.token_hex(12))')
  [[ "$project" =~ ^imsop-stage-[a-f0-9]{24}$ ]] || exit 2
elif [[ "$#" != 0 ]]; then
  echo 'Usage: production-boot-check.sh [--stage-image IMMUTABLE_IMAGE EXPECTED_REVISION]' >&2
  exit 2
fi
if [[ -n "$stage_revision" ]]; then
  for resource in network volume; do
    suffix=sandbox
    if [[ "$resource" == volume ]]; then suffix=data; fi
    if ! labeled=$(docker "$resource" ls --quiet --filter "label=com.docker.compose.project=$project") ||
       ! named=$(docker "$resource" ls --quiet --filter "name=${project}_$suffix") ||
       [[ -n "$labeled$named" ]]; then
      echo 'Unable to prove the selected disposable network and volume are unused' >&2
      exit 2
    fi
  done
fi
config=$(mktemp /tmp/imsop-production-check.XXXXXX)
export IMSOP_PRODUCTION_CHECK_CONFIG="$config"
IMSOP_PRODUCTION_CHECK_STAGE="$stage_revision" python3 - <<'PY'
import json,os,pathlib
common={'POSTGRES_USER':'imsop_test','POSTGRES_PASSWORD':'isolated-test-only','POSTGRES_DB':'imsop_test'}
env={'NODE_ENV':'production','ASPNETCORE_ENVIRONMENT':'Production','DOTNET_ENVIRONMENT':'Production','DATABASE_URL':'postgresql://imsop_test:isolated-test-only@database:5432/imsop_test','ConnectionStrings__DefaultConnection':'Host=database;Database=imsop_test;Username=imsop_test;Password=isolated-test-only','JWT_SECRET':'isolated-stack-signing-secret-at-least-32-characters','RESET_DELIVERY_KEY':'a'*64,'RUN_NODE_MIGRATIONS':'true','Database__AutoMigrate':'true','ALLOWED_ORIGIN':'https://imsop.test','CORS_ALLOWED_ORIGINS':'https://imsop.test','PASSWORD_RESET_BASE_URL':'https://imsop.test/#/reset-password','EMAIL_PROVIDER':'resend','RESEND_API_KEY':'inert-never-contacted-fixture','EMAIL_FROM':'noreply@imsop.test','EMAIL_NOTIFICATIONS_ENABLED':'false','ServiceBus__Enabled':'false','LOGISTICS_WEBHOOK_SECRETS':json.dumps({'fixture':'isolated-signing-secret-at-least-32-characters'})}
config={'services':{'database':{'image':'postgres:16-alpine','environment':common,'healthcheck':{'test':['CMD-SHELL','pg_isready -h 127.0.0.1 -U imsop_test -d imsop_test'],'interval':'2s','timeout':'2s','retries':30}},'backend':{'image':os.environ.get('IMSOP_TEST_IMAGE','imsop-remediation:qualification'),'environment':env,'ports':['127.0.0.1:18069:10000'],'depends_on':{'database':{'condition':'service_healthy'}}}}}
if os.environ["IMSOP_PRODUCTION_CHECK_STAGE"]:
    config["networks"] = {"sandbox": {"internal": True}}
    config["volumes"] = {"data": {}}
    for service in config["services"].values():
        service["networks"] = ["sandbox"]
        service["pull_policy"] = "never"
    config["services"]["database"].update(
        cpus="0.25", mem_limit="256m", memswap_limit="256m", shm_size="64m",
        volumes=["data:/var/lib/postgresql/data"],
        command=["postgres", "-c", "shared_buffers=64MB", "-c", "max_connections=30"],
    )
    config["services"]["backend"].update(cpus="0.50", mem_limit="1024m", memswap_limit="1024m")
pathlib.Path(os.environ['IMSOP_PRODUCTION_CHECK_CONFIG']).write_text(json.dumps(config))
PY
if ! existing=$(docker compose -p "$project" -f "$config" ps -aq); then
  rm -f "$config"
  echo 'Unable to verify the disposable production-check stack is unused' >&2
  exit 2
fi
if [[ -n "$existing" ]]; then
  rm -f "$config"
  echo 'Refusing to reuse an existing production-check stack' >&2
  exit 2
fi
if [[ -n "$stage_revision" ]] && ! python3 - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
    probe.bind(("127.0.0.1", 18069))
PY
then
  rm -f "$config"
  echo 'The disposable staging loopback port is unavailable' >&2
  exit 2
fi
cleanup(){ docker compose -p "$project" -f "$config" down -v; rm -f "$config"; }
trap cleanup EXIT
if [[ -n "$stage_revision" ]]; then
  docker compose -p "$project" -f "$config" up -d --wait --wait-timeout 90
  python3 - "$stage_revision" <<'PY'
import json
import sys
import time
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = build_opener(ProxyHandler({}), NoRedirect())
origin = "http://127.0.0.1:18069"
allowed = "https://imsop.test"
denied = "https://forbidden.test"


def inspect(path, web_origin=None):
    headers = {"Origin": web_origin} if web_origin else {}
    try:
        response = opener.open(Request(origin + path, headers=headers), timeout=3)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(65537) if path == "/version" and response.status == 200 else b""
        return response.status, response.headers.get("Access-Control-Allow-Origin"), body


deadline = time.monotonic() + 45
while True:
    try:
        ready, _, _ = inspect("/ready")
        if ready == 200:
            break
    except OSError:
        pass
    if time.monotonic() >= deadline:
        sys.exit("The isolated Logistics API did not become ready")
    time.sleep(2)

status, _, body = inspect("/version")
if status != 200 or len(body) > 65536:
    sys.exit("The isolated Logistics API did not return usable version metadata")
try:
    version = json.loads(body)
except ValueError:
    sys.exit("The isolated Logistics API returned invalid version metadata")
if not isinstance(version, dict) or version.get("revision") != sys.argv[1] or version.get("apiContract") != 2:
    sys.exit("The isolated Logistics API source or contract differs from the expected image")

for route in ("/api/auth/me", "/supply-chain/api/v1/orders/suppliers"):
    denied_status, denied_policy, _ = inspect(route, denied)
    if inspect(route, allowed)[:2] != (401, allowed) or denied_status not in (401, 403) or denied_policy is not None:
        sys.exit("The isolated Logistics API failed anonymous denial or the origin policy")

print(json.dumps({
    "environment": "isolated ARM64 fixture", "revision": sys.argv[1], "apiContract": 2,
    "readiness": 200, "anonymousAuth": 401, "allowedAndDeniedOriginChecks": True,
}))
PY
  exit 0
fi
docker compose -p "$project" -f "$config" up -d --wait
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:18069';
assert.equal((await fetch(origin+'/ready')).status,200);
const version=await(await fetch(origin+'/version')).json();
for(const path of ['/api/auth/me','/supply-chain/api/v1/orders/suppliers']){
 const allowed=await fetch(origin+path,{headers:{Origin:'https://imsop.test'}});assert.equal(allowed.status,401);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://imsop.test');
 const denied=await fetch(origin+path,{headers:{Origin:'https://forbidden.test'}});assert.equal(denied.headers.get('access-control-allow-origin'),null);
}
console.log(JSON.stringify({environment:'isolated actual Production mode',readiness:200,anonymousAuth:401,allowedAndDeniedOriginChecks:true,version,externalProviderContact:false}));
JS
