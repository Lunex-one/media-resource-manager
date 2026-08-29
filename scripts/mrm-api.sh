#!/bin/bash
# scripts/mrm-api.sh
#
# Thin curl wrapper for the MRM API. Resolves the endpoint and mints a
# bearer token for you, so a call is just:
#
#     ./scripts/mrm-api.sh GET  /workstations
#     ./scripts/mrm-api.sh POST /workstations/start '{"instanceId":"i-0abc"}'
#     ./scripts/mrm-api.sh --as alice GET /workstations   # a specific user's view
#     ./scripts/mrm-api.sh --token                        # print a token and exit
#
# Identity of the minted token:
#   By DEFAULT the token is an ADMIN token, identified as your AWS caller. This
#   matches what an administrator sees in the web console (admins see every
#   workstation, user and group). Anyone who can read the JWT signing secret is
#   already fully privileged, so this grants nothing new -- it just stops the CLI
#   from silently showing a different, empty view than the console.
#
#   To see the API as a specific NON-admin user (to test per-user/group
#   filtering, e.g. GET /workstations returning only that user's machines), pass
#   --as <username>. The username must match the MRM user id / AD sAMAccountName
#   (e.g. "Tilman", not "tilman@lunex.one") for group membership to resolve.
#
# Options:
#   --as <user>    mint a NON-admin token impersonating that MRM user
#   --no-admin     mint a non-admin token keeping the default identity
#   --admin        mint an admin token (this is the default; kept for clarity)
#   --token        print a usable bearer token and exit
#   --raw          do not pretty-print the response with jq
#   --verbose      show the request line, status, and acting identity
#   --debug        verbose troubleshooting: endpoint resolution, token cache,
#                  mint, the exact request, and the full error body on failure
#                  (also enabled by setting MRM_DEBUG=1). Secrets are redacted.
#   --no-cache     ignore any cached token and mint a fresh one
#
# Endpoint resolution: see scripts/mrm-env.sh (.env > SSM > CloudFormation).
# No URL is hardcoded in this script.
#
# Token resolution order:
#   1. $MRM_AUTH_TOKEN
#   2. cached token, if it has not expired
#   3. freshly minted HS256 token signed with the deployment's JWT secret
#      from Secrets Manager (/${MRM_PASCAL_NAME}/Auth/JwtSecret)
#
# Requires: aws CLI with credentials for the deployment account, node, curl.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; GREY='\033[0;90m'; NC='\033[0m'
err()   { printf "${RED}[mrm-api]${NC} %s\n" "$*" >&2; }
warn()  { printf "${YELLOW}[mrm-api]${NC} %s\n" "$*" >&2; }
info()  { printf "${BLUE}[mrm-api]${NC} %s\n" "$*" >&2; }
# Debug lines are gated on MRM_DEBUG (set by --debug or in the environment) and
# always go to stderr, so they never corrupt the JSON on stdout.
debug() { [ -n "${MRM_DEBUG:-}" ] && printf "${GREY}[mrm-api] %s${NC}\n" "$*" >&2; return 0; }

AS_ADMIN=true          # default to the administrator view (see header)
IMPERSONATE=""         # set by --as <user>
PRINT_TOKEN_ONLY=false
RAW=false
VERBOSE=false
USE_CACHE=true

# Parse args before sourcing mrm-env.sh, so --debug can enable debug output for
# the endpoint resolution that happens at source time.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --admin)    AS_ADMIN=true; IMPERSONATE=""; shift ;;
        --no-admin) AS_ADMIN=false; shift ;;
        --as)       AS_ADMIN=false; IMPERSONATE="${2:-}"; shift 2 ;;
        --token)    PRINT_TOKEN_ONLY=true; shift ;;
        --raw)      RAW=true; shift ;;
        --verbose)  VERBOSE=true; shift ;;
        --debug)    export MRM_DEBUG=1; VERBOSE=true; shift ;;
        --no-cache) USE_CACHE=false; shift ;;
        -h|--help)  sed -n '2,45p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        --) shift; break ;;
        -*) err "Unknown option: $1"; exit 2 ;;
        *)  break ;;
    esac
done

if [[ -n "$IMPERSONATE" && "$IMPERSONATE" == -* ]]; then
    err "--as requires a username, got: $IMPERSONATE"
    exit 2
fi

debug "sourcing mrm-env.sh (endpoint resolution)"
# shellcheck source=scripts/mrm-env.sh
. "$SCRIPT_DIR/mrm-env.sh"
debug "resolved: region=${AWS_REGION:-<unset>} api=${MRM_API_URL:-<unresolved>} id=${MRM_API_ID:-<unresolved>}"

