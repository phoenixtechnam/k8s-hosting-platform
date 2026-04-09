/**
 * Round-4 Phase 3: pure parser for imapsync stdout.
 *
 * Extracts the latest progress markers (message count, total, and
 * current folder) from a batched log tail. Returns null fields
 * when no patterns match — callers should NOT overwrite existing
 * progress columns with null, but only update fields that have a
 * non-null result.
 *
 * The parser is intentionally lenient because imapsync's output
 * format varies between versions and operators sometimes pipe it
 * through their own log wrappers. We prefer "match what we can,
 * skip what we can't" over "fail loudly when format changes".
 *
 * Pattern reference (from real imapsync 2.x output):
 *
 *   + Copying msg    750/1500 [Sun Jan 14 12:04:00 2024] {INBOX}
 *   + Copying msg 100/200 [INBOX]
 *
 *   From Folder [INBOX]                Size:    8388608 Messages:    1500
 *
 * Folder priority: braces on a "Copying msg" line take precedence
 * (it's what imapsync is *actively* copying right now), then the
 * bracket on the same line, then the most recent "From Folder
 * [name]" line.
 */

export interface ImapsyncProgress {
  readonly messagesTotal: number | null;
  readonly messagesTransferred: number | null;
  readonly currentFolder: string | null;
}

const COPY_LINE_REGEX = /\+\s*Copying\s+msg\s*(\d+)\s*\/\s*(\d+)/g;
const COPY_FOLDER_BRACE_REGEX = /\+\s*Copying\s+msg\s*\d+\s*\/\s*\d+.*?\{([^}]+)\}/g;
const COPY_FOLDER_BRACKET_REGEX = /\+\s*Copying\s+msg\s*\d+\s*\/\s*\d+\s*\[([^\]]+)\](?!\s*\[)/g;
const FROM_FOLDER_REGEX = /^From\s+Folder\s+\[([^\]]+)\]/gm;

function lastMatch(re: RegExp, input: string): RegExpExecArray | null {
  // RegExps must have the global flag for matchAll to work.
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    last = m;
  }
  return last;
}

function parseFolderFromCopyLine(input: string): string | null {
  // Prefer brace-style {INBOX}, then bracket-style [INBOX] if it
  // doesn't look like a date. We only consider the LATEST match.
  const lastBrace = lastMatch(new RegExp(COPY_FOLDER_BRACE_REGEX.source, 'g'), input);
  if (lastBrace) return lastBrace[1].trim();

  const lastBracket = lastMatch(new RegExp(COPY_FOLDER_BRACKET_REGEX.source, 'g'), input);
  if (lastBracket) {
    const candidate = lastBracket[1].trim();
    // Heuristic: skip ISO/date-like strings (contain a digit + colon)
    // since the timestamp bracket pattern is `[Sun Jan 14 12:04:00 2024]`.
    //
    // KNOWN LIMITATION (review HIGH-2): folder names that contain a
    // colon-and-digit pattern like `INBOX/Daily-09:00` will be
    // incorrectly filtered as dates. The brace-style pattern
    // `{INBOX/Daily-09:00}` works correctly, so imapsync 2.x output
    // is unaffected (it always emits the brace marker on Copying
    // lines). The bracket-style fallback is only hit when the log
    // is from an older imapsync version or a custom wrapper.
    if (!/\b\d{1,2}:\d{2}/.test(candidate)) return candidate;
  }
  return null;
}

export function parseImapsyncProgress(log: string): ImapsyncProgress {
  if (!log) {
    return { messagesTotal: null, messagesTransferred: null, currentFolder: null };
  }

  // Latest "+ Copying msg N/M" line
  const lastCopy = lastMatch(new RegExp(COPY_LINE_REGEX.source, 'g'), log);
  const messagesTransferred = lastCopy ? parseInt(lastCopy[1], 10) : null;
  const messagesTotal = lastCopy ? parseInt(lastCopy[2], 10) : null;

  // Folder: try to extract from the latest copy line first
  let currentFolder: string | null = parseFolderFromCopyLine(log);

  // Fallback to the most recent "From Folder [name]" header line
  if (!currentFolder) {
    const lastFrom = lastMatch(new RegExp(FROM_FOLDER_REGEX.source, 'gm'), log);
    if (lastFrom) currentFolder = lastFrom[1].trim();
  }

  return {
    messagesTotal,
    messagesTransferred,
    currentFolder,
  };
}
