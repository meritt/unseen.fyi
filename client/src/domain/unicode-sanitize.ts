const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/gu;

export const ZERO_WIDTH_RE =
  /[\u00AD\u115F\u1160\u180E\u200B-\u200D\u2060-\u2064\u3164\uFEFF\uFFA0]/u;

const INVISIBLE_FILENAME_RE = /[\uFEFF\u200E\u200F]/gu;

const CONTROL_RE = /\p{Cc}/gu;

const PATH_SEPARATOR_RE = /[/\\:|]/gu;

const FILENAME_BYTE_CAP = 255;

const COMBINING_MARK_RE = /\p{Mn}/u;

const COMBINING_CAP = 4;

function capCombiningRuns(input: string): string {
  let result = '';
  let run = 0;
  for (const ch of input) {
    if (COMBINING_MARK_RE.test(ch)) {
      run += 1;
      if (run <= COMBINING_CAP) {
        result += ch;
      }
      continue;
    }
    run = 0;
    result += ch;
  }
  return result;
}

export function sanitizeUnicode(raw: string): string {
  const noBidi = raw.replaceAll(BIDI_CONTROL_RE, '');
  const normalized = noBidi.normalize('NFC');
  return capCombiningRuns(normalized);
}

const truncateUtf8 = (input: string, maxBytes: number): string => {
  const encoded = new TextEncoder().encode(input);
  if (encoded.byteLength <= maxBytes) {
    return input;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let len = maxBytes; len > 0; len -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, len));
    } catch {
      /* try shorter */
    }
  }
  return '';
};

export function sanitizeFilename(name: string): string | null {
  const nfc = name.normalize('NFC');
  const noBidi = nfc.replaceAll(BIDI_CONTROL_RE, '');
  const noInvisible = noBidi.replaceAll(INVISIBLE_FILENAME_RE, '');
  const noControl = noInvisible.replaceAll(CONTROL_RE, '_');
  const noPath = noControl.replaceAll(PATH_SEPARATOR_RE, '_');

  if (noPath === '' || noPath === '.' || noPath === '..') {
    return null;
  }

  const truncated = truncateUtf8(noPath, FILENAME_BYTE_CAP);
  if (truncated === '' || truncated === '.' || truncated === '..') {
    return null;
  }

  if (truncated.startsWith('.')) {
    return `_${truncated}`;
  }
  return truncated;
}