# Clean up the per-PID diagnostic file mrm-env.sh may write (in $TMPDIR).
trap 'rm -f "${MRM_ENV_ERR_FILE:-}" 2>/dev/null || true' EXIT

usage_and_die() {
    err "Usage: $(basename "$0") [options] <METHOD> <PATH> [JSON_BODY]"
    err "       $(basename "$0") --token"
    exit 2
}

command -v node >/dev/null 2>&1 || { err "node is required (for base64url + HMAC)"; exit 1; }
command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }

# --------------------------------------------------------------------------
# Token
# --------------------------------------------------------------------------
TOKEN_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/mrm"

# Resolve the identity baked into a minted token. Precedence:
#   --as <user>  >  $MRM_AUTH_USERNAME  >  the AWS caller identity  >  mrm-cli
# For --as, the name must match the MRM user id / AD sAMAccountName so that
# group-based visibility resolves (e.g. "Tilman", not "tilman@lunex.one").
_caller_identity=""
resolve_identity() {
    if [ -n "$IMPERSONATE" ]; then
        TOKEN_USERNAME="$IMPERSONATE"
    elif [ -n "${MRM_AUTH_USERNAME:-}" ]; then
        TOKEN_USERNAME="$MRM_AUTH_USERNAME"
    else
        # Derive from the AWS caller ARN, e.g.
        #   arn:aws:iam::123:user/Tilman@Lunex.one   -> Tilman@Lunex.one
        #   arn:aws:sts::123:assumed-role/Role/alice -> alice
        if [ -z "$_caller_identity" ]; then
            local sts_err=""
            _caller_identity=$(mrm_env_aws sts get-caller-identity \
                --query Arn --output text 2>/tmp/mrm-sts.$$ ) || sts_err=$(cat /tmp/mrm-sts.$$ 2>/dev/null)
            rm -f /tmp/mrm-sts.$$ 2>/dev/null
            if [ -n "$sts_err" ]; then
                warn "Could not determine your AWS identity — token will be attributed to 'mrm-cli'."
                debug "sts get-caller-identity failed: $sts_err"
            fi
        fi
        TOKEN_USERNAME="${_caller_identity##*/}"
        [ -n "$TOKEN_USERNAME" ] && [ "$TOKEN_USERNAME" != "None" ] || TOKEN_USERNAME="mrm-cli"
    fi

    if [ -n "${MRM_AUTH_EMAIL:-}" ]; then
        TOKEN_EMAIL="$MRM_AUTH_EMAIL"
    elif [[ "$TOKEN_USERNAME" == *@* ]]; then
        TOKEN_EMAIL="$TOKEN_USERNAME"
    else
        TOKEN_EMAIL="${TOKEN_USERNAME}@localhost"
    fi

    debug "identity: username=$TOKEN_USERNAME email=$TOKEN_EMAIL admin=$AS_ADMIN"
}

token_is_valid() {
    # stdin: a JWT. Valid if it parses and expires more than 60s from now.
    node -e '
        let t = "";
        process.stdin.on("data", d => t += d);
        process.stdin.on("end", () => {
            try {
                const parts = t.trim().split(".");
                if (parts.length !== 3) process.exit(1);
                const p = JSON.parse(Buffer.from(parts[1], "base64url").toString());
                process.exit(p.exp && p.exp > Math.floor(Date.now() / 1000) + 60 ? 0 : 1);
            } catch { process.exit(1); }
        });
    ' 2>/dev/null
}

