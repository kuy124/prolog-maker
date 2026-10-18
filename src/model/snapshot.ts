/**
 * Share-link codec.
 *
 * The app is peer-to-peer with no server, so there is nowhere to persist a room
 * when every tab closes. The fix: a share link carries a compressed snapshot of
 * the room *and* the room id to join for live editing. Opening the link
 * reconstructs the workspace immediately, even if nobody is online, and then
 * syncs with anyone who is.
 *
 * The fragment is used rather than the query string because fragments are not
 * sent to servers, so a static host never sees the program.
 */

import LZString from 'lz-string';
import type { Fact, LogEntry } from '../collab/ydoc';

export interface ShareLink {
  room: string;
  program: string;
  facts: Fact[];
}

const SCHEMA_VERSION = 1;

/**
 * Characters in a room id.
 *
 * The alphabet omits `l`, `o`, `0` and `1`: a room id gets read off a screen and
 * typed into another device by hand, and those four are the pairs people
 * transcribe wrongly. Getting this wrong is subtle — a stray `o` still produces a
 * valid-looking id, it just occasionally costs someone a failed join.
 *
 * Eight characters over 31 symbols is about 40 bits. That is deliberate: the id
 * has to be short enough to say out loud, and what it protects against is
 * somebody guessing the room rather than somebody attacking the key. It is also
 * the live-editing key, so raising this one constant raises the security.
 */
export const ROOM_ID_LENGTH = 8;

/** Generates a short, URL-safe room id that is hard to guess by accident. */
export function newRoomId(random: () => number = Math.random): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? 'x';
  }
  return out;
}

/**
 * Encodes the room into a URL-safe string.
 *
 * Positional rows rather than objects: `id`, `term`, `author` and `at` would
 * repeat once per fact, and compression does not remove them entirely. The log
 * is deliberately not carried — it is history, not the workspace.
 */
export function encodeSnapshot(program: string, facts: Fact[]): string {
  const rows = [
    SCHEMA_VERSION,
    program,
    facts.map((fact) => [fact.id, fact.term, fact.author, fact.at]),
  ];
  return LZString.compressToEncodedURIComponent(JSON.stringify(rows));
}

export function decodeSnapshot(encoded: string): { program: string; facts: Fact[] } | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed[0] !== SCHEMA_VERSION) return null;
    const [, program, factRows] = parsed;
    if (typeof program !== 'string') return null;
    const facts: Fact[] = [];
    if (Array.isArray(factRows)) {
      for (const row of factRows) {
        if (!Array.isArray(row)) continue;
        const [id, term, author, at] = row;
        if (typeof id !== 'string' || typeof term !== 'string') continue;
        facts.push({
          id,
          term,
          author: typeof author === 'string' ? author : 'someone',
          at: typeof at === 'number' ? at : 0,
        });
      }
    }
    return { program, facts };
  } catch {
    return null;
  }
}

/**
 * Builds a live-room URL with an optional snapshot.
 *
 * LZString's URI alphabet includes `+`, which `URLSearchParams` decodes as a
 * space when the fragment is parsed. Escaping `+` as `%2B` keeps the payload
 * intact through a round trip; every other character in the alphabet is already
 * fragment-safe.
 */
export function buildShareUrl(
  base: string,
  room: string,
  program: string,
  facts: Fact[],
  includeSnapshot = true,
): string {
  const [path, query] = base.split('#')[0]!.split('?');
  const signaling = new URLSearchParams(query).get('signaling');
  const clean = path + (signaling ? '?' + new URLSearchParams({ signaling }).toString() : '');
  const live = `${clean}#room=${encodeURIComponent(room)}`;
  if (!includeSnapshot) return live;
  const encoded = encodeSnapshot(program, facts).replace(/\+/g, '%2B');
  return `${live}&d=${encoded}`;
}

/**
 * Parses a location hash. Tolerates a hash with only a room (live join with no
 * seed) or only a document, so an older or hand-edited link degrades rather than
 * failing.
 */
export function parseShareHash(hash: string): Partial<ShareLink> {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return {};
  const params = new URLSearchParams(raw);
  const result: Partial<ShareLink> = {};

  const room = params.get('room');
  if (room && room.trim().length > 0) result.room = room.trim();

  const encoded = params.get('d');
  if (encoded) {
    const snapshot = decodeSnapshot(encoded);
    if (snapshot) {
      result.program = snapshot.program;
      result.facts = snapshot.facts;
    }
  }
  return result;
}

/** A JSON backup, for saving a room to disk without a link. */
export interface RoomFile {
  version: number;
  name: string;
  program: string;
  facts: Fact[];
  log: LogEntry[];
}

export function serializeRoom(file: RoomFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

export function parseRoomFile(text: string): RoomFile | null {
  try {
    const parsed = JSON.parse(text) as Partial<RoomFile>;
    if (!parsed || typeof parsed.program !== 'string') return null;
    const facts = Array.isArray(parsed.facts)
      ? parsed.facts.flatMap((fact) => {
          if (!fact || typeof fact.term !== 'string') return [];
          return [
            {
              id: typeof fact.id === 'string' ? fact.id : 'imported',
              term: fact.term,
              author: typeof fact.author === 'string' ? fact.author : 'imported',
              at: typeof fact.at === 'number' ? fact.at : 0,
            },
          ];
        })
      : [];
    const log = Array.isArray(parsed.log)
      ? parsed.log.filter((entry): entry is LogEntry => Boolean(entry) && typeof entry.goal === 'string')
      : [];
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      name: typeof parsed.name === 'string' ? parsed.name : 'Imported room',
      program: parsed.program,
      facts,
      log,
    };
  } catch {
    return null;
  }
}

/** A filename-safe stem for downloads. */
export function fileStem(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'prolog-room';
}
