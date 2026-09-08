#!/bin/sh
# agencyhq: bootstrap a local Trigger.dev dashboard (self-hosted webapp,
# infra/trigger/docker-compose.yml) into a usable dev environment: sign in
# via a dev-mode magic link, find-or-create an org and project, mint a
# Personal Access Token, and write everything `trigger dev` and the task
# scripts need into an env file (trigger/.env by default).
#
# Never prints a token or key VALUE — only variable names, and org/project
# slugs. Requires the webapp stack already running with NODE_ENV=development,
# APP_ENV=development, and ADMIN_EMAILS set to allow the bootstrap email (see
# infra/trigger/.env.example and infra/trigger/README.md's Bootstrap
# section). Idempotent: re-running finds an existing org/project by slug
# prefix instead of creating duplicates.
#
# Usage: sh infra/trigger/scripts/bootstrap.sh [--dry-run]
#          [--org <name>] [--project <name>] [--email <addr>]
#          [--env-file <path>] [--token-name <name>]
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)

DASHBOARD_URL="http://localhost:8030"
WEBAPP_ENV_FILE="$repo_root/infra/trigger/.env"
COMPOSE_FILE="$repo_root/infra/trigger/docker-compose.yml"
ENV_EXAMPLE_FILE="$repo_root/trigger/.env.example"

org_name="agencyhq"
project_name="agencyhq-spike"
email="agencyhq@example.com"
env_file_arg="trigger/.env"
token_name="agencyhq-trigger-dev"
dry_run=0

