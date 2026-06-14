import { html, nothing, type TemplateResult } from 'lit';

import { releaseStamp } from '../version.ts';

declare const __UNSEEN_VERSION__: string;

export const versionStamp = (): TemplateResult | typeof nothing => {
  const stamp = releaseStamp(__UNSEEN_VERSION__);
  if (stamp === null) {
    return nothing;
  }
  return html`<a class="version-stamp__sha" href=${stamp.commitUrl} target="_blank" rel="noreferrer"
    >git@${stamp.shortSha}</a
  >`;
};
