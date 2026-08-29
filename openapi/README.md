# OpenAPI spec for the MRM API

[`mrm.json`](mrm.json) is an OpenAPI 3.0 description of the Media Resource Manager
REST API. Import it into Postman, Insomnia, Swagger UI, or a client generator.

The human-readable reference — with the parts a spec cannot capture, like the
polymorphic `POST /users` body and the auth token flows — is
[`../docs/API.md`](../docs/API.md).

## How it is built

Every MRM route is a Lambda proxy integration with no API Gateway model, so an
export from the deployed API carries the paths, methods and security scheme but
**no request/response schemas**. So the committed spec is a merge of two parts:

| File | Tracked? | What it is |
|---|---|---|
| `generated/oas30.json` | no (gitignored) | Raw export from the deployed API. Contains the live endpoint, so it is never committed. |
| `overlay.json` | yes | Hand-written schemas, summaries, tags and per-operation request/response detail. |
| `mrm.json` | yes | The merge of the two, with no endpoint. This is the artifact to consume. |

`build.py` performs the merge. It strips the CORS `OPTIONS` operations, parameterises
the server URL so no real hostname is committed, attaches the overlay schemas, and
adds the shared `401`/`500` responses to every authenticated route. It refuses to
write a spec that names a live endpoint.

## Regenerating

```bash
# Re-export from the deployed API (needs AWS credentials), then merge:
python3 openapi/build.py

# Merge using the cached export, without touching AWS:
python3 openapi/build.py --no-fetch
```

The endpoint is resolved by [`../scripts/mrm-env.sh`](../scripts/mrm-env.sh).

**To add or correct a schema, edit `overlay.json`, not `mrm.json`.** Re-running the
export overwrites `mrm.json`, so hand edits there are lost; the overlay survives.
`build.py` warns if the overlay lists an operation that no longer exists on the
live API.

## Validating

```bash
npx @redocly/cli lint openapi/mrm.json
```
