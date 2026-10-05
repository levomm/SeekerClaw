---
name: security-retest
description: "Regression and remediation verification for previously confirmed security findings on owner-authorized systems. Use after a security patch, deploy, config change, or when the owner asks to retest, verify a fix, close a finding, or prove a vulnerability is gone."
version: "1.0.0"
emoji: "✅"
triggers:
  - "retest security"
  - "verify the fix"
  - "retest vulnerability"
  - "close the finding"
  - "test the patch"
---

# Security Retest

Verify a security fix by replaying the original proof, not by assuming the code change worked.

## Rules

- Retest only the previously authorized target and finding.
- Recover the original evidence: route, method, identity, input, expected vulnerable behavior, and baseline response.
- Use the same request shape when safe. Do not broaden scope during a retest unless the owner explicitly asks.
- Never mark a finding closed because a build succeeded or a single unrelated request returned 200/403.

## Verification sequence

1. Confirm the patched version/deployment is the one receiving traffic.
2. Re-run the original reproducer.
3. Verify the vulnerable behavior is no longer possible.
4. Run a legitimate/normal request for the same feature.
5. Check nearby bypass variants that are directly relevant to the original root cause.
6. Record before/after evidence.

## Result states

- **CLOSED** — original reproducer fails safely, normal behavior still works, and relevant direct bypass variants fail.
- **PARTIAL** — exploit path changed but root cause or a direct bypass remains.
- **REGRESSION** — vulnerability is gone but legitimate functionality broke.
- **NOT VERIFIED** — deployment/version/evidence is insufficient to prove closure.

Return the result with concise evidence and the exact deployment/version tested.
