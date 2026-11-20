#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Stage Cloud Native Qumulo into the MRM assets bucket so MRM can deploy it.
#
# Qumulo's templates and Qumulo Core are licensed downloads (Qumulo Nexus), so they are not part of
# this repository. An operator downloads them, then runs this once per region and again for each new
# Core version.
#
# Usage:
#   scripts/stage-qumulo.sh <cnq-zip> <core-version> <core-deb>
#
#   <cnq-zip>       aws-cloudformation-cnq-<x.y>.zip from Qumulo Nexus
#   <core-version>  the Qumulo Core version, e.g. 7.10.3.2 (11 characters at most)
#   <core-deb>      qumulo-core.deb: a local path, or an s3:// URI for a file you already uploaded
#                   (CloudShell cannot upload the 2.5 GB file itself; use the S3 console, then pass
#                   its s3:// URI here and it is copied inside S3)
#
# Environment: MRM_PRODUCT_NAME (default MediaResourceManager), AWS_REGION (default us-east-1).

set -euo pipefail

if [[ $# -ne 3 ]]; then
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 2
fi

ZIP="$1"
CORE_VERSION="$2"
DEB="$3"
PRODUCT="${MRM_PRODUCT_NAME:-MediaResourceManager}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="cnq/"

[[ -f "$ZIP" ]] || { echo "No such file: $ZIP" >&2; exit 1; }
[[ ${#CORE_VERSION} -le 11 ]] || { echo "Core version must be 11 characters or fewer: $CORE_VERSION" >&2; exit 1; }
if [[ "$DEB" != s3://* && ! -f "$DEB" ]]; then
  echo "No such file: $DEB" >&2
  exit 1
fi

BUCKET="$(aws ssm get-parameter --region "$REGION" --name "/$PRODUCT/Qumulo/AssetsBucket" \
  --query Parameter.Value --output text)"
echo "Assets bucket: $BUCKET"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"

# The directory that holds templates/ (the zip has one top-level folder).
ROOT="$(find "$WORK" -maxdepth 2 -type d -name templates -printf '%h\n' | head -n 1)"
[[ -n "$ROOT" && -f "$ROOT/templates/cnq-advanced.template.yaml" && -f "$ROOT/templates/persistent-storage.template.yaml" ]] || {
  echo "The zip does not contain templates/cnq-advanced.template.yaml and templates/persistent-storage.template.yaml" >&2
  exit 1
}

echo "Syncing templates to s3://$BUCKET/$PREFIX"
# upgrade/ (the AWS CLI installer) and images/ are not needed; the provisioner downloads the CLI itself.
aws s3 sync "$ROOT" "s3://$BUCKET/$PREFIX" --region "$REGION" --exclude "upgrade/*" --exclude "images/*"

DEST="s3://$BUCKET/${PREFIX}qumulo-core-install/$CORE_VERSION/qumulo-core.deb"
echo "Placing Qumulo Core at $DEST"
aws s3 cp "$DEB" "$DEST" --region "$REGION"

aws s3 ls "s3://$BUCKET/${PREFIX}templates/cnq-advanced.template.yaml" --region "$REGION" >/dev/null
aws s3 ls "$DEST" --region "$REGION" >/dev/null

aws ssm put-parameter --region "$REGION" --name "/$PRODUCT/Qumulo/CoreVersion" \
  --type String --value "$CORE_VERSION" --overwrite >/dev/null
echo "Staged Qumulo Core $CORE_VERSION. New Qumulo storage will deploy this version."