mint_token() {
    mrm_env_require MRM_PASCAL_NAME || exit 1
    local secret_id="/${MRM_PASCAL_NAME}/Auth/JwtSecret"
    debug "reading JWT secret from Secrets Manager: $secret_id (region ${AWS_REGION:-default})"
    local secret secret_err=""
    secret=$(mrm_env_aws secretsmanager get-secret-value \
        --secret-id "$secret_id" --query SecretString --output text 2>/tmp/mrm-sm.$$ ) \
        || secret_err=$(cat /tmp/mrm-sm.$$ 2>/dev/null)
    rm -f /tmp/mrm-sm.$$ 2>/dev/null
    if [ -z "$secret" ] || [ "$secret" = "None" ]; then
        err "Could not read the JWT signing secret from Secrets Manager: $secret_id"
        if [ -n "$secret_err" ]; then
            err "AWS said:"
            printf '%s\n' "$secret_err" | sed '/^[[:space:]]*$/d; s/^/    /' >&2
        fi
        err "Likely causes:"
        err "  • AWS credentials expired or wrong profile — check: aws sts get-caller-identity"
        err "  • Wrong region — the deployment is in \${AWS_REGION:-<unset>}; set AWS_REGION in .env"
        err "  • Your principal lacks secretsmanager:GetSecretValue on that secret"
        err "Workaround: export MRM_AUTH_TOKEN=<token copied from the web console>"
        exit 1
    fi
    debug "JWT secret retrieved (${#secret} chars); minting $([ "$AS_ADMIN" = true ] && echo admin || echo non-admin) token for $TOKEN_USERNAME, ttl ${MRM_AUTH_TTL_SECONDS:-3600}s"

    # The secret is a raw 64-char string, not JSON (lib/api-stack.ts:97-104).
    # Payload mirrors what lambda/ldap-auth/index.js:232-242 issues, so the
    # deployed authorizer accepts it unchanged.
    MRM_JWT_SECRET="$secret" \
    MRM_JWT_USERNAME="$TOKEN_USERNAME" \
    MRM_JWT_EMAIL="$TOKEN_EMAIL" \
    MRM_JWT_ADMIN="$AS_ADMIN" \
    MRM_JWT_TTL="${MRM_AUTH_TTL_SECONDS:-3600}" \
    node -e '
        const crypto = require("crypto");
        const secret = process.env.MRM_JWT_SECRET;
        const username = process.env.MRM_JWT_USERNAME;
        const now = Math.floor(Date.now() / 1000);
        const payload = {
            username,
            email: process.env.MRM_JWT_EMAIL || (username + "@localhost"),
            given_name: username,
            family_name: "",
            isAdmin: process.env.MRM_JWT_ADMIN === "true",
            iat: now,
            exp: now + parseInt(process.env.MRM_JWT_TTL, 10),
        };
        const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
        const input = b64({ alg: "HS256", typ: "JWT" }) + "." + b64(payload);
        const sig = crypto.createHmac("sha256", secret).update(input).digest("base64url");
        process.stdout.write(input + "." + sig);
    '
}

get_token() {
    if [ -n "${MRM_AUTH_TOKEN:-}" ]; then
        debug "using token from \$MRM_AUTH_TOKEN (identity/role flags ignored)"
        printf '%s' "$MRM_AUTH_TOKEN"
        return 0
    fi

    # Identity is resolved by the caller (in the parent shell) so the verbose
    # "acting as" line can see it; TOKEN_USERNAME/TOKEN_EMAIL are inherited here.
    [ -n "${TOKEN_USERNAME:-}" ] || resolve_identity

    # Cache per (api, identity, admin) so switching --as / --admin never reuses
    # another identity's token. The identity is slugged for a safe filename.
    local id_slug
    id_slug=$(printf '%s' "$TOKEN_USERNAME" | tr -c 'A-Za-z0-9._-' '_')
    local role_slug; role_slug=$([ "$AS_ADMIN" = true ] && echo 'admin' || echo 'user')
    local cache_file="${TOKEN_CACHE_DIR}/token-${MRM_API_ID:-default}-${role_slug}-${id_slug}.jwt"

    if [ "$USE_CACHE" = true ] && [ -f "$cache_file" ]; then
        if token_is_valid < "$cache_file"; then
            debug "token cache hit: $cache_file"
            cat "$cache_file"
            return 0
        fi
        debug "token cache stale/expired, re-minting: $cache_file"
    else
        debug "token cache miss${USE_CACHE:+ }($([ "$USE_CACHE" = true ] && echo 'no cached token' || echo 'caching disabled'))"
    fi

    local token
    token=$(mint_token)
    [ -n "$token" ] || { err "Failed to mint a token (see messages above)."; exit 1; }

    if [ "$USE_CACHE" = true ]; then
        mkdir -p "$TOKEN_CACHE_DIR"
        ( umask 077; printf '%s' "$token" > "$cache_file" )
        debug "token cached: $cache_file"
    fi
    printf '%s' "$token"
}

if [ "$PRINT_TOKEN_ONLY" = true ]; then
    [ -z "${MRM_AUTH_TOKEN:-}" ] && resolve_identity
    get_token
    echo
    exit 0
fi

