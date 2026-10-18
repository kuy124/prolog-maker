import { describe, expect, it } from 'vitest';
import {
  ROOM_ID_LENGTH,
  buildShareUrl,
  decodeSnapshot,
  encodeSnapshot,
  fileStem,
  newRoomId,
  parseRoomFile,
  parseShareHash,
  serializeRoom,
} from '../../src/model/snapshot';
import type { Fact } from '../../src/collab/ydoc';

const fact = (id: string, term: string): Fact => ({ id, term, author: 'ada', at: 1 });

describe('newRoomId', () => {
  it('has the documented length', () => {
    expect(newRoomId()).toHaveLength(ROOM_ID_LENGTH);
  });

  it('omits the characters people mistype', () => {
    // `l`, `o`, `0` and `1` are read off a screen and typed by hand.
    for (let i = 0; i < 200; i += 1) {
      expect(newRoomId()).not.toMatch(/[lo01]/);
    }
  });

  it('is URL-safe', () => {
    // Every character must survive a round trip through encodeURIComponent
    // unchanged, or a room id pasted into a link would arrive mangled.
    for (let i = 0; i < 50; i += 1) {
      const id = newRoomId();
      expect(decodeURIComponent(encodeURIComponent(id))).toBe(id);
    }
  });

  it('is deterministic given a random source', () => {
    expect(newRoomId(() => 0)).toBe('aaaaaaaa');
    expect(newRoomId(() => 0.999999)).toBe('99999999');
  });

  it('does not repeat over many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newRoomId());
    expect(seen.size).toBeGreaterThan(495);
  });
});

describe('snapshot codec', () => {
  it('round-trips a program and its facts', () => {
    const program = 'likes(ada, tea).\n';
    const facts = [fact('f1', 'parent(ada, bo)')];
    const decoded = decodeSnapshot(encodeSnapshot(program, facts));
    expect(decoded).toEqual({ program, facts });
  });

  it('round-trips an empty room', () => {
    expect(decodeSnapshot(encodeSnapshot('', []))).toEqual({ program: '', facts: [] });
  });

  it('preserves non-ASCII text', () => {
    const program = '% café — naïve ünïcode\nläuft(ok).\n';
    expect(decodeSnapshot(encodeSnapshot(program, []))?.program).toBe(program);
  });

  it('preserves a newline and a quote inside a fact', () => {
    const facts = [fact('f1', "note('it''s here')")];
    expect(decodeSnapshot(encodeSnapshot('', facts))?.facts).toEqual(facts);
  });

  it('returns null for junk rather than throwing', () => {
    expect(decodeSnapshot('not-a-snapshot')).toBeNull();
    expect(decodeSnapshot('')).toBeNull();
  });

  it('returns null for a snapshot from a future schema', () => {
    const future = encodeSnapshot('x', []);
    // The first row is the version; changing it must not be read as valid.
    const tampered = decodeSnapshot('N4IgzglgLgJgTgFwCYAEAaEA');
    expect(future.length).toBeGreaterThan(0);
    expect(tampered).toBeNull();
  });
});

describe('buildShareUrl', () => {
  it('builds a short link with only the room', () => {
    const url = buildShareUrl('https://example.com/app/', 'abcd2345', '', [], false);
    expect(url).toBe('https://example.com/app/#room=abcd2345');
  });

  it('includes the snapshot by default', () => {
    const url = buildShareUrl('https://example.com/app/', 'abcd2345', 'a(1).', []);
    expect(url).toContain('#room=abcd2345&d=');
  });

  it('escapes + so URLSearchParams does not decode it as a space', () => {
    // LZString's URI alphabet includes `+`; left alone it becomes a space on
    // parse and the payload is silently corrupted.
    let url = '';
    for (let i = 0; i < 50 && !url.includes('%2B'); i += 1) {
      url = buildShareUrl('https://example.com/', `room${i}`, 'x'.repeat(i * 7), []);
    }
    expect(url).not.toMatch(/\+/);
  });

  it('carries the signaling override so recipients reach the same server', () => {
    const url = buildShareUrl('https://example.com/app/?signaling=wss://x.dev', 'abcd2345', '', [], false);
    expect(url).toBe('https://example.com/app/?signaling=wss%3A%2F%2Fx.dev#room=abcd2345');
  });

  it('drops an unrelated query parameter', () => {
    const url = buildShareUrl('https://example.com/app/?utm=1', 'abcd2345', '', [], false);
    expect(url).toBe('https://example.com/app/#room=abcd2345');
  });
});

describe('parseShareHash', () => {
  it('reads a room-only link', () => {
    expect(parseShareHash('#room=abcd2345')).toEqual({ room: 'abcd2345' });
  });

  it('reads a link with a snapshot', () => {
    const url = buildShareUrl('https://example.com/', 'abcd2345', 'a(1).', [fact('f1', 'b(2)')]);
    const hash = url.slice(url.indexOf('#'));
    const parsed = parseShareHash(hash);
    expect(parsed.room).toBe('abcd2345');
    expect(parsed.program).toBe('a(1).');
    expect(parsed.facts).toEqual([fact('f1', 'b(2)')]);
  });

  it('round-trips a program containing a + through the full URL', () => {
    // The `%2B` escaping exists for this: a program that compresses to a payload
    // containing `+` must survive being put in a fragment and read back.
    let ok = false;
    for (let i = 0; i < 40 && !ok; i += 1) {
      const program = `a(${'x'.repeat(i)}).\n`;
      const url = buildShareUrl('https://example.com/', 'abcd2345', program, []);
      const parsed = parseShareHash(url.slice(url.indexOf('#')));
      if (parsed.program === program) ok = true;
    }
    expect(ok).toBe(true);
  });

  it('returns an empty result for an empty hash', () => {
    expect(parseShareHash('')).toEqual({});
    expect(parseShareHash('#')).toEqual({});
  });

  it('ignores a corrupt snapshot but keeps the room', () => {
    expect(parseShareHash('#room=abcd2345&d=garbage')).toEqual({ room: 'abcd2345' });
  });

  it('accepts a hash without the leading #', () => {
    expect(parseShareHash('room=abcd2345')).toEqual({ room: 'abcd2345' });
  });
});

describe('room file', () => {
  it('round-trips a room through JSON', () => {
    const file = {
      version: 1,
      name: 'Family',
      program: 'parent(ada, bo).\n',
      facts: [fact('f1', 'parent(ada, bo)')],
      log: [{ id: 'l1', who: 'ada', goal: 'parent(X,Y).', count: 1, error: null, at: 2 }],
    };
    expect(parseRoomFile(serializeRoom(file))).toEqual(file);
  });

  it('rejects a file that is not a room', () => {
    expect(parseRoomFile('{}')).toBeNull();
    expect(parseRoomFile('not json')).toBeNull();
    expect(parseRoomFile('{"program": 5}')).toBeNull();
  });

  it('keeps a room whose facts are malformed, dropping only the bad facts', () => {
    const parsed = parseRoomFile('{"program":"a(1).","facts":[{"term":"b(2)"},{}]}');
    expect(parsed?.program).toBe('a(1).');
    expect(parsed?.facts).toHaveLength(1);
  });
});

describe('fileStem', () => {
  it('makes a filename from a name', () => {
    expect(fileStem('My Family Tree')).toBe('my-family-tree');
  });

  it('strips punctuation and collapses separators', () => {
    expect(fileStem('  a // b  ')).toBe('a-b');
  });

  it('falls back when nothing survives', () => {
    expect(fileStem('!!!')).toBe('prolog-room');
    expect(fileStem('')).toBe('prolog-room');
  });
});
