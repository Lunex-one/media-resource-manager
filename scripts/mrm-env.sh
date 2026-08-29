#!/bin/bash
# scripts/mrm-env.sh
#
# Shared endpoint/configuration resolution for MRM tooling.
# SOURCE this file, do not execute it:
#
#     . "$(dirname "${BASH_SOURCE[0]}")/mrm-env.sh"
#
# Resolution order for every value (first hit wins):
#   1. Already set in the environment  (so CI / one-off overrides win)
#   2. The repo-root .env file         (gitignored; see .env.example)
#   3. SSM Parameter Store / CloudFormation stack outputs
#
# Exports: MRM_PASCAL_NAME, MRM_ACRONYM, MRM_API_URL, MRM_API_ID,
#          MRM_FRONTEND_URL, AWS_REGION (when discoverable).
#
# No endpoint is hardcoded here. If a value cannot be resolved, the
# mrm_env_require helper fails loudly rather than degrading silently.

MRM_ENV_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MRM_REPO_ROOT="$(dirname "$MRM_ENV_SCRIPT_DIR")"

mrm_env_log()  { printf '\033[0;34m[mrm-env]\033[0m %s\n' "$*" >&2; }
mrm_env_warn() { printf '\033[1;33m[mrm-env]\033[0m %s\n' "$*" >&2; }
mrm_env_err()  { printf '\033[0;31m[mrm-env]\033[0m %s\n' "$*" >&2; }
# Gated on MRM_DEBUG; always to stderr so it never corrupts a resolved value.
mrm_env_debug() { [ -n "${MRM_DEBUG:-}" ] && printf '\033[0;90m[mrm-env] %s\033[0m\n' "$*" >&2; return 0; }

# Records the stderr of the most recent failing AWS call, so mrm_env_require can
# explain *why* a value could not be resolved instead of only that it wasn't.
# Endpoint resolution runs the lookups inside command substitutions (subshells),
# so a plain variable set there would not reach the parent shell. We persist it
# to a per-PID file as well; $$ is the parent PID even inside a subshell, so the
# writer (subshell) and reader (parent) agree on the path.
MRM_ENV_LAST_AWS_ERROR=""
MRM_ENV_ERR_FILE="${TMPDIR:-/tmp}/mrm-env-lasterr.$$"
rm -f "$MRM_ENV_ERR_FILE" 2>/dev/null || true

