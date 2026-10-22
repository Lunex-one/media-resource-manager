// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Active Directory reports why it rejected a bind as "data <hex>" in the diagnostic message, for
 * example "80090308: LdapErr: DSID-0C090439, comment: AcceptSecurityContext error, data 532, v4563".
 * The LDAP result code is 49 (invalid credentials) for all of them, so the sub-code is the only way
 * to tell a wrong password from an expired one.
 *
 * Only reasons AD reports after it has verified the password are exposed to the caller. A wrong
 * password (52e), an unknown user (525) and a lockout (775) stay indistinguishable from each other,
 * so a failed sign-in still reveals nothing about whether an account exists.
 */
const REASON_BY_CODE = {
  '532': 'PASSWORD_EXPIRED',
  '773': 'PASSWORD_MUST_CHANGE',
  '533': 'ACCOUNT_DISABLED',
  '701': 'ACCOUNT_EXPIRED',
};

const REASON_MESSAGES = {
  PASSWORD_EXPIRED: 'Your password has expired. Contact an administrator to reset it.',
  PASSWORD_MUST_CHANGE: 'Your password must be changed before you can sign in. Contact an administrator.',
  ACCOUNT_DISABLED: 'This account is disabled. Contact an administrator.',
  ACCOUNT_EXPIRED: 'This account has expired. Contact an administrator.',
};

/** The AD sub-code of a failed bind as lowercase hex ("532"), or null when the error carries none. */
function adBindCode(err) {
  const text = [err && err.lde_message, err && err.message].filter(Boolean).join(' ');
  const match = /data\s+([0-9a-f]{3})\b/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

/** The reason to show the user for a sub-code, or undefined for anything that must stay generic. */
function adBindReason(code) {
  return code ? REASON_BY_CODE[code] : undefined;
}

module.exports = { adBindCode, adBindReason, REASON_MESSAGES };
