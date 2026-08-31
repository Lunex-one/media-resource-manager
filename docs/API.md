# MRM API Reference

The Media Resource Manager exposes a single **API Gateway REST API**. Every route lives on the
`prod` stage of that one API; there is no second API, no GraphQL endpoint, and no Lambda
function URL.

- **90 routes** (excluding CORS `OPTIONS` preflight) across 69 resources, served by 40 Lambdas.
- **88 of them require a bearer token.** Only `POST /auth/ldap` and `GET /auth/validate` are open.
- Requests and responses are JSON. Two routes stream Server-Sent Events.

> Defined in [`lib/api-stack.ts`](../lib/api-stack.ts). This document is generated from the
> handlers and verified against the deployed API — see [Keeping this accurate](#keeping-this-accurate).

## Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Calling the API](#calling-the-api)
- [Conventions](#conventions)
- [Routes](#routes)
  - [Auth](#auth) · [Workstations](#workstations) · [Settings and catalog](#settings-and-catalog)
  - [Users and groups](#users-and-groups) · [Images and pipelines](#images-and-pipelines)
  - [Software library](#software-library) · [AI script generation](#ai-script-generation)
  - [Storage](#storage) · [DataSync](#datasync) · [Regional hubs](#regional-hubs)
  - [DCV](#dcv) · [Progress](#progress)
- [CORS](#cors)
- [Known quirks](#known-quirks)

---

## Base URL

```
https://{restApiId}.execute-api.{region}.amazonaws.com/prod/
```

There is no custom domain for the API — the custom-domain support in this repo applies only to
the CloudFront frontend. Never hardcode the URL; resolve it at runtime. In order of preference:

**1. `scripts/mrm-env.sh`** — what all tooling in this repo uses. It reads `.env`, then falls
back to SSM and CloudFormation:

```bash
. scripts/mrm-env.sh
echo "$MRM_API_URL"     # no trailing slash
echo "$MRM_API_ID"      # the REST API id, parsed from the URL
```

**2. SSM Parameter Store** — the canonical source, written by the API stack on deploy:

```bash
aws ssm get-parameter --name "/${PASCAL_CASE_NAME}/Workstation/ApiUrl" \
  --query Parameter.Value --output text
```

`PASCAL_CASE_NAME` is `cdk.json`'s `context.productName` with spaces removed — `MediaResourceManager`
by default.

**3. CloudFormation output** on the `${ACRONYM}-Api` stack:

```bash
aws cloudformation describe-stacks --stack-name "${ACRONYM}-Api" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text
```

**4. The browser** — the frontend fetches `/config.json` from its own origin, written to the
website bucket by [`lambda/config-generator/index.js`](../lambda/config-generator/index.js):

```json
{
  "region": "…",
  "apiUrl": "https://….execute-api.….amazonaws.com/prod/",
  "useCognitoAuth": false,
  "enableBedrockFeatures": true,
  "identityProviders": [],
  "acronym": "MRM"
}
```

> The `region` matters. If your default AWS CLI region differs from the deployment region, every
> lookup above silently returns nothing. Set `AWS_REGION` in `.env`.

---

## Authentication

All protected routes use a **custom Lambda authorizer**
([`lambda/jwt-authorizer/index.js`](../lambda/jwt-authorizer/index.js)) — not a Cognito
authorizer, not IAM SigV4, and not API keys. Send:

```
Authorization: Bearer <jwt>
```

The authorizer is registered with `resultsCacheTtl: 0` (`lib/api-stack.ts:1101`), so every
request is authorized afresh — a revoked or expired token stops working immediately, at the cost
of one Lambda invocation per request.

It accepts two kinds of token:

| Kind | Algorithm | Signed with | Issued by |
|---|---|---|---|
| **Local / LDAP** | HS256 | 64-char string in Secrets Manager at `/${PASCAL_CASE_NAME}/Auth/JwtSecret` | `POST /auth/ldap`, or minted directly (below) |
| **Cognito** | RS256 | Cognito user pool JWKS | Cognito hosted UI, SAML federation, or `InitiateAuth` |

On success the authorizer injects a context object that handlers read from
`event.requestContext.authorizer`:

```js
{ username, userId, email, firstName, lastName, isAdmin: 'true'|'false', tokenType: 'ldap'|'cognito' }
```

`isAdmin` drives visibility throughout the API — see [Admin vs. non-admin](#admin-vs-non-admin).

### Which path applies to your deployment

Check `useCognitoAuth` in the deployed `config.json`. When it is `false`, the Cognito login
paths are not wired up and the local/LDAP token is the only one in circulation.

### Getting a token

#### Option A — mint one locally (recommended for scripting)

Needs AWS credentials for the deployment account and `secretsmanager:GetSecretValue` on the JWT
secret. No AD, no browser, no Cognito.

```bash
./scripts/mrm-api.sh --token            # an admin token, identified as your AWS caller
./scripts/mrm-api.sh --as alice --token # a non-admin token impersonating user "alice"
```

By default the minted token is an **admin** token whose identity is your AWS caller (parsed from
`aws sts get-caller-identity`). This matches what an administrator sees in the web console —
admins see every workstation, user and group. Since anyone who can read the JWT secret is already
fully privileged, this grants nothing new; it just stops the CLI from silently showing a
different, empty view than the console. Use `--as <user>` to mint a **non-admin** token and see
the API as that specific user (for testing per-user/group visibility); the name must match the
MRM user id / AD sAMAccountName (e.g. `Tilman`, not `tilman@lunex.one`) for group membership to
resolve.

The payload matches what `lambda/ldap-auth/index.js:232-242` issues, so the deployed authorizer
accepts it unchanged:

```json
{
  "username": "alice",
  "email": "alice@example.com",
  "given_name": "alice",
  "family_name": "",
  "isAdmin": false,
  "iat": 1756468800,
  "exp": 1756472400
}
```

Signed `HS256` over `base64url(header) + "." + base64url(payload)` with the raw secret string
from `/${PASCAL_CASE_NAME}/Auth/JwtSecret`. The secret is a plain 64-character string, **not**
JSON (`lib/api-stack.ts:97-104`).

#### Option B — LDAP

The path the web console uses when `useCognitoAuth` is `false`. Requires a valid AWS Managed
Microsoft AD account; the `mrm-ldap-auth` Lambda runs in the VPC and binds to the domain over
LDAP on port 389.

```bash
curl -sX POST "$MRM_API_URL/auth/ldap" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"…"}'
```

```json
{ "success": true, "message": "LDAP authentication successful", "username": "alice", "token": "eyJ…" }
```

Tokens expire after **1 hour**. Admin status comes from AD group membership — the handler looks
for a group matching `AWS Delegated Administrators`.

#### Option C — Cognito

Only when `useCognitoAuth` is `true`. Three sub-flows, all implemented in
[`frontend/src/utils/auth.ts`](../frontend/src/utils/auth.ts):

- **Username/password** (`auth.ts:107`) — a direct `InitiateAuth` call with
  `AuthFlow: USER_PASSWORD_AUTH`. The client has no secret, so this works from a script. Use
  `AuthenticationResult.IdToken` as the bearer, **not** the access token — the API reads identity
  claims that only the ID token carries. First login may return a `NEW_PASSWORD_REQUIRED`
  challenge (`auth.ts:201`).
- **Hosted UI / SAML** (`auth.ts:72`, `:88`) — authorization-code flow against
  `{cognitoDomain}/oauth2/authorize`, then `{cognitoDomain}/oauth2/token` (`auth.ts:334`).
  Scopes `email openid profile`.
- Pool id, client id and domain come from SSM under `/${PASCAL_CASE_NAME}/Auth/`, or from
  `config.json`.

#### Option D — copy from the browser

Log into the web console, then read `auth-token` out of `sessionStorage`. Useful for a one-off;
the token expires in an hour and this doesn't automate.

---

## Calling the API

### With the bundled client

[`scripts/mrm-api.sh`](../scripts/mrm-api.sh) resolves the endpoint, mints and caches a token,
and pretty-prints the response:

```bash
./scripts/mrm-api.sh GET  /workstations                       # admin view (default)
./scripts/mrm-api.sh --as alice GET /workstations             # just alice's machines
./scripts/mrm-api.sh POST /workstations/start '{"instanceId":"i-0abc123"}'
./scripts/mrm-api.sh --verbose --no-cache GET /images
./scripts/mrm-api.sh --info                                   # endpoint + example curl
```

`--info` answers "what am I actually pointing at, and how do I call it by hand?" — it prints the
resolved base URL (plus API id, region and frontend URL) and a `curl` for `GET /workstations`
carrying a live token, ready to paste anywhere. It honours `--as`/`--admin`, so the example is for
the identity you name, and it reports whose token it is and how long it lasts.

| Flag | Effect |
|---|---|
| `--as <user>` | Mint a **non-admin** token impersonating that MRM user |
| `--no-admin` | Mint a non-admin token keeping the default (caller) identity |
| `--admin` | Mint an admin token (this is the default; kept for clarity) |
| `--token` | Print a bearer token and exit |
| `--info` | Print the resolved endpoint and a ready-to-run `curl` example, then exit |
| `--raw` | Skip `jq` pretty-printing |
| `--verbose` | Log the request line, HTTP status, and the acting identity |
| `--debug` | Full troubleshooting trace (also via `MRM_DEBUG=1`) — see below |
| `--no-cache` | Ignore the cached token and mint a fresh one |

By default the token is an admin token identified as your AWS caller, so a list route returns the
same rows an administrator sees in the console. `--verbose` prints the acting identity
(`acting as: <user> (admin|non-admin)`) so the context is never ambiguous. Tokens are cached per
`(api, identity, role)`, so switching `--as`/`--admin` never reuses another identity's token.

Exit status is `0` for 2xx and `1` otherwise, so it composes in scripts.

#### Troubleshooting

The client is built to explain failures rather than fail silently:

- **`--debug`** (or `MRM_DEBUG=1`) traces every step to stderr — endpoint resolution, the exact
  SSM/CloudFormation lookups, identity resolution, token cache hit/miss, minting, and the request
  and response. The JSON body stays on stdout, so `--debug` is safe to pipe. Secrets are redacted
  (the JWT secret is only ever reported by length).
- **Expired or wrong AWS credentials** are the most common cause of an empty result. When a value
  can't be resolved or the JWT secret can't be read, the script prints the underlying AWS error
  (e.g. an SSO `CreateOAuth2Token` failure, `ResourceNotFoundException`, or a wrong-region miss)
  plus a checklist — refresh creds with `aws sts get-caller-identity`, confirm `AWS_REGION`, etc.
- **HTTP status is explained, not just shown**: `401` (bad/expired token → try `--no-cache`),
  `403` distinguishing an admin-only route from a non-existent path/method, `404`, and `5xx`.
- **Transport failures** (DNS, TLS, timeout, proxy/VPN) are reported with curl's own error and the
  URL that was attempted, distinct from an HTTP error status.

`scripts/mrm-env.sh` is safe to `source` under `set -euo pipefail`: a transient AWS failure never
aborts the caller, but the error is captured and surfaced by `mrm_env_require` instead of vanishing.

### With plain curl

```bash
. scripts/mrm-env.sh
TOKEN="$(./scripts/mrm-api.sh --token)"

curl -s "$MRM_API_URL/workstations" -H "Authorization: Bearer $TOKEN" | jq .

curl -s -X POST "$MRM_API_URL/workstations/stop" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"instanceId":"i-0abc123"}' | jq .
```

---

## Conventions

### Status codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created — storage resources |
| `202` | Accepted — work continues asynchronously (volume operations, script generation) |
| `400` | Missing or invalid fields. Body: `{"error": "…"}` |
| `401` | No/invalid token. `{"message":"Unauthorized"}` from the authorizer; handler-level 401s use `{"error":"…"}` |
| `403` | Authenticated but not permitted — usually an admin-only route, or a feature disabled by settings |
| `404` | Resource not found, **or** the method/path pair fell through the handler's router |
| `405` | Method not allowed (software library only) |
| `429` | AI agent usage limit. Body includes `{limitType, currentUsage, limit}` |
| `500` | Handler error. Body: `{"error": "…"}` |
| `503` | AI agent disabled (`EnableBedrockFeatures=false`) |

A `404` with `{"error":"Not found"}` usually means the path exists in API Gateway but the backing
Lambda's internal router did not match it. Check the method.

### Error shape

Most handlers return `{"error": "message"}`. Storage handlers wrap responses as
`{"success": bool, "data"|"error": …}`. The authorizer's own rejection is
`{"message": "Unauthorized"}` — note the different key.

### Admin vs. non-admin

The authorizer's `isAdmin` flag changes what routes return rather than only whether they
succeed. `GET /workstations` returns every workstation for an admin, but only those assigned to
the caller or to a group the caller belongs to otherwise
(`lambda/workstation-manager/index.js:315`). Settings, user management and schedule routes
reject non-admins outright with `403`.

Group-based visibility keys on the token's `username` matching the MRM user id / AD
sAMAccountName (the domain part of an `user@domain` name is stripped first). A name that matches
no user resolves no groups and sees nothing — which is why a mistyped or lowercased identity
returns an empty list even though the account exists.

`scripts/mrm-api.sh` defaults to an admin token, so its lists match the administrator view in the
console; use `--as <user>` to reproduce a specific non-admin user's narrower view.

---

## Routes

Paths below are relative to the base URL. `{…}` denotes a path parameter.

### Auth

| Method | Path | Auth | Lambda |
|---|---|---|---|
| `POST` | `/auth/ldap` | **none** | `mrm-ldap-auth` |
| `GET` | `/auth/validate` | **none** | `mrm-validate-jwt` |
| `POST` | `/change-password` | bearer | `mrm-change-password` |

**`POST /auth/ldap`** — `{username, password}` → `{success, message, username, token}`.
`400` if either field is missing, `401` on bad credentials.

**`GET /auth/validate`** — see [Known quirks](#known-quirks); this route is not usable as built.

**`POST /change-password`** — `{username, currentPassword, newPassword}`. Resets the password in
AWS Managed Microsoft AD.

### Workstations

Split across two Lambdas — `mrm-workstation-manager` owns the lifecycle, `mrm-workstation-api`
owns keep-alive and settings. The split is not visible to callers but explains why similar paths
behave differently.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/workstations` | — | Filtered by caller unless admin |
| `POST` | `/workstations` | see below | Single object, or `{workstations: [...]}` for batch |
| `GET` | `/workstations/{id}` | — | `id` is the EC2 instance id |
| `PUT` | `/workstations/{id}` | partial object | |
| `DELETE` | `/workstations/{id}` | — | Terminates the instance |
| `POST` | `/workstations/start` | `{instanceId}` | → `{message, executionArn}`; starts a Step Functions workflow |
| `POST` | `/workstations/stop` | `{instanceId}` | |
| `POST` | `/workstations/reboot` | `{instanceId}` | |
| `POST` | `/workstations/change-instance-type` | `{instanceId, instanceType}` | Both required → else `400`; `404` if unknown instance |
| `POST` | `/workstations/volumes/add` | `{instanceId, size, volumeType?, deviceName?}` | `202`; `volumeType` defaults to `gp3` |
| `POST` | `/workstations/volumes/resize` | `{instanceId, volumeId, newSize}` | `202` |
| `POST` | `/workstations/volumes/detach` | `{instanceId, volumeId, deleteVolume?}` | `202`; `deleteVolume` defaults to `false` |
| `POST` | `/workstations/keep-alive` | `{instanceId, durationHours}` | Both required; `403` if the feature is disabled and caller is not admin |
| `DELETE` | `/workstations/{id}/keep-alive` | — | Cancel |

**Create body** (`lambda/workstation-manager/index.js:852`):

```json
{
  "amiId": "ami-0123456789abcdef0",
  "instanceType": "g6.xlarge",
  "assignedUserId": "alice",
  "platform": "Windows",
  "rootVolumeSize": 500,
  "domainId": "d-90671eXXXX",
  "joinDomain": true,
  "pipelineId": "…",
  "region": "us-east-1",
  "acronym": "MRM"
}
```

`joinDomain` defaults to `true` and applies to Windows only. `region` targets a satellite
regional hub; an unknown region returns `400`. Volume operations return `202` immediately because
the volume manager can run longer than API Gateway's 30-second integration timeout — poll
`GET /workstations/{id}` for the result.

**Workstation object** (fields as returned):

```json
{
  "instanceId": "i-0abc…", "hostname": "vdi-0018", "workstationName": "linux-workstation-0018",
  "platform": "Linux", "status": "Stopped", "instanceStatus": "stopped",
  "dcvStatus": "stopped", "dcvSessionId": null, "sessionState": "NO_SESSION",
  "connectionCount": 0, "assignedUserId": "group-…", "amiId": "ami-…",
  "sourceAmiId": "ami-…", "subnetId": "subnet-…", "privateIpAddress": "10.100.1.193",
  "createdAt": "2026-08-27T02:56:54.700Z", "instanceStartTime": "2026-08-27T02:56:54.700Z"
}
```

### Settings and catalog

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/settings` | — | Non-admins get only `autoStartLeadTimeMinutes` |
| `POST` | `/settings` | see below | Admin only → `403` |
| `GET` | `/settings/instance-types` | — | Allowed types per platform |
| `POST` | `/settings/instance-types` | `{windows, linux, macos}` | Arrays of instance types; admin only |
| `GET` | `/instance-types/catalog` | — | Full EC2 catalog, synced by EventBridge |
| `GET` | `/domains` | — | Managed AD domains available for joining |

**Settings body:** `{disconnectedDuration, browserSessionsEnabled, keepAliveEnabled, keepAliveMaxHours, autoStartEnabled, autoStartLeadTimeMinutes}`. Stored in SSM under `/${PASCAL_CASE_NAME}/Settings/`.

### Users and groups

All on `mrm-user-group-manager` except `GET /users/{id}` (`mrm-user-details-manager`) and
`POST /users/sync` (`mrm-identity-center-sync`).

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/users` | — | |
| `POST` | `/users` | **polymorphic** — see below | |
| `GET` | `/users/{id}` | — | |
| `POST` | `/users/enable` | `{userIds: [...]}` | `403` in Cognito auth mode |
| `POST` | `/users/disable` | `{userIds: [...]}` | `403` in Cognito auth mode |
| `POST` | `/users/delete` | `{userIds: [...]}` | `403` in Cognito auth mode |
| `POST` | `/users/sync` | `{groupIds?, identityStoreId?}` | Sync from IAM Identity Center |
| `GET` | `/users/{id}/schedule` | — | Auto-start schedule |
| `PUT` | `/users/{id}/schedule` | `{enabled, timezone, schedule}` | Admin only |
| `DELETE` | `/users/{id}/schedule` | — | Admin only |
| `GET` | `/groups` | — | `?userId=<id>` returns just that user's groups |
| `POST` | `/groups` | `{groupName, description}` | `groupName` required, non-empty |
| `GET` | `/groups/{groupId}` | — | |
| `PUT` | `/groups/{groupId}` | `{groupName, description}` | |
| `DELETE` | `/groups/{groupId}` | — | |

**`POST /users` dispatches on the body shape** (`lambda/user-group-manager/index.js:58`):

| Body | Action |
|---|---|
| `{userIds: [...], groupIds: [...]}` | Assign users to groups |
| `{action: "removeFromGroups", userId, groupIds}` | Remove a user from groups |
| `{firstName, lastName, email, department, isAdmin, temporaryPassword}` | Create a user |

The remove action is also accepted as query parameters (`?action=removeFromGroups&userId=…`).
User creation returns `403` when the deployment runs in Cognito auth mode — create the user in
the identity provider instead.

### Images and pipelines

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/images` | — | Registered AMIs |
| `POST` | `/images` | `{amiId, name, description, platform, region}` | `amiId` must match `^ami-[a-f0-9]{8,17}$` |
| `PUT` | `/images/{id}` | partial | |
| `DELETE` | `/images/{id}` | — | |
| `POST` | `/images/copy` | `{sourceAmiId, sourceRegion, targetRegions, name, platform, description, pipelineId}` | `400` if `sourceAmiId` or `targetRegions` missing/empty |
| `POST` | `/images/create-pipeline` | `{name, description, baseImageId, platform, instanceType, components}` | EC2 Image Builder pipeline |
| `GET` | `/images/pipelines` | — | |
| `PUT` | `/images/pipelines/{pipelineId}` | partial | |
| `DELETE` | `/images/pipelines/{pipelineId}` | — | |
| `POST` | `/images/pipelines/{pipelineId}/execute` | — | Kick off a build |
| `GET` | `/images/pipelines/{pipelineId}/status` | — | |

### Software library

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/images/software` | — | → `{items: [...]}` |
| `POST` | `/images/software` | software object | |
| `GET` | `/images/software/{softwareId}` | — | `404` if unknown |
| `PUT` | `/images/software/{softwareId}` | partial | |
| `DELETE` | `/images/software/{softwareId}` | — | |
| `POST` | `/images/software/upload-url` | `{softwareId, fileName, contentType?}` | → `{uploadUrl, s3Uri, s3Key}` |

`upload-url` returns a presigned S3 `PUT` valid for **1 hour**; `contentType` defaults to
`application/octet-stream`. Upload the installer to `uploadUrl` with a matching `Content-Type`,
then reference the returned `s3Uri` as the software item's `mediaS3Uri`.

### AI script generation

Only present when the stack is deployed with `EnableBedrockFeatures=true`
(`lib/api-stack.ts:1383-1421`). Backed by a Bedrock AgentCore runtime that researches, writes and
test-runs silent install scripts.

| Method | Path | Body |
|---|---|---|
| `POST` | `/images/software/{softwareId}/generate-script` | `GenerateScriptOptions` |
| `GET` | `/images/software/{softwareId}/generation-progress?executionId=…` | — (SSE) |
| `POST` | `/images/software/{softwareId}/cancel-generation` | `{executionId}` |
| `POST` | `/images/software/generate-script-draft` | `GenerateScriptOptions` |
| `GET` | `/images/software/generation-progress-draft?executionId=…` | — (SSE) |
| `POST` | `/images/software/cancel-generation` | `{executionId}` |
| `POST` | `/images/software/chat` | `{message, conversationHistory?, softwareName?, platform?, mediaS3Uri?}` |

The `-draft` variants do the same thing for software that has not been saved to the library yet.

```ts
// GenerateScriptOptions — frontend/src/utils/installScriptApi.ts:13
{ softwareName: string; version?: string; platform: 'Windows' | 'Linux';
  mediaS3Uri?: string; licenseKey?: string;
  testAutomatically?: boolean; maxAttempts?: number; timeoutMinutes?: number }
```

`202` → `{executionId, sessionId, status, progressUrl}`. Then poll `progressUrl`, which streams
`text/event-stream`:

```ts
// ProgressEvent  { eventId?, phase, message, percent, timestamp }
// CompletionEvent{ status: 'completed'|'failed'|'cancelled', script?, componentArn?, error?, attempts, logs? }
```

The progress endpoints return `400` without an `executionId` query parameter. `503` means the
agent is disabled; `429` carries `{limitType, currentUsage, limit}`.

### Storage

FSx for NetApp ONTAP, FSx for Windows File Server, and Mountpoint-for-S3 volumes.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/storage` | — | |
| `POST` | `/storage` | see below | `201` on success |
| `GET` | `/storage/{storageId}` | — | |
| `PUT` | `/storage/{storageId}` | partial | |
| `DELETE` | `/storage/{storageId}` | — | |
| `POST` | `/storage/mount` | `{action, instanceId, storageId}` | Mountpoint-S3 |
| `POST` | `/storage/nfs-mount` | `{action, instanceId, storageId}` | FSx ONTAP NFS |
| `GET` | `/storage/s3-buckets` | — | Buckets eligible for Mountpoint-S3 |
| `GET` | `/storage/config` | — | → `{workstationRoleArn, accountId}` for cross-account bucket policies |

```json
{
  "name": "project-media",
  "type": "fsx-ontap",
  "description": "…",
  "region": "us-east-1",
  "configuration": { }
}
```

`type` is one of `fsx-windows` (the default), `fsx-ontap`, `mountpoint-s3`; `configuration` is
type-specific. `name` and `configuration` are required — otherwise
`400 {"success": false, "error": "Name and configuration are required"}`. Provisioning runs as a
nested CloudFormation stack driven by Step Functions, so a `201` means *accepted*: poll
`GET /storage/{storageId}` until `status` settles.

The mount routes take `action` of `mount` or `unmount`.

### DataSync

Present only when the DataSync stack is deployed (`lib/api-stack.ts:1449-1494`). Full TypeScript
types live in [`frontend/src/utils/datasyncApi.ts`](../frontend/src/utils/datasyncApi.ts).

| Method | Path | Body |
|---|---|---|
| `GET` | `/datasync/locations` | — |
| `POST` | `/datasync/locations` | `CreateLocationRequest` |
| `DELETE` | `/datasync/locations/{locationId}` | — |
| `GET` | `/datasync/tasks` | — |
| `POST` | `/datasync/tasks` | `CreateTaskRequest` |
| `PUT` | `/datasync/tasks/{taskId}` | `UpdateTaskRequest` |
| `DELETE` | `/datasync/tasks/{taskId}` | — |
| `POST` | `/datasync/tasks/{taskId}/execute` | — |
| `GET` | `/datasync/tasks/{taskId}/executions` | — |
| `GET` | `/datasync/s3-buckets` | — |
| `GET` | `/datasync/config` | — |

```ts
CreateLocationRequest = {
  name: string; type: 'S3' | 'FSX_ONTAP' | 'FSX_WINDOWS';
  s3Config?:  { bucketArn: string; subdirectory?: string; isCrossAccount: boolean };
  fsxConfig?: { storageId: string; subdirectory?: string };
}

CreateTaskRequest = {
  name: string; sourceLocationId: string; destinationLocationId: string;
  options?: Partial<TaskOptions>;
}

TaskOptions = {
  transferMode: 'CHANGED' | 'ALL';
  verifyMode: 'ONLY_FILES_TRANSFERRED' | 'POINT_IN_TIME_CONSISTENT' | 'NONE';
  overwriteMode: 'ALWAYS' | 'NEVER';
  preserveDeletedFiles: 'PRESERVE' | 'REMOVE';
  bytesPerSecond?: number;
  logLevel: 'OFF' | 'BASIC' | 'TRANSFER';
}
```

Execution status progresses `QUEUED → LAUNCHING → PREPARING → TRANSFERRING → VERIFYING → SUCCESS | ERROR`.

### Regional hubs

Satellite DCV deployments in other regions, created at runtime as CloudFormation stacks.

| Method | Path | Body |
|---|---|---|
| `GET` | `/regions` | — |
| `POST` | `/regions` | see below |
| `GET` | `/regions/{region}` | — |
| `PUT` | `/regions/{region}` | partial |
| `DELETE` | `/regions/{region}` | — |
| `GET` | `/regions/{region}/availability-zones` | — |

```json
{
  "region": "eu-central-1",
  "displayName": "Frankfurt",
  "vpcCidr": "10.101.0.0/16",
  "availabilityZones": ["eu-central-1a", "eu-central-1b"],
  "publicSubnetMask": 28,
  "privateSubnetMask": 24,
  "dcvDomainName": "…",
  "dcvCertificateArn": "…",
  "enableWindows": true,
  "enableLinux": true,
  "enableMacOS": false
}
```

`region`, `displayName` and `vpcCidr` are required, `availabilityZones` needs **at least two**,
and `vpcCidr` must match `^(\d{1,3}\.){3}\d{1,3}/\d{1,2}$` — each failure returns its own `400`.

### DCV

One RPC-style endpoint rather than REST resources
([`lambda/dcv-session-manager/index.py:180`](../lambda/dcv-session-manager/index.py)).

```
POST /dcv   { "action": "<action>", ... }
```

| `action` | Extra fields | Returns |
|---|---|---|
| `describe-servers` | `serverId?` | `{servers: [...]}` |
| `describe-sessions` | `serverId?`, `dcvSessionId?` | `{Sessions: [...]}` |
| `create-session` | `serverId`, `sessionName`, `sessionType?`, `owner` | Session details |
| `delete-session` | `sessionId` | |
| `get-connection-data` | `serverId` | Connection gateway URL and token |
| `get-load-balancers` | — | |
| `get-autoscaling-groups` | — | |
| `get-workstation-assignments` | — | |
| `get-instance-states` | — | |

`sessionType` defaults to `console`. When `serverId` names a workstation in another region, the
request is transparently forwarded to that region's DCV Lambda — the broker is only reachable
from inside its own VPC. A failure there returns `500` with `errorType: "RegionalRoutingError"`.

Note the capitalisation: `describe-sessions` returns `Sessions` (upper-case) while
`describe-servers` returns `servers`. The frontend wrapper
([`dcvApi.ts`](../frontend/src/utils/dcvApi.ts)) normalises both.

### Progress

```
GET /progress?instanceId=i-0abc123
```

Workstation start-up progress events. `400` without `instanceId`. Returns only events from the
most recent run — the handler finds the latest `starting-instance` event and discards anything
older.

```json
{
  "instanceId": "i-0abc123",
  "events": [
    { "timestamp": "…", "stage": "starting-instance", "status": "…", "message": "…", "progress": 10 }
  ],
  "lastUpdated": "2026-08-29T12:00:00.000Z"
}
```

---

## CORS

**Irrelevant to curl and server-side callers** — CORS is enforced by browsers, not the API.

For browser clients it matters, and it is applied in two phases:

1. At deploy time the API allows all origins (`lib/api-stack.ts:1052`), with
   `allowHeaders: ['Content-Type', 'Authorization']`. `allowCredentials` is deliberately not set
   — auth is a bearer header, not a cookie, and browsers reject `*` combined with credentials.
   `DEFAULT_4XX` / `DEFAULT_5XX` gateway responses also carry `Access-Control-Allow-Origin: *`
   so that authorizer 401s surface as real errors instead of opaque CORS failures.
2. After the frontend URL is known, [`lambda/cors-updater/index.py`](../lambda/cors-updater/index.py)
   rewrites every `OPTIONS` integration response to the exact frontend origin and redeploys the
   `prod` stage. It is triggered by an EventBridge rule on changes to the
   `/${PASCAL_CASE_NAME}/Frontend/Url` SSM parameter, and by `deploy.sh`.

So a browser app served from any origin other than the configured frontend URL will be blocked
once step 2 has run. Individual Lambdas still emit a permissive
`Access-Control-Allow-Origin: *` on their own non-`OPTIONS` responses.

Because of this ordering, the API stack must be deployed **again** after the frontend stack on a
first deploy — see the note at `lib/api-stack.ts:5-9`.

---

## Known quirks

**`GET /auth/validate` cannot be used.** It reads the token from an `auth-token` **cookie**
(`lambda/validate-jwt/index.js:65`), but every client in this repo stores the token in
`sessionStorage` and sends it as an `Authorization` header. Nothing sets that cookie, so the
route returns `401 {"error":"No auth token"}` unconditionally. To check a token, call any cheap
protected route — `GET /instance-types/catalog` — and look at the status.

**Two Lambdas share the `/workstations` namespace.** `/workstations/start` and `/stop` are on
`mrm-workstation-manager`; `/workstations/keep-alive` and everything under `/settings` are on
`mrm-workstation-api`. Both implement overlapping routers, so tracing a request in CloudWatch
means knowing which function actually received it.

**`POST /users` is polymorphic.** Three unrelated operations dispatch off the body shape. A body
missing both `userIds`/`groupIds` and the `removeFromGroups` action is treated as a user
creation attempt.

**Async routes return before the work is done.** `202` from the volume endpoints and script
generation, and `201` from storage creation, all mean *accepted*. Poll the corresponding `GET`.

**No API-level throttling or WAF.** The WAF WebACL in this repo is scoped to CloudFront, not to
API Gateway. There are no usage plans or API keys.

---

## Keeping this accurate

The live route list is the source of truth:

```bash
. scripts/mrm-env.sh
aws apigateway get-resources --rest-api-id "$MRM_API_ID" --limit 500 \
  --query 'items[].[path,resourceMethods]' --output json
```

An OpenAPI 3 skeleton can be exported straight from the deployed API:

```bash
aws apigateway get-export --rest-api-id "$MRM_API_ID" --stage-name prod \
  --export-type oas30 --accepts application/json openapi/mrm.json
```

Because every route is a Lambda proxy integration with no API Gateway models, that export
carries paths and security schemes but **no request or response schemas** — those are maintained
by hand in [`openapi/mrm.json`](../openapi/mrm.json). Re-exporting overwrites them, so a refresh
means re-merging.
