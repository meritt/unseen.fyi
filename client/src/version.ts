const REPO_SLUG = 'meritt/unseen.fyi';

const SHA_RE = /^[0-9a-f]{7,40}$/u;

export type ReleaseStamp = {
  readonly shortSha: string;
  readonly commitUrl: string;
};

export const releaseStamp = (sha: string): ReleaseStamp | null => {
  if (!SHA_RE.test(sha)) {
    return null;
  }
  return {
    shortSha: sha.slice(0, 7),
    commitUrl: `https://github.com/${REPO_SLUG}/commit/${sha}`,
  };
};
