import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const DISABLED = ['listitem', 'aria-allowed-role'];

export const scan = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).withTags(TAGS).disableRules(DISABLED).analyze();
  if (results.violations.length > 0) {
    const summary = results.violations
      .map((v) => {
        const nodes = v.nodes
          .map((n) => `  - target=${n.target.join(' ')}  failureSummary=${n.failureSummary ?? ''}`)
          .join('\n');
        return `${v.id} (${v.impact ?? 'unknown'}): ${v.help}\n${nodes}`;
      })
      .join('\n');
    throw new Error(`axe-core violations:\n${summary}`);
  }
};
