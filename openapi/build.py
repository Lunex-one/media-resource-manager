#!/usr/bin/env python3
"""Build openapi/mrm.json from the deployed API plus a hand-written overlay.

API Gateway can export an OpenAPI 3 document for the deployed API, but because
every route is a Lambda proxy integration with no API Gateway models, that
export carries only paths, methods and the security scheme -- no request or
response schemas, no summaries, no tags.

Rather than hand-editing the export (and losing those edits on the next
refresh), this script merges two inputs:

    openapi/generated/oas30.json   the raw export, regenerated at will
    openapi/overlay.json           hand-written schemas and metadata

and writes openapi/mrm.json.

Usage:
    python3 openapi/build.py            # re-export from AWS, then merge
    python3 openapi/build.py --no-fetch # merge using the cached export

The deployment's real hostname is deliberately not written to the output; the
server URL is parameterised so the committed spec contains no endpoint.
"""

import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GENERATED = os.path.join(ROOT, "openapi", "generated", "oas30.json")
OVERLAY = os.path.join(ROOT, "openapi", "overlay.json")
OUTPUT = os.path.join(ROOT, "openapi", "mrm.json")

SECURITY_SCHEME = "bearerAuth"

# Path prefix -> tag. First match wins, so order matters.
TAG_RULES = [
    ("/auth", "Auth"),
    ("/change-password", "Auth"),
    ("/workstations", "Workstations"),
    ("/settings", "Settings"),
    ("/instance-types", "Settings"),
    ("/domains", "Settings"),
    ("/users", "Users and groups"),
    ("/groups", "Users and groups"),
    ("/images/software", "Software library"),
    ("/images", "Images and pipelines"),
    ("/storage", "Storage"),
    ("/datasync", "DataSync"),
    ("/regions", "Regional hubs"),
    ("/dcv", "DCV"),
    ("/progress", "Progress"),
]


def fetch_export():
    """Re-export the OAS30 document from the deployed API."""
    os.makedirs(os.path.dirname(GENERATED), exist_ok=True)
    script = (
        f'set -e; . "{ROOT}/scripts/mrm-env.sh"; '
        'if [ -z "$MRM_API_ID" ]; then '
        '  echo "Could not resolve MRM_API_ID (see scripts/mrm-env.sh)" >&2; exit 1; '
        'fi; '
        'aws apigateway get-export --rest-api-id "$MRM_API_ID" --stage-name prod '
        f'  --export-type oas30 --accepts application/json "{GENERATED}" >/dev/null'
    )
    subprocess.run(["bash", "-c", script], check=True)


def tag_for(path):
    for prefix, tag in TAG_RULES:
        if path == prefix or path.startswith(prefix + "/"):
            return tag
    return "Other"


def operation_id(method, path):
    """POST /workstations/volumes/add -> postWorkstationsVolumesAdd"""
    parts = []
    for seg in path.strip("/").split("/"):
        if not seg:
            continue
        if seg.startswith("{"):
            name = seg.strip("{}")
            parts.append("By" + name[0].upper() + name[1:])
        else:
            for word in re.split(r"[-_]", seg):
                if word:
                    parts.append(word[0].upper() + word[1:])
    return method.lower() + "".join(parts)


def path_parameters(path):
    params = []
    for name in re.findall(r"\{([^}]+)\}", path):
        params.append(
            {
                "name": name,
                "in": "path",
                "required": True,
                "schema": {"type": "string"},
            }
        )
    return params


def build(fetch=True):
    if fetch:
        fetch_export()
    if not os.path.exists(GENERATED):
        sys.exit(f"No export at {GENERATED}. Run without --no-fetch first.")

    spec = json.load(open(GENERATED))
    overlay = json.load(open(OVERLAY))

    spec["info"] = overlay["info"]
    spec["servers"] = overlay["servers"]
    spec["tags"] = overlay["tags"]
    spec.pop("x-amazon-apigateway-security-policy", None)

    components = spec.setdefault("components", {})
    components["securitySchemes"] = overlay["securitySchemes"]
    components["schemas"] = overlay.get("schemas", {})
    components["responses"] = overlay.get("responses", {})

    ops = overlay.get("operations", {})
    documented = set()

    for path, item in spec["paths"].items():
        # CORS preflight is an API Gateway implementation detail, not part of
        # the contract a client codes against.
        item.pop("options", None)

        shared = path_parameters(path)
        if shared:
            item["parameters"] = shared

        for method, op in item.items():
            if method == "parameters":
                continue
            key = f"{method.upper()} {path}"
            extra = ops.get(key, {})
            if extra:
                documented.add(key)

            op["operationId"] = extra.get("operationId", operation_id(method, path))
            op["tags"] = extra.get("tags", [tag_for(path)])
            if "summary" in extra:
                op["summary"] = extra["summary"]
            if "description" in extra:
                op["description"] = extra["description"]
            if "parameters" in extra:
                op["parameters"] = extra["parameters"]
            if "requestBody" in extra:
                op["requestBody"] = extra["requestBody"]

            responses = dict(extra.get("responses", {}))
            # Every authorized route can fail these ways.
            if op.get("security"):
                op["security"] = [{SECURITY_SCHEME: []}]
                responses.setdefault("401", {"$ref": "#/components/responses/Unauthorized"})
            else:
                # An explicit empty list is how OpenAPI says "this route is public";
                # omitting the key entirely just means "unspecified".
                op["security"] = []
            responses.setdefault("500", {"$ref": "#/components/responses/ServerError"})
            if not any(c.startswith("2") for c in responses):
                responses["200"] = {"description": "Success"}
            op["responses"] = responses

    unused = sorted(set(ops) - documented)
    if unused:
        print("WARNING: overlay entries that match no live route:", file=sys.stderr)
        for key in unused:
            print(f"  {key}", file=sys.stderr)

    # The committed spec must not name a real deployment. Check before writing,
    # so a leak never reaches disk.
    blob = json.dumps(spec)
    leaks = set(re.findall(r"[a-z0-9]{8,}\.execute-api\.[a-z0-9-]+\.amazonaws\.com", blob))
    leaks |= set(re.findall(r"[a-z0-9]{10,}\.cloudfront\.net", blob))
    if leaks:
        sys.exit("Refusing to write a spec naming a live endpoint: "
                 + ", ".join(sorted(leaks)))

    with open(OUTPUT, "w") as fh:
        json.dump(spec, fh, indent=2, sort_keys=False)
        fh.write("\n")

    total = sum(
        1 for item in spec["paths"].values() for m in item if m != "parameters"
    )
    print(f"Wrote {OUTPUT}: {len(spec['paths'])} paths, {total} operations, "
          f"{len(documented)} with hand-written detail.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true",
                    help="merge the cached export instead of re-exporting")
    args = ap.parse_args()
    build(fetch=not args.no_fetch)
