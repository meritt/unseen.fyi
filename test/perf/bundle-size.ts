import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'client', 'dist', 'assets');

const JS_GZIP_BUDGET = 96 * 1024;
const CSS_GZIP_BUDGET = 10 * 1024;
const JS_BROTLI_BUDGET = 80 * 1024;
const CSS_BROTLI_BUDGET = 9 * 1024;

type Sample = {
  readonly name: string;
  readonly raw: number;
  readonly gzip: number;
  readonly brotli: number;
};

const brotliSize = (buffer: Buffer): number =>
  brotliCompressSync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
    },
  }).length;

const measure = (file: string): Sample => {
  const buffer = readFileSync(file);
  return {
    name: path.basename(file),
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliSize(buffer),
  };
};

const collect = (extension: '.js' | '.css'): readonly Sample[] => {
  const entries = readdirSync(ASSETS_DIR);
  return entries
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => measure(path.join(ASSETS_DIR, entry)));
};

const formatRow = (s: Sample): string =>
  `  ${s.name.padEnd(42)} raw=${String(s.raw).padStart(6)}  gzip=${String(s.gzip).padStart(6)}  br=${String(s.brotli).padStart(6)}`;

const sumBy = (samples: readonly Sample[], key: 'gzip' | 'brotli'): number =>
  samples.reduce((acc, sample) => acc + sample[key], 0);

const report = (
  label: string,
  samples: readonly Sample[],
  gzipBudget: number,
  brotliBudget: number,
): boolean => {
  const gzipTotal = sumBy(samples, 'gzip');
  const brotliTotal = sumBy(samples, 'brotli');
  const ok = gzipTotal <= gzipBudget && brotliTotal <= brotliBudget;
  process.stdout.write(
    `${label} — ${ok ? 'PASS' : 'FAIL'} ` +
      `(gzip ${String(gzipTotal)}/${String(gzipBudget)}, brotli ${String(brotliTotal)}/${String(brotliBudget)})\n`,
  );
  for (const sample of samples) {
    process.stdout.write(`${formatRow(sample)}\n`);
  }
  return ok;
};

const js = collect('.js');
const css = collect('.css');

const jsOk = report('JS bundles', js, JS_GZIP_BUDGET, JS_BROTLI_BUDGET);
const cssOk = report('CSS bundles', css, CSS_GZIP_BUDGET, CSS_BROTLI_BUDGET);

if (!jsOk || !cssOk) {
  process.stdout.write('\nBundle size budget exceeded.\n');
  process.exit(1);
}
process.stdout.write('\nAll bundle budgets within cap.\n');
