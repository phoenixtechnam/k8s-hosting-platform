import { describe, it, expect } from 'vitest';
import { parseImapsyncProgress } from './progress-parser.js';

describe('parseImapsyncProgress', () => {
  it('returns null fields for empty input', () => {
    expect(parseImapsyncProgress('')).toEqual({
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
    });
  });

  it('returns null fields when no patterns match', () => {
    expect(parseImapsyncProgress('Connecting to server\nNothing to do here\n')).toEqual({
      messagesTotal: null,
      messagesTransferred: null,
      currentFolder: null,
    });
  });

  it('parses the latest "Copying msg N/M" line', () => {
    const log = `
Connecting to server
+ Copying msg 1/200 [INBOX]
+ Copying msg 2/200 [INBOX]
+ Copying msg 100/200 [INBOX]
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(100);
    expect(result.messagesTotal).toBe(200);
  });

  it('parses bracket-style "Copying msg N/M [...] folder" lines', () => {
    const log = `+ Copying msg 42/100 [42/100] {INBOX/Subfolder}`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(42);
    expect(result.messagesTotal).toBe(100);
  });

  it('parses the most recent "From Folder [name]" line', () => {
    const log = `
From Folder [INBOX]                Size:  1234 Messages:  200
From Folder [INBOX/Sent]           Size:  5678 Messages:  50
+ Copying msg 5/250 [INBOX/Sent]
`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Sent');
  });

  it('handles partial information gracefully — only messages, no folder', () => {
    const log = `+ Copying msg 10/50`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(10);
    expect(result.messagesTotal).toBe(50);
    expect(result.currentFolder).toBeNull();
  });

  it('handles partial information gracefully — only folder, no messages', () => {
    const log = `From Folder [INBOX/Drafts]`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Drafts');
    expect(result.messagesTransferred).toBeNull();
    expect(result.messagesTotal).toBeNull();
  });

  it('uses the LAST "Copying msg" line when multiple are present', () => {
    const log = `
+ Copying msg 1/1000
+ Copying msg 100/1000
+ Copying msg 999/1000
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(999);
    expect(result.messagesTotal).toBe(1000);
  });

  it('handles whitespace and varying number widths', () => {
    const log = `   +   Copying msg     7 /    42  [INBOX]`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(7);
    expect(result.messagesTotal).toBe(42);
  });

  it('ignores lines that look similar but are not progress markers', () => {
    const log = `
Total: 123/456 messages OK
Folder INBOX has 100/200 unread
`;
    const result = parseImapsyncProgress(log);
    // Neither line matches "Copying msg N/M" so should be null.
    expect(result.messagesTransferred).toBeNull();
    expect(result.messagesTotal).toBeNull();
  });

  // Round-4 Phase 3 review HIGH-2: documents the known limitation
  // that bracket-style folder names with a colon-and-digit pattern
  // are filtered as dates.
  it('KNOWN LIMITATION: bracket-style folder name with colon is misidentified as a date', () => {
    const log = `+ Copying msg 1/10 [INBOX/Daily-09:00]`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(1);
    expect(result.messagesTotal).toBe(10);
    // The colon in '09:00' triggers the date heuristic. The
    // brace-style pattern (which imapsync 2.x always emits) is
    // not affected — see the next test.
    expect(result.currentFolder).toBeNull();
  });

  it('brace-style folder names with a colon are NOT filtered (preferred path)', () => {
    const log = `+ Copying msg 5/10 [Sun Jan 14 12:00:00 2024] {INBOX/Daily-09:00}`;
    const result = parseImapsyncProgress(log);
    expect(result.currentFolder).toBe('INBOX/Daily-09:00');
  });

  it('parses real-world imapsync output sample', () => {
    const log = `
Host1: imap.gmail.com port 993
Host2: stalwart-mail.mail.svc.cluster.local port 143
Banner host1: * OK Gimap ready for requests
Folders to migrate: 5
From Folder [INBOX]                Size:    8388608 Messages:    1500
From Folder [Sent]                 Size:    1048576 Messages:    250
From Folder [Drafts]               Size:      32768 Messages:     12
From Folder [Trash]                Size:     524288 Messages:     45
From Folder [Spam]                 Size:     262144 Messages:    123
+ Copying msg    1/1500 [Sun Jan 14 12:00:00 2024] {INBOX}
+ Copying msg    2/1500 [Sun Jan 14 12:00:01 2024] {INBOX}
+ Copying msg  100/1500 [Sun Jan 14 12:00:30 2024] {INBOX}
+ Copying msg  500/1500 [Sun Jan 14 12:02:30 2024] {INBOX}
+ Copying msg  750/1500 [Sun Jan 14 12:04:00 2024] {INBOX}
`;
    const result = parseImapsyncProgress(log);
    expect(result.messagesTransferred).toBe(750);
    expect(result.messagesTotal).toBe(1500);
    // The "Spam" line is the LAST "From Folder" so progress-parser
    // would surface it; but the latest copy line says INBOX. The
    // current folder should reflect what imapsync is actively
    // copying — we treat the {brace} folder marker on the copy line
    // as authoritative when present.
    expect(result.currentFolder).toBe('INBOX');
  });
});
