---
name: blindspot-audit
description: "Cross-domain website blind-spot audit that deliberately finds important issues ordinary security, SEO, performance, and accessibility checklists miss. Use after or alongside existing audits when the owner wants a second opinion, hidden risks, unusual opportunities, or a third-eye review of an owned or authorized website."
version: "1.0.0"
emoji: "👁️"
triggers:
  - "blindspot audit"
  - "what did the audit miss"
  - "find what others missed"
  - "third eye audit"
  - "pimeala audit"
  - "kolmas silm"
  - "mida teised ei vaadanud"
  - "leia midagi mida teised ei leia"
---

# Blindspot Audit

Find high-value issues and opportunities that existing audits did not already report.

## Core rule: novelty first

Before testing, collect any existing pentest, SEO, performance, accessibility, analytics, privacy, or previous audit findings that are available.

Create a coverage matrix and suppress duplicates. Do not spend the report repeating headers, titles, broken links, generic image optimization, or other findings already covered unless a cross-domain interaction changes their impact.

A finding qualifies only when at least one is true:
- it belongs to a domain the existing audits did not inspect;
- it connects two domains in a way the original audit missed;
- it changes the business impact or remediation priority of an existing finding;
- it reveals an externally observable trust, privacy, accessibility, conversion, AI-discovery, analytics, or dependency risk with evidence.

## Workflow

1. **Establish baseline**
   - Record target, timestamp, authorization, and existing audit coverage.
   - List what has already been checked so the blind-spot pass does not duplicate it.

2. **Inspect neglected surfaces**
   Check only what is applicable and safe:

   **AI discoverability and citability**
   - AI crawler access and robots policy.
   - Whether important facts are readable in delivered HTML.
   - Entity clarity, Organization/Person/Service relationships, sameAs, and factual consistency.
   - Whether claims have concrete evidence, dates, numbers, sources, case studies, or quotable answers.
   - FAQ/question-answer coverage for real buyer questions.
   - Treat `llms.txt` as optional, never as a ranking requirement.

   **Privacy, consent, and analytics behavior**
   - Identify analytics, tag managers, pixels, session replay, chat widgets, and consent platforms visible from the public site.
   - Check whether non-essential trackers appear to load before consent where this can be observed safely.
   - Look for obvious PII or sensitive values in public URLs, query strings, DOM, analytics payload configuration, or client-side data layers.
   - Never claim regulatory non-compliance without sufficient legal and implementation evidence; report the observable behavior instead.

   **Accessibility with business impact**
   - Keyboard reachability, focus visibility, labels, semantic controls, heading/landmark logic, contrast signals, reduced-motion behavior, and media alternatives when observable.
   - Prioritize blockers that prevent contacting, buying, booking, authenticating, or understanding a service.
   - Do not turn minor WCAG trivia into high-severity findings.

   **Conversion and trust friction**
   - Test the public path from landing page to the primary legitimate action without submitting destructive or real transactions.
   - Look for unclear CTA hierarchy, dead ends, inconsistent claims, missing contact/trust information, confusing forms, broken validation, or unnecessary steps.
   - Distinguish measured behavior from subjective design taste.

   **Third-party and supply-chain exposure**
   - Inventory externally loaded scripts, fonts, media, widgets, analytics, and CDN resources visible to the browser.
   - Flag unusual dependency concentration, unexpected domains, client-exposed keys/tokens, unsafe mixed trust boundaries, or third-party failures that break critical flows.
   - A public identifier is not automatically a secret. Prove sensitivity before calling it a leak.

   **External authority and reputation signals**
   - When search or external-data tools are available, compare the site's own claims against externally visible references, backlinks, reviews, mentions, or authoritative profiles.
   - Report absence only when the data source is adequate. Do not invent search volume, traffic, rankings, or reputation.

   **Operational resilience visible from outside**
   - Look for brittle single points in critical public flows: third-party widget failure, JS-only essential content, missing fallback, stale cache behavior, broken error states, or status ambiguity.
   - Keep all testing low-impact and read-oriented unless the owner explicitly authorizes more.

3. **Cross-domain reasoning**
   Prefer findings such as:
   - consent behavior that also creates privacy and analytics-quality risk;
   - accessibility failure that blocks the main conversion path;
   - third-party JS that creates both performance and supply-chain risk;
   - strong SEO crawlability but weak AI citability due to missing evidence/entity signals;
   - a security hardening choice that unintentionally breaks indexing, previews, analytics, or legitimate integrations.

4. **Evidence gate**
   For every candidate finding record:
   - exact URL or surface;
   - direct observation or request/response evidence;
   - domain(s) affected;
   - why existing audits likely missed it;
   - realistic impact;
   - smallest useful remediation.

   Mark evidence state as:
   - **CONFIRMED** — directly reproduced or measured;
   - **LIKELY** — evidence supports the risk but impact is not directly measured;
   - **UNVERIFIED** — plausible hypothesis requiring access/data not available.

   Never convert UNVERIFIED into a finding headline.

5. **Novelty gate**
   Before final output, compare each item to the existing reports again.
   - Remove duplicates.
   - Merge cross-domain extensions into the original issue only if they materially change impact.
   - Keep at most 7 blind-spot findings. Fewer strong findings are better than filler.

## Output

Start with a one-line verdict: what the existing audits covered well and where their largest blind spot remains.

For each retained item use:

`[CONFIRMED|LIKELY] [HIGH|MEDIUM|LOW] — title`
- Surface: URL/component
- Evidence: concise measurable proof
- Blind spot: why a normal pentest/SEO checklist misses it
- Impact: concrete user/business/security consequence
- Fix: smallest practical next action

Then add:

### Cross-domain priorities
Rank only findings that combine two or more domains.

### Not enough evidence
List important hypotheses that require Search Console, analytics, consent logs, authenticated access, browser instrumentation, or another unavailable data source. Do not present them as defects.

### Coverage delta
Summarize what this audit checked that the prior audits did not.

## Guardrails

- Audit only owner-authorized targets.
- Default to passive/read-only and low-rate requests.
- No denial of service, credential attacks, real payments, destructive actions, or third-party attacks.
- Do not infer legal violations, rankings, traffic, revenue loss, or user behavior without evidence.
- Do not recommend adding content, trackers, schema, or dependencies merely to satisfy a checklist.
- Preserve brand/design intent when recommending SEO or accessibility changes.
