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
import type { LogEntry } from '../collab/ydoc';

export interface ShareLink {
  room: string;
  program: string;
}

const SCHEMA_VERSION = 2;

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
 * Positional rows rather than objects: a schema version and the program. The log
 * is deliberately not carried — it is history, not the workspace.
 *
 * Facts used to be a third row. They are clauses, so they now travel inside the
 * program text; nothing is lost, and there is one representation instead of two.
 */
export function encodeSnapshot(program: string): string {
  const rows = [SCHEMA_VERSION, program];
  return LZString.compressToEncodedURIComponent(JSON.stringify(rows));
}

export function decodeSnapshot(encoded: string): { program: string } | null {
  try {
    const json = LZString.decompressFromEncodedURIComponent(encoded);
    if (!json) return null;
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return null;

    // Version 1 links carried a separate facts array. They still open: the facts
    // are appended to the program as clauses, which is where they live now, so an
    // old link keeps working instead of quietly losing its knowledge base.
    if (parsed[0] === 1) {
      const [, program, factRows] = parsed;
      if (typeof program !== 'string') return null;
      return { program: foldLegacyFacts(program, factRows) };
    }

    if (parsed[0] !== SCHEMA_VERSION) return null;
    const [, program] = parsed;
    return typeof program === 'string' ? { program } : null;
  } catch {
    return null;
  }
}

/**
 * Appends facts from an older format to the program text as clauses.
 *
 * Two shapes arrive here, and both have to be handled: a version-1 share link
 * carried positional rows (`[id, term, author, at]`), while a saved `.json` room
 * carried objects (`{ term }`). Each fact becomes a line of its own with exactly
 * one terminating full stop; the term is not otherwise rewritten, because it was
 * validated when it was added and reparsing it here could change what it means.
 */
function foldLegacyFacts(program: string, factRows: unknown): string {
  if (!Array.isArray(factRows)) return program;
  const clauses: string[] = [];
  for (const row of factRows) {
    const term = Array.isArray(row) ? row[1] : (row as { term?: unknown } | null)?.term;
    if (typeof term !== 'string' || term.trim().length === 0) continue;
    clauses.push(term.trimEnd().endsWith('.') ? term.trim() : `${term.trim()}.`);
  }
  if (clauses.length === 0) return program;
  const head = program.trimEnd();
  // No header when there is no program: an empty room that had facts should open
  // with those clauses alone, not with a comment explaining where they came from.
  if (head.length === 0) return `${clauses.join('\n')}\n`;
  return `${head}\n\n% Facts from an earlier share link.\n${clauses.join('\n')}\n`;
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
  includeSnapshot = true,
): string {
  const [path, query] = base.split('#')[0]!.split('?');
  const signaling = new URLSearchParams(query).get('signaling');
  const clean = path + (signaling ? '?' + new URLSearchParams({ signaling }).toString() : '');
  const live = `${clean}#room=${encodeURIComponent(room)}`;
  if (!includeSnapshot) return live;
  const encoded = encodeSnapshot(program).replace(/\+/g, '%2B');
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
    }
  }
  return result;
}

/** A JSON backup, for saving a room to disk without a link. */
export interface RoomFile {
  version: number;
  name: string;
  program: string;
  log: LogEntry[];
}

export function serializeRoom(file: RoomFile): string {
  return JSON.stringify(file, null, 2) + '\n';
}

export function parseRoomFile(text: string): RoomFile | null {
  try {
    const parsed = JSON.parse(text) as Partial<RoomFile> & { facts?: unknown };
    if (!parsed || typeof parsed.program !== 'string') return null;
    // A file saved before facts were folded into the program still imports: its
    // facts are appended as clauses rather than dropped.
    const program = foldLegacyFacts(parsed.program, parsed.facts);
    const log = Array.isArray(parsed.log)
      ? parsed.log.filter((entry): entry is LogEntry => Boolean(entry) && typeof entry.goal === 'string')
      : [];
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      name: typeof parsed.name === 'string' ? parsed.name : 'Imported room',
      program,
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