# --- 1 + 2: load .env without clobbering anything already in the environment ---
mrm_env_load_dotenv() {
    local env_file="${MRM_ENV_FILE:-$MRM_REPO_ROOT/.env}"
    [ -f "$env_file" ] || return 0

    local line key val
    while IFS= read -r line || [ -n "$line" ]; do
        # skip blanks, comments and anything that isn't KEY=VALUE
        case "$line" in
            ''|'#'*) continue ;;
            *=*) ;;
            *) continue ;;
        esac
        key="${line%%=*}"
        val="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"   # ltrim
        key="${key%"${key##*[![:space:]]}"}"   # rtrim
        key="${key#export }"
        case "$key" in
            ''|*[!A-Za-z0-9_]*) continue ;;    # not a valid identifier
        esac
        val="${val#"${val%%[![:space:]]*}"}"
        val="${val%"${val##*[![:space:]]}"}"
        # strip one layer of matching quotes
        case "$val" in
            \"*\") val="${val#\"}"; val="${val%\"}" ;;
            \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        # environment wins over the file
        if [ -z "${!key:-}" ]; then
            export "$key=$val"
        fi
    done < "$env_file"
}

# --- product naming, matching deploy.sh / cleanup-software-library.sh ---
mrm_env_resolve_names() {
    local cdk_json=""
    if [ -f "$MRM_REPO_ROOT/cdk.json" ]; then
        cdk_json="$MRM_REPO_ROOT/cdk.json"
    elif [ -f "$MRM_REPO_ROOT/cdk.example.json" ]; then
        cdk_json="$MRM_REPO_ROOT/cdk.example.json"
    fi

    local product_name=""
    if [ -n "$cdk_json" ] && command -v node >/dev/null 2>&1; then
        product_name=$(node -p "require('$cdk_json').context.productName" 2>/dev/null || true)
        [ "$product_name" = "undefined" ] && product_name=""
    fi
    [ -n "$product_name" ] || product_name="Media Resource Manager"

    if [ -z "${MRM_PASCAL_NAME:-}" ]; then
        # "Media Resource Manager" -> "MediaResourceManager"
        export MRM_PASCAL_NAME="$(printf '%s' "$product_name" | tr -d '[:space:]')"
    fi
    if [ -z "${MRM_ACRONYM:-}" ]; then
        # "Media Resource Manager" -> "MRM"
        export MRM_ACRONYM="$(printf '%s' "$product_name" \
            | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}')"
    fi
}

mrm_env_aws() {
    if [ -n "${AWS_REGION:-}" ]; then
        aws --region "$AWS_REGION" "$@"
    else
        aws "$@"
    fi
}

# Run an AWS command, printing its stdout, capturing its stderr for diagnostics,
# and always returning 0 -- so a failure never aborts a caller under `set -e`.
# These lookups are best-effort: callers fall back to other sources and tolerate
# an empty result, but the captured error is surfaced by mrm_env_require and in
# debug output so a real failure (expired creds, wrong region) is never silent.
_mrm_env_run() {
    local errfile out rc err
    errfile=$(mktemp 2>/dev/null || printf '%s' "${TMPDIR:-/tmp}/mrm-env.$$.$RANDOM")
    out=$(mrm_env_aws "$@" 2>"$errfile"); rc=$?
    err=$(cat "$errfile" 2>/dev/null)
    rm -f "$errfile" 2>/dev/null

    # A non-result is either a non-zero exit or an empty/None value. The AWS CLI
    # sometimes exits 0 on an SSO/credential-refresh error, printing the reason
    # only to stderr, so we key on the value, not just the exit code, and record
    # whatever stderr explained it.
    if [ "$rc" -ne 0 ] || [ -z "$out" ] || [ "$out" = "None" ]; then
        if [ -n "$err" ]; then
            MRM_ENV_LAST_AWS_ERROR="$err"                       # same-shell callers
            printf '%s' "$err" > "$MRM_ENV_ERR_FILE" 2>/dev/null # survives subshells
        fi
        mrm_env_debug "aws $* -> rc=$rc out='${out:-<empty>}' err='${err:-<none>}'"
    fi
    printf '%s' "$out"
    return 0
}

mrm_env_ssm() {
    mrm_env_debug "SSM get-parameter $1 (region ${AWS_REGION:-<default>})"
    _mrm_env_run ssm get-parameter --name "$1" --query 'Parameter.Value' --output text
}

mrm_env_stack_output() {
    mrm_env_debug "CFN describe-stacks $1 output $2 (region ${AWS_REGION:-<default>})"
    _mrm_env_run cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

# --- 3: fill the gaps from SSM / CloudFormation ---
mrm_env_resolve_endpoints() {
    if [ -z "${AWS_REGION:-}" ]; then
        local cfg_region
        cfg_region=$(aws configure get region 2>/dev/null || true)
        [ -n "$cfg_region" ] && export AWS_REGION="$cfg_region"
        mrm_env_debug "AWS_REGION not set; from 'aws configure': ${AWS_REGION:-<none>}"
    fi
    mrm_env_debug "names: pascal=$MRM_PASCAL_NAME acronym=$MRM_ACRONYM region=${AWS_REGION:-<default>}"

    if [ -z "${MRM_API_URL:-}" ]; then
        local url
        url=$(mrm_env_ssm "/${MRM_PASCAL_NAME}/Workstation/ApiUrl")
        if [ -z "$url" ] || [ "$url" = "None" ]; then
            url=$(mrm_env_stack_output "${MRM_ACRONYM}-Api" "ApiUrl")
        fi
        if [ -n "$url" ] && [ "$url" != "None" ]; then
            export MRM_API_URL="$url"
        fi
    fi

    if [ -z "${MRM_FRONTEND_URL:-}" ]; then
        local web
        web=$(mrm_env_stack_output "${MRM_ACRONYM}-Frontend" "WebsiteUrl")
        if [ -z "$web" ] || [ "$web" = "None" ]; then
            web=$(mrm_env_ssm "/${MRM_PASCAL_NAME}/Frontend/CloudFrontUrl")
        fi
        if [ -n "$web" ] && [ "$web" != "None" ]; then
            export MRM_FRONTEND_URL="$web"
        fi
    fi

    # Normalise: no trailing slash, and derive the REST API id from the URL.
    if [ -n "${MRM_API_URL:-}" ]; then
        export MRM_API_URL="${MRM_API_URL%/}"
        if [ -z "${MRM_API_ID:-}" ]; then
            local host="${MRM_API_URL#https://}"
            host="${host#http://}"
            host="${host%%/*}"
            case "$host" in
                *.execute-api.*) export MRM_API_ID="${host%%.*}" ;;
            esac
        fi
    fi
    [ -n "${MRM_FRONTEND_URL:-}" ] && export MRM_FRONTEND_URL="${MRM_FRONTEND_URL%/}"
    mrm_env_debug "resolved: api=${MRM_API_URL:-<unresolved>} id=${MRM_API_ID:-<unresolved>} frontend=${MRM_FRONTEND_URL:-<unresolved>}"
    return 0
}

# Fail loudly when a required value could not be resolved.
# Usage: mrm_env_require MRM_API_URL
mrm_env_require() {
    local var missing=0
    for var in "$@"; do
        if [ -z "${!var:-}" ]; then
            mrm_env_err "$var is not set and could not be resolved."
            missing=1
        fi
    done
    if [ "$missing" -ne 0 ]; then
        # Prefer the same-shell value; fall back to the file written by lookups
        # that ran inside command-substitution subshells.
        local last_err="$MRM_ENV_LAST_AWS_ERROR"
        if [ -z "$last_err" ] && [ -f "$MRM_ENV_ERR_FILE" ]; then
            last_err=$(cat "$MRM_ENV_ERR_FILE" 2>/dev/null)
        fi
        if [ -n "$last_err" ]; then
            # The most common real cause: AWS was reachable-in-config but the call
            # failed (expired SSO/creds, wrong region, missing permission).
            mrm_env_err "The last AWS lookup failed with:"
            printf '%s\n' "$last_err" | sed '/^[[:space:]]*$/d; s/^/    /' >&2
        fi
        mrm_env_err "Fix by any of:"
        mrm_env_err "  • Set it in $MRM_REPO_ROOT/.env (copy .env.example) or export it"
        mrm_env_err "  • Refresh AWS credentials — check: aws sts get-caller-identity"
        mrm_env_err "  • Ensure AWS_REGION matches the deployment (currently: ${AWS_REGION:-<unset>})"
        mrm_env_err "  • Deploy the stack so the value exists in SSM / CloudFormation"
        mrm_env_err "  • Re-run with MRM_DEBUG=1 (or --debug) to trace each lookup"
        return 1
    fi
    return 0
}

# Sourcing must never abort a caller running under `set -e`: these steps are
# best-effort, and a genuinely missing value is reported later by mrm_env_require.
mrm_env_load_dotenv || true
mrm_env_resolve_names || true
mrm_env_resolve_endpoints || true