usage() {
  cat <<'EOF'
Usage: sh infra/trigger/scripts/bootstrap.sh [options]

  --dry-run             Print the plan and confirm the dashboard is up;
                         write nothing, POST nothing.
  --org <name>           Org name to find or create (default: agencyhq)
  --project <name>       Project name to find or create (default: agencyhq-spike)
  --email <addr>         Dev-mode login email (default: agencyhq@example.com)
  --env-file <path>      Output env file, relative to repo root unless
                         absolute (default: trigger/.env)
  --token-name <name>    Personal access token name (default: agencyhq-trigger-dev)
  -h, --help             Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --org)
      org_name=$2
      shift 2
      ;;
    --project)
      project_name=$2
      shift 2
      ;;
    --email)
      email=$2
      shift 2
      ;;
    --env-file)
      env_file_arg=$2
      shift 2
      ;;
    --token-name)
      token_name=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "bootstrap.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$env_file_arg" in
  /*) env_file="$env_file_arg" ;;
  *) env_file="$repo_root/$env_file_arg" ;;
esac

tmp_dir=$(mktemp -d)
jar="$tmp_dir/cookies.jar"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

log() {
  echo "bootstrap.sh: $*"
}

plan() {
  echo "[dry-run] $*"
}

# --- Step 1: dashboard reachable (real check in both modes) ----------------

dashboard_status=$(curl -s -o /dev/null -w '%{http_code}' "$DASHBOARD_URL/login" || echo 000)
if [ "$dashboard_status" != "200" ]; then
  echo "bootstrap.sh: dashboard not reachable at $DASHBOARD_URL/login (got HTTP $dashboard_status)." >&2
  echo "bootstrap.sh: start the stack first: docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env up -d" >&2
  exit 2
fi
log "dashboard is up at $DASHBOARD_URL (HTTP $dashboard_status)"

if [ "$dry_run" = "1" ]; then
  plan "verify NODE_ENV=development is present in $WEBAPP_ENV_FILE"
  plan "  (also required: APP_ENV=development, ADMIN_EMAILS=^$(printf '%s' "$email" | sed 's/[.]/\\\\./g')\$ )"
  plan "  else exit 2 telling the operator to add the three vars and restart webapp"
  plan "POST $DASHBOARD_URL/login/magic  action=send  email=$email"
  plan "poll (up to 30s): docker compose -f $COMPOSE_FILE --env-file $WEBAPP_ENV_FILE logs --since 2m webapp | grep -oE 'http://localhost:8030/magic[^ \"]*'"
  plan "GET the magic link with a cookie jar to establish a session (single-use link)"
  plan "if landing is /confirm-basic-details: POST it with fields name, email=$email, confirmEmail=$email"
  plan "find org '$org_name' by slug prefix, else POST $DASHBOARD_URL/orgs/new  orgName=$org_name"
  plan "find project '$project_name' by slug prefix under the org, else POST .../projects/new  projectName=$project_name projectVersion=v3 workingOn=[] workingOnPositions=[] technologies=[] technologiesOther=[] goals=[] goalsPositions=[]"
  plan "extract project ref (proj_...) from .../env/dev and the dev secret key (tr_dev_...) from .../env/dev/apikeys"
  plan "POST $DASHBOARD_URL/account/tokens?_data=routes%2Faccount.tokens  action=create  tokenName=$token_name  (Accept: application/json) to mint a personal access token (tr_pat_...)"
  plan "write/merge TRIGGER_API_URL, TRIGGER_PROJECT_REF, TRIGGER_SECRET_KEY, TRIGGER_ACCESS_TOKEN into $env_file (create from $ENV_EXAMPLE_FILE if missing; chmod 600)"
  plan "write nothing for real; no files were created or modified"
  exit 0
fi

# --- Step 2: dev-mode vars present on the webapp's own env file ------------

if ! grep -qF 'NODE_ENV=development' "$WEBAPP_ENV_FILE" 2>/dev/null; then
  echo "bootstrap.sh: $WEBAPP_ENV_FILE is missing NODE_ENV=development." >&2
  echo "bootstrap.sh: add NODE_ENV=development, APP_ENV=development, and" >&2
  echo "bootstrap.sh: ADMIN_EMAILS=^$(printf '%s' "$email" | sed 's/[.]/\\./g')\$ to it, then restart the webapp:" >&2
  echo "bootstrap.sh:   docker compose -f infra/trigger/docker-compose.yml --env-file infra/trigger/.env up -d webapp" >&2
  exit 2
fi
log "dev-mode vars present in $WEBAPP_ENV_FILE"

# --- Python helper for HTML/JSON parsing (no third-party deps) -------------

helper_py="$tmp_dir/helper.py"
cat >"$helper_py" <<'PYEOF'
import html
import re
import sys


def slugify(name):
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def find_org_project(path, org_prefix, project_prefix):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    pattern = re.compile(
        r'href="/orgs/(' + re.escape(org_prefix) + r'[a-z0-9-]*)'
        r'/projects/(' + re.escape(project_prefix) + r'[a-z0-9-]*)/env/dev"'
    )
    m = pattern.search(text)
    if m:
        print(m.group(1))
        print(m.group(2))


def find_org(path, org_prefix):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    pattern = re.compile(r'href="/orgs/(' + re.escape(org_prefix) + r'[a-z0-9-]*)(?:/|")')
    m = pattern.search(text)
    if m:
        print(m.group(1))


def find_project_in_org(path, org_slug, project_prefix):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    pattern = re.compile(
        r'href="/orgs/' + re.escape(org_slug) +
        r'/projects/(' + re.escape(project_prefix) + r'[a-z0-9-]*)/env/dev"'
    )
    m = pattern.search(text)
    if m:
        print(m.group(1))


def extract_ref(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    m = re.search(r"proj_[a-z0-9]+", text)
    if m:
        print(m.group(0))


def extract_dev_key(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = html.unescape(f.read())
    m = re.search(r"tr_dev_[A-Za-z0-9]+", text)
    if m:
        print(m.group(0))


def extract_pat(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    matches = re.findall(r"tr_pat_[A-Za-z0-9]+", text)
    if matches:
        print(max(matches, key=len))


def landing_path(url):
    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+(/.*)?$", url)
    print(m.group(1) or "/" if m else url)


def org_project_from_url(url, kind):
    m = re.search(r"/orgs/([a-z0-9-]+)/projects/([a-z0-9-]+)/", url)
    if not m:
        m = re.search(r"/orgs/([a-z0-9-]+)/projects/([a-z0-9-]+)$", url)
    if m:
        print(m.group(1) if kind == "org" else m.group(2))


def org_from_projects_new_url(url):
    m = re.search(r"/orgs/([a-z0-9-]+)/projects/new", url)
    if m:
        print(m.group(1))


if __name__ == "__main__":
    cmd = sys.argv[1]
    args = sys.argv[2:]
    if cmd == "slugify":
        print(slugify(args[0]))
    elif cmd == "find-org-project":
        find_org_project(args[0], args[1], args[2])
    elif cmd == "find-org":
        find_org(args[0], args[1])
    elif cmd == "find-project-in-org":
        find_project_in_org(args[0], args[1], args[2])
    elif cmd == "extract-ref":
        extract_ref(args[0])
    elif cmd == "extract-dev-key":
        extract_dev_key(args[0])
    elif cmd == "extract-pat":
        extract_pat(args[0])
    elif cmd == "landing-path":
        landing_path(args[0])
    elif cmd == "org-from-url":
        org_project_from_url(args[0], "org")
    elif cmd == "project-from-url":
        org_project_from_url(args[0], "project")
    elif cmd == "org-from-projects-new-url":
        org_from_projects_new_url(args[0])
    else:
        sys.exit("helper.py: unknown command: " + cmd)
PYEOF

org_prefix=$(python3 "$helper_py" slugify "$org_name")
project_prefix=$(python3 "$helper_py" slugify "$project_name")

# --- Step 3: request magic link --------------------------------------------

log "requesting magic link for $email"
magic_status=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" \
  --data-urlencode "action=send" \
  --data-urlencode "email=$email" \
  "$DASHBOARD_URL/login/magic")
if [ "$magic_status" != "302" ]; then
  echo "bootstrap.sh: POST $DASHBOARD_URL/login/magic returned HTTP $magic_status (expected 302)." >&2
  echo "bootstrap.sh: check ADMIN_EMAILS in $WEBAPP_ENV_FILE allows $email." >&2
  exit 2
fi

# --- Step 4: poll webapp logs for the magic link (up to 30s) --------------

magic_link=""
deadline=$(($(date +%s) + 30))
while [ "$(date +%s)" -lt "$deadline" ]; do
  magic_link=$(docker compose -f "$COMPOSE_FILE" --env-file "$WEBAPP_ENV_FILE" logs --since 2m webapp 2>/dev/null \
    | grep -oE 'http://localhost:8030/magic[^ "]*' | tail -1 || true)
  [ -n "$magic_link" ] && break
  sleep 2
done
if [ -z "$magic_link" ]; then
  echo "bootstrap.sh: timed out waiting for the magic link in webapp logs (30s)." >&2
  exit 2
fi
log "found magic link in webapp logs"

# --- Step 5: log in ---------------------------------------------------------

landing_file="$tmp_dir/landing.html"
result=$(curl -s -o "$landing_file" -w '%{http_code} %{url_effective}' -L -c "$jar" -b "$jar" "$magic_link")
landing_url=$(printf '%s' "$result" | awk '{print $2}')
log "logged in; landed on $(python3 "$helper_py" landing-path "$landing_url")"

# --- Step 6: confirm basic details if this is a brand-new account ---------

landing_path=$(python3 "$helper_py" landing-path "$landing_url")
if [ "$landing_path" = "/confirm-basic-details" ]; then
  log "confirming basic details for new account"
  result=$(curl -s -o "$landing_file" -w '%{http_code} %{url_effective}' -L -c "$jar" -b "$jar" \
    --data-urlencode "name=AgencyHQ Bootstrap" \
    --data-urlencode "email=$email" \
    --data-urlencode "confirmEmail=$email" \
    "$DASHBOARD_URL/confirm-basic-details")
  landing_url=$(printf '%s' "$result" | awk '{print $2}')
  landing_path=$(python3 "$helper_py" landing-path "$landing_url")
  log "landed on $landing_path"
fi

# --- Step 7: find or create org, find or create project --------------------

# A consistent page to scan for existing org/project links regardless of
# where the login/confirm flow left us.
dashboard_file="$tmp_dir/dashboard.html"
curl -s -o "$dashboard_file" -L -c "$jar" -b "$jar" "$landing_url" >/dev/null

found=$(python3 "$helper_py" find-org-project "$dashboard_file" "$org_prefix" "$project_prefix" || true)
org_slug=""
project_slug=""
if [ -n "$found" ]; then
  org_slug=$(printf '%s\n' "$found" | sed -n '1p')
  project_slug=$(printf '%s\n' "$found" | sed -n '2p')
  log "found existing org '$org_slug' and project '$project_slug'"
  env_dev_file="$tmp_dir/envdev.html"
  curl -s -o "$env_dev_file" -L -c "$jar" -b "$jar" \
    "$DASHBOARD_URL/orgs/$org_slug/projects/$project_slug/env/dev" >/dev/null
  project_ref=$(python3 "$helper_py" extract-ref "$env_dev_file" || true)
else
  org_slug=$(python3 "$helper_py" find-org "$dashboard_file" "$org_prefix" || true)
  if [ -z "$org_slug" ]; then
    log "creating org '$org_name'"
    orgnew_file="$tmp_dir/orgnew.html"
    result=$(curl -s -o "$orgnew_file" -w '%{http_code} %{url_effective}' -L -c "$jar" -b "$jar" \
      --data-urlencode "orgName=$org_name" \
      "$DASHBOARD_URL/orgs/new")
    org_new_landing=$(printf '%s' "$result" | awk '{print $2}')
    org_slug=$(python3 "$helper_py" org-from-projects-new-url "$org_new_landing" || true)
    if [ -z "$org_slug" ]; then
      echo "bootstrap.sh: could not determine org slug after creating org (landed on $org_new_landing)." >&2
      exit 2
    fi
    project_new_url="$org_new_landing"
    project_body_file="$orgnew_file"
    need_project=1
  else
    log "found existing org '$org_slug'"
    project_slug=$(python3 "$helper_py" find-project-in-org "$dashboard_file" "$org_slug" "$project_prefix" || true)
    if [ -n "$project_slug" ]; then
      need_project=0
      env_dev_file="$tmp_dir/envdev.html"
      curl -s -o "$env_dev_file" -L -c "$jar" -b "$jar" \
        "$DASHBOARD_URL/orgs/$org_slug/projects/$project_slug/env/dev" >/dev/null
      project_ref=$(python3 "$helper_py" extract-ref "$env_dev_file" || true)
    else
      need_project=1
      project_new_url="$DASHBOARD_URL/orgs/$org_slug/projects/new"
      project_body_file="$tmp_dir/projnew_get.html"
    fi
  fi

  if [ "${need_project:-0}" = "1" ]; then
    log "creating project '$project_name' in org '$org_slug'"
    projnew_file="$tmp_dir/projnew.html"
    result=$(curl -s -o "$projnew_file" -w '%{http_code} %{url_effective}' -L -c "$jar" -b "$jar" \
      --data-urlencode "projectName=$project_name" \
      --data-urlencode "projectVersion=v3" \
      --data-urlencode "workingOn=[]" \
      --data-urlencode "workingOnPositions=[]" \
      --data-urlencode "technologies=[]" \
      --data-urlencode "technologiesOther=[]" \
      --data-urlencode "goals=[]" \
      --data-urlencode "goalsPositions=[]" \
      "$project_new_url")
    proj_new_landing=$(printf '%s' "$result" | awk '{print $2}')
    project_slug=$(python3 "$helper_py" project-from-url "$proj_new_landing" || true)
    if [ -z "$project_slug" ]; then
      echo "bootstrap.sh: could not determine project slug after creating project (landed on $proj_new_landing)." >&2
      exit 2
    fi
    project_ref=$(python3 "$helper_py" extract-ref "$projnew_file" || true)
  fi
fi

if [ -z "${project_ref:-}" ]; then
  echo "bootstrap.sh: could not find a project ref (proj_...) for org '$org_slug' project '$project_slug'." >&2
  exit 2
fi
log "project ref found for org '$org_slug' project '$project_slug'"

# --- Step 8: dev secret key --------------------------------------------------

apikeys_file="$tmp_dir/apikeys.html"
curl -s -o "$apikeys_file" -L -c "$jar" -b "$jar" \
  "$DASHBOARD_URL/orgs/$org_slug/projects/$project_slug/env/dev/apikeys" >/dev/null
dev_key=$(python3 "$helper_py" extract-dev-key "$apikeys_file" || true)
if [ -z "$dev_key" ]; then
  echo "bootstrap.sh: could not find a dev secret key (tr_dev_...) on the apikeys page." >&2
  exit 2
fi
log "dev secret key found"

# --- Step 9: personal access token ------------------------------------------

log "creating personal access token '$token_name'"
pat_file="$tmp_dir/pat.json"
curl -s -o "$pat_file" -c "$jar" -b "$jar" \
  -H "Accept: application/json" \
  --data-urlencode "action=create" \
  --data-urlencode "tokenName=$token_name" \
  "$DASHBOARD_URL/account/tokens?_data=routes%2Faccount.tokens" >/dev/null
pat=$(python3 "$helper_py" extract-pat "$pat_file" || true)
if [ -z "$pat" ]; then
  echo "bootstrap.sh: could not find a personal access token (tr_pat_...) in the response." >&2
  exit 2
fi
log "personal access token created"

# --- Step 10: write the env file -------------------------------------------

if [ ! -f "$env_file" ]; then
  if [ ! -f "$ENV_EXAMPLE_FILE" ]; then
    echo "bootstrap.sh: neither $env_file nor $ENV_EXAMPLE_FILE exist; cannot create env file." >&2
    exit 2
  fi
  mkdir -p "$(dirname "$env_file")"
  cp "$ENV_EXAMPLE_FILE" "$env_file"
fi
chmod 600 "$env_file"

merge_py="$tmp_dir/merge_env.py"
cat >"$merge_py" <<'PYEOF'
import re
import sys

path = sys.argv[1]
updates = dict(arg.split("=", 1) for arg in sys.argv[2:])

with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

seen = set()
out = []
for line in lines:
    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=", line)
    if m and m.group(1) in updates:
        key = m.group(1)
        out.append("%s=%s\n" % (key, updates[key]))
        seen.add(key)
    else:
        out.append(line)

for key, value in updates.items():
    if key not in seen:
        if out and not out[-1].endswith("\n"):
            out[-1] = out[-1] + "\n"
        out.append("%s=%s\n" % (key, value))

with open(path, "w", encoding="utf-8") as f:
    f.writelines(out)
PYEOF

python3 "$merge_py" "$env_file" \
  "TRIGGER_API_URL=$DASHBOARD_URL" \
  "TRIGGER_PROJECT_REF=$project_ref" \
  "TRIGGER_SECRET_KEY=$dev_key" \
  "TRIGGER_ACCESS_TOKEN=$pat"
chmod 600 "$env_file"

echo "bootstrap.sh: wrote to $env_file:"
echo "  TRIGGER_API_URL"
echo "  TRIGGER_PROJECT_REF"
echo "  TRIGGER_SECRET_KEY"
echo "  TRIGGER_ACCESS_TOKEN"
echo "bootstrap.sh: org slug:     $org_slug"
echo "bootstrap.sh: project slug: $project_slug"
