/**
 * Output scanner for customer-mode AI edits.
 * Strips disallowed patterns from AI-generated HTML/JS.
 * Admin mode bypasses this entirely.
 */

const SCRIPT_ALLOWLIST = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

interface ScanResult {
  readonly content: string;
  readonly stripped: readonly string[];
  readonly refused: boolean;
  readonly refusalMessage?: string;
}

export function scanOutput(content: string): ScanResult {
  const stripped: string[] = [];

  // Check for LLM refusal
  if (content.startsWith('REFUSED:')) {
    return {
      content: '',
      stripped: [],
      refused: true,
      refusalMessage: content.slice(8).trim(),
    };
  }

  let result = content;

  // File size check (150KB)
  if (Buffer.byteLength(result, 'utf-8') > 150 * 1024) {
    return {
      content: '',
      stripped: ['File exceeds 150KB size limit'],
      refused: true,
      refusalMessage: 'Generated content exceeds the 150KB size limit. Try a simpler request.',
    };
  }

  // Strip PHP tags
  const phpPattern = /<\?(?:php|=)/gi;
  if (phpPattern.test(result)) {
    result = result.replace(/<\?(?:php|=)[\s\S]*?\?>/gi, '<!-- removed: PHP code -->');
    stripped.push('PHP code removed');
  }

  // Strip non-allowlisted external scripts
  const scriptSrcPattern = /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  result = result.replace(scriptSrcPattern, (match, src: string) => {
    const isAllowed = SCRIPT_ALLOWLIST.some((domain) => src.includes(domain));
    if (!isAllowed) {
      stripped.push(`External script removed: ${src}`);
      return '<!-- removed: external script -->';
    }
    return match;
  });

  // Strip iframes
  const iframePattern = /<iframe[\s\S]*?(?:<\/iframe>|\/?>)/gi;
  if (iframePattern.test(result)) {
    result = result.replace(iframePattern, '<!-- removed: iframe -->');
    stripped.push('iframe removed');
  }

  // Strip javascript: protocol in href/src
  result = result.replace(/(?:href|src)\s*=\s*["']javascript:[^"']*["']/gi, (match) => {
    stripped.push('javascript: URI removed');
    return 'href="#"';
  });

  // Strip dangerous JS patterns
  const dangerousPatterns = [
    { pattern: /\beval\s*\(/g, name: 'eval()' },
    { pattern: /\bFunction\s*\(/g, name: 'Function()' },
  ];
  for (const { pattern, name } of dangerousPatterns) {
    if (pattern.test(result)) {
      result = result.replace(pattern, '/* removed */ void(');
      stripped.push(`${name} removed`);
    }
  }

  return { content: result, stripped, refused: false };
}
