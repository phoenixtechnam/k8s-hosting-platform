/**
 * SQL statement splitter for migrations.
 *
 * The naive `content.split(';')` approach breaks when migration
 * files contain `;` inside comments or string literals. We hit this
 * bug twice during Phase 2c and Phase 3 (once with a semicolon in a
 * comment in 0004, again with a semicolon in a comment in 0006).
 *
 * This splitter:
 *   1. Strips `-- line comments` to end of line
 *   2. Strips `/* block comments * /`
 *   3. Preserves `'string literals'` including escaped `''` doubles
 *   4. Preserves `"identifier quotes"`
 *   5. Preserves `$$dollar-quoted$$` blocks (PostgreSQL function bodies,
 *      DO blocks, etc.)
 *   6. Splits on `;` only at the top level
 *   7. Trims and drops empty statements
 *
 * Exported + unit-tested so we can land future migrations without
 * worrying about comment content ever again.
 */

type Mode = 'normal' | 'line-comment' | 'block-comment' | 'single-quote' | 'double-quote' | 'dollar-quote';

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let mode: Mode = 'normal';
  let dollarTag = ''; // For $tag$ ... $tag$ dollar quoting

  const len = sql.length;
  let i = 0;

  while (i < len) {
    const c = sql[i];
    const next = sql[i + 1];

    switch (mode) {
      case 'normal': {
        // Line comment
        if (c === '-' && next === '-') {
          mode = 'line-comment';
          i += 2;
          continue;
        }
        // Block comment
        if (c === '/' && next === '*') {
          mode = 'block-comment';
          i += 2;
          continue;
        }
        // String literal
        if (c === "'") {
          current += c;
          mode = 'single-quote';
          i += 1;
          continue;
        }
        // Quoted identifier
        if (c === '"') {
          current += c;
          mode = 'double-quote';
          i += 1;
          continue;
        }
        // Dollar-quoted block: $$foo$$ or $tag$foo$tag$
        if (c === '$') {
          // Look for the closing $ of the opening tag
          let tagEnd = i + 1;
          while (tagEnd < len && sql[tagEnd] !== '$') {
            // Dollar-quoting tag must be a valid identifier char (letter,
            // digit, or underscore). If we hit anything else, this isn't
            // a dollar-quote start.
            const ch = sql[tagEnd];
            if (!/[a-zA-Z0-9_]/.test(ch)) break;
            tagEnd += 1;
          }
          if (tagEnd < len && sql[tagEnd] === '$') {
            dollarTag = sql.slice(i, tagEnd + 1);
            current += dollarTag;
            mode = 'dollar-quote';
            i = tagEnd + 1;
            continue;
          }
        }
        // Statement terminator
        if (c === ';') {
          const trimmed = current.trim();
          if (trimmed.length > 0) statements.push(trimmed);
          current = '';
          i += 1;
          continue;
        }
        // Regular character
        current += c;
        i += 1;
        break;
      }

      case 'line-comment': {
        if (c === '\n') {
          mode = 'normal';
          current += '\n'; // preserve newline for formatting
        }
        i += 1;
        break;
      }

      case 'block-comment': {
        if (c === '*' && next === '/') {
          mode = 'normal';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }

      case 'single-quote': {
        current += c;
        if (c === "'") {
          // Escaped single quote: '' → literal '
          if (next === "'") {
            current += next;
            i += 2;
            continue;
          }
          mode = 'normal';
        }
        i += 1;
        break;
      }

      case 'double-quote': {
        current += c;
        if (c === '"') {
          // Escaped double quote: "" → literal "
          if (next === '"') {
            current += next;
            i += 2;
            continue;
          }
          mode = 'normal';
        }
        i += 1;
        break;
      }

      case 'dollar-quote': {
        // Look for the matching closing tag
        if (c === '$' && sql.slice(i, i + dollarTag.length) === dollarTag) {
          current += dollarTag;
          mode = 'normal';
          i += dollarTag.length;
          dollarTag = '';
          continue;
        }
        current += c;
        i += 1;
        break;
      }
    }
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);

  return statements;
}
