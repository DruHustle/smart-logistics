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
elif [[ "$#" != 0 ]]; then
  echo 'Usage: production-boot-check.sh [--stage-image IMMUTABLE_IMAGE EXPECTED_REVISION]' >&2
  exit 2
fi
config=$(mktemp /tmp/imsop-production-check.XXXXXX)
export IMSOP_PRODUCTION_CHECK_CONFIG="$config"
python3 - <<'PY'
import json,os,pathlib
common={'POSTGRES_USER':'imsop_test','POSTGRES_PASSWORD':'isolated-test-only','POSTGRES_DB':'imsop_test'}
env={'NODE_ENV':'production','ASPNETCORE_ENVIRONMENT':'Production','DOTNET_ENVIRONMENT':'Production','DATABASE_URL':'postgresql://imsop_test:isolated-test-only@database:5432/imsop_test','ConnectionStrings__DefaultConnection':'Host=database;Database=imsop_test;Username=imsop_test;Password=isolated-test-only','JWT_SECRET':'isolated-stack-signing-secret-at-least-32-characters','RESET_DELIVERY_KEY':'a'*64,'RUN_NODE_MIGRATIONS':'true','Database__AutoMigrate':'true','ALLOWED_ORIGIN':'https://imsop.test','CORS_ALLOWED_ORIGINS':'https://imsop.test','PASSWORD_RESET_BASE_URL':'https://imsop.test/#/reset-password','EMAIL_PROVIDER':'resend','RESEND_API_KEY':'inert-never-contacted-fixture','EMAIL_FROM':'noreply@imsop.test','EMAIL_NOTIFICATIONS_ENABLED':'false','ServiceBus__Enabled':'false','LOGISTICS_WEBHOOK_SECRETS':json.dumps({'fixture':'isolated-signing-secret-at-least-32-characters'})}
config={'services':{'database':{'image':'postgres:16-alpine','environment':common,'healthcheck':{'test':['CMD-SHELL','pg_isready -h 127.0.0.1 -U imsop_test -d imsop_test'],'interval':'2s','timeout':'2s','retries':30}},'backend':{'image':os.environ.get('IMSOP_TEST_IMAGE','imsop-remediation:qualification'),'environment':env,'ports':['127.0.0.1:18069:10000'],'depends_on':{'database':{'condition':'service_healthy'}}}}}
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
cleanup(){ docker compose -p "$project" -f "$config" down -v; rm -f "$config"; }
trap cleanup EXIT
docker compose -p "$project" -f "$config" up -d --wait
node --input-type=module - "$stage_revision" <<'JS'
import assert from 'node:assert/strict';
const origin='http://127.0.0.1:18069';
assert.equal((await fetch(origin+'/ready')).status,200);
const version=await(await fetch(origin+'/version')).json();
const expected = process.argv[2];
if (expected) {
 assert.equal(version.revision, expected);
 assert.equal(version.apiContract, 2);
}
for(const path of ['/api/auth/me','/supply-chain/api/v1/orders/suppliers']){
 const allowed=await fetch(origin+path,{headers:{Origin:'https://imsop.test'}});assert.equal(allowed.status,401);assert.equal(allowed.headers.get('access-control-allow-origin'),'https://imsop.test');
 const denied=await fetch(origin+path,{headers:{Origin:'https://forbidden.test'}});assert.equal(denied.headers.get('access-control-allow-origin'),null);
}
console.log(JSON.stringify({environment:'isolated actual Production mode',readiness:200,anonymousAuth:401,allowedAndDeniedOriginChecks:true,version,externalProviderContact:false}));
JS
