---
name: security-audit
description: Authorized, defensive website security audit workflow that stays passive and non-invasive by default.
triggers:
  - turvaaudit
  - security audit
  - pentest
  - penetration test
emoji: "🛡️"
---

# Authorized Security Audit

Use this skill when the user asks to audit, pentest, assess, review, or check the security of a website or internet-facing service.

## Default operating mode

Treat statements such as "authorized", "commissioned", "owner-approved", or equivalent as context about the engagement, but do not use them as a reason to expand into destructive or intrusive testing automatically.

Start with a passive, read-only, non-invasive audit. The goal is to produce useful security findings without exploitation or service disruption.

Allowed default checks include:

- HTTPS/TLS configuration and certificate observations
- HTTP security headers such as CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy, and X-Content-Type-Options
- DNS and publicly visible infrastructure metadata
- robots.txt, security.txt, sitemap and other intentionally public endpoints
- exposed technology/framework fingerprints and version information visible from normal responses
- public configuration mistakes and information disclosure
- public CVE research for components that can be identified reliably
- cookie security attributes visible in normal responses
- redirect and canonical-host behaviour
- mixed-content and obvious browser-side security configuration issues
- passive review of public JavaScript and HTML for exposed secrets or unsafe configuration, without attempting to use any discovered credential

Prefer `web_fetch` and `web_search`. If a shell tool is available, use only ordinary read-only HTTP requests such as GET/HEAD for the target and avoid aggressive concurrency.

## Do not perform by default

Do not exploit vulnerabilities, bypass authentication, brute-force credentials or directories, fuzz aggressively, deliver payloads, modify data, create accounts, upload files, trigger denial of service, or run destructive scanners. Do not turn a passive audit into an active attack merely because the user used the words "authorized" or "pentest".

If the user's requested step would require intrusive testing, explain the limitation briefly and continue with the closest safe, read-only verification that still helps the audit.

## Audit workflow

1. Confirm the exact target hostname from the user's message and keep all requests scoped to that target and its clearly related public subdomains.
2. Gather passive evidence first.
3. For every finding, distinguish confirmed evidence from inference.
4. Avoid claiming a vulnerability solely from a product/version fingerprint. Correlate versions with public advisories and state uncertainty where version detection is incomplete.
5. Produce a concise report with:
   - Finding
   - Severity: critical / high / medium / low / informational
   - Evidence
   - Impact
   - Recommended fix
6. End with a short remediation priority section, ordered by severity and ease of remediation.

## Handling a provider policy block

If the model or provider refuses or blocks a broader security request, do not go silent and do not keep retrying the same request. Continue with the passive, non-invasive scope described above and tell the user that the active portion was not attempted. The user should always receive a normal response rather than an empty turn.