# --------------------------------------------------------------------------
# Request
# --------------------------------------------------------------------------
[ $# -ge 2 ] || usage_and_die

METHOD="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
ENDPOINT="$2"
BODY="${3:-}"

mrm_env_require MRM_API_URL || exit 1

case "$ENDPOINT" in /*) ;; *) ENDPOINT="/$ENDPOINT" ;; esac
URL="${MRM_API_URL}${ENDPOINT}"

[ -z "${MRM_AUTH_TOKEN:-}" ] && resolve_identity
TOKEN="$(get_token)"

curl_args=(
    --silent --show-error
    --max-time "${MRM_HTTP_TIMEOUT:-60}"
    --request "$METHOD"
    --header "Authorization: Bearer ${TOKEN}"
    --write-out '\n%{http_code}'
)
if [ -n "$BODY" ]; then
    curl_args+=(--header 'Content-Type: application/json' --data "$BODY")
fi

if [ "$VERBOSE" = true ]; then
    info "$METHOD $URL"
    info "acting as: ${TOKEN_USERNAME:-?} ($([ "$AS_ADMIN" = true ] && echo admin || echo 'non-admin'))"
fi
debug "request: $METHOD $URL"
[ -n "$BODY" ] && debug "request body: $BODY"
debug "timeout: ${MRM_HTTP_TIMEOUT:-60}s"

# Capture curl's own stderr (DNS/TLS/timeout failures) separately from the body.
CURL_ERR=""
RESPONSE="$(curl "${curl_args[@]}" "$URL" 2>/tmp/mrm-curl.$$)" || CURL_ERR=$(cat /tmp/mrm-curl.$$ 2>/dev/null)
rm -f /tmp/mrm-curl.$$ 2>/dev/null

STATUS="${RESPONSE##*$'\n'}"
PAYLOAD="${RESPONSE%$'\n'*}"

# A transport failure (DNS, TLS, refused, timeout) yields status 000 / no body
# and a curl error on stderr — distinct from an HTTP error status.
if [ -n "$CURL_ERR" ] && { [ "$STATUS" = "000" ] || [ -z "$STATUS" ]; }; then
    err "Request failed before an HTTP response was received:"
    printf '%s\n' "$CURL_ERR" | sed 's/^/    /' >&2
    err "Check the endpoint ($URL), your network, and any proxy/VPN."
    exit 1
fi

[ "$VERBOSE" = true ] && info "HTTP $STATUS"
debug "response status: $STATUS"
debug "response bytes: ${#PAYLOAD}"

# Explain the common failures instead of just printing a status.
case "$STATUS" in
    401)
        warn "HTTP 401 — the authorizer rejected the token."
        warn "Try --no-cache to mint a fresh one, or --debug to see identity/mint details."
        ;;
    403)
        # Distinguish API Gateway's own 403 for an undefined path/method (its
        # gateway responses mention the Authorization header or a missing auth
        # token) from a handler permission denial (which uses an "error" field).
        if printf '%s' "$PAYLOAD" | grep -qiE "Authentication Token|Authorization header"; then
            warn "HTTP 403 — no such route. API Gateway returns this for a path or"
            warn "method that isn't defined. Check the spelling and the HTTP verb."
        else
            warn "HTTP 403 — authenticated but not permitted."
            warn "You are acting as '${TOKEN_USERNAME:-?}' ($([ "$AS_ADMIN" = true ] && echo admin || echo 'non-admin'));"\
                 "this route may be admin-only."
            [ "$AS_ADMIN" != true ] && warn "Drop --as/--no-admin to use the default admin token."
        fi
        ;;
    404)
        warn "HTTP 404 — not found. Check the path and method; some routes 404 on the wrong verb."
        ;;
    5[0-9][0-9])
        warn "HTTP $STATUS — server-side error. The response body below may carry details."
        ;;
esac

if [ "$RAW" = false ] && command -v jq >/dev/null 2>&1 \
   && printf '%s' "$PAYLOAD" | jq empty >/dev/null 2>&1; then
    printf '%s' "$PAYLOAD" | jq .
else
    # Not JSON (or --raw): print as-is. On an error status an empty body is a
    # useful signal in itself, so say so rather than printing nothing.
    if [ -z "$PAYLOAD" ]; then
        case "$STATUS" in 2*) : ;; *) warn "(empty response body)";; esac
    else
        printf '%s\n' "$PAYLOAD"
    fi
fi

# 2xx -> 0, anything else -> 1
case "$STATUS" in 2*) exit 0 ;; *) debug "exiting non-zero for status $STATUS"; exit 1 ;; esac
