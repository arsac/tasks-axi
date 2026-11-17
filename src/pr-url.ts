/**
 * Canonical pull request and issue URL classification - the single seam shared
 * by prose link derivation (deriveLinks), typed-link validation (`--pr`,
 * `--issue`, backend normalization), and public-followup `pr_url` deliverables.
 *
 * Exactly two byte-for-byte shapes are PR URLs:
 *   - GitHub:  https://github.com/<owner>/<repo>/pull/<n>
 *   - Forgejo: https://<lowercase-dns-host>/<owner>/<repo>/pulls/<n>
 * and one is an issue URL, on GitHub and Forgejo alike:
 *   - https://<lowercase-dns-host>/<owner>/<repo>/issues/<n>
 * with <n> a positive number without leading zeros. Anything else - singular/
 * plural route confusion, trailing slash, query/fragment, whitespace, userinfo,
 * ports, encoded separators - is neither.
 */

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const SEGMENT = "[A-Za-z0-9._-]+";
const REPO_URL = `^https://(${HOST_LABEL}(?:\\.${HOST_LABEL})*)/(${SEGMENT})/(${SEGMENT})`;
const PR_URL_RE = new RegExp(`${REPO_URL}/(pull|pulls)/([1-9][0-9]*)$`);
const ISSUE_URL_RE = new RegExp(`${REPO_URL}/issues/[1-9][0-9]*$`);

export const PR_URL_EXPECTED =
  "a canonical pull request URL: https://github.com/<owner>/<repo>/pull/<n> (GitHub) or https://<host>/<owner>/<repo>/pulls/<n> (Forgejo)";

export const ISSUE_URL_EXPECTED =
  "a canonical issue URL: https://<host>/<owner>/<repo>/issues/<n> (GitHub or Forgejo)";

function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/** True when url is byte-for-byte a canonical GitHub or Forgejo PR URL. */
export function isPrUrl(url: string): boolean {
  const m = PR_URL_RE.exec(url);
  if (m === null) return false;
  const [, host, owner, repo, route] = m;
  if (isDotSegment(owner) || isDotSegment(repo)) return false;
  return route === "pull" ? host === "github.com" : host !== "github.com";
}

/** True when url is byte-for-byte a canonical GitHub or Forgejo issue URL. */
export function isIssueUrl(url: string): boolean {
  const m = ISSUE_URL_RE.exec(url);
  return m !== null && !isDotSegment(m[2]) && !isDotSegment(m[3]);
}
