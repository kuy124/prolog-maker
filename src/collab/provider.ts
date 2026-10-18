/**
 * Collaboration provider.
 *
 * Wires together the pieces that make live editing work with no server:
 *
 *   Y.Doc           the shared state
 *   y-indexeddb     local persistence, so a reload does not lose the room
 *   y-webrtc        peer-to-peer transport over free public signalling servers
 *   awareness       ephemeral presence: cursors, selections, names
 *
 * Awareness is deliberately separate from the document. A cursor moves many
 * times a second and must never be persisted or merged into history, which is
 * exactly what awareness is for.
 *
 * Encryption: the room id doubles as the shared secret, so a signalling server
 * only ever sees ciphertext. That is why room ids are generated from a wide
 * alphabet rather than being sequential.
 *
 * One property of `y-webrtc` shapes the rest of the app: it keeps a module-global
 * registry of rooms and throws if a second provider is created for a room that
 * already has one in the same context. So one browser tab is one WebRTC peer, and
 * a second tab in the same browser reaches the first over BroadcastChannel
 * instead. That is the intended path, not a workaround — it is why two tabs on
 * one machine stay in sync even when the network blocks WebRTC entirely.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import type { Awareness } from 'y-protocols/awareness';

export interface PeerState {
  clientId: number;
  name: string;
  color: string;
  /** Caret position in the program, as a character offset, or null. */
  cursor: number | null;
  /** The goal this peer has selected, so a group can see who is running what. */
  goal: string | null;
  /** True while this peer's own engine is evaluating something. */
  running: boolean;
}

export interface RoomHandle {
  room: string;
  ydoc: Y.Doc;
  awareness: Awareness;
  provider: WebrtcProvider;
  persistence: IndexeddbPersistence;
  /** Resolves once IndexedDB has loaded, so the first render is not empty. */
  whenLoaded: Promise<void>;
  destroy: () => void;
}

export interface RoomOptions {
  /** Set false to disable the network transport (used in tests). */
  connect?: boolean;
  /** Set false to disable IndexedDB (used in tests). */
  persist?: boolean;
  signalling?: string[];
}

/**
 * Signalling servers.
 *
 * A signalling server does one small job: introduce two peers so they can open a
 * direct connection, then get out of the way. It never sees document content,
 * because the room id doubles as the encryption key.
 *
 * IMPORTANT: this must be a y-webrtc *signalling* server, not a y-websocket
 * server. They are different protocols over the same WebSocket, and pointing at
 * the wrong one fails silently — the socket opens, peers are never introduced.
 * `scripts/probe-collab.mjs` verifies the candidates end to end by moving an
 * actual document between two peers, which is the only check that distinguishes
 * the two.
 *
 * Override in any of three ways, in priority order:
 *   1. `window.__PROLOG_SIGNALING__` — a runtime array, used by the E2E tests
 *   2. `?signaling=wss://host1,wss://host2` — for a self-hosted server
 *   3. `VITE_SIGNALING` at build time — comma-separated
 *
 * If no server is reachable the app still works: tabs in the same browser sync
 * over BroadcastChannel, and share links carry a snapshot of the room. Only
 * cross-device live editing is lost, and the status indicator says so.
 */
const DEFAULT_SIGNALLING = ['wss://signaling.fly.dev'];

function fromQuery(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('signaling');
    if (!raw) return null;
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

function fromGlobal(): string[] | null {
  if (typeof window === 'undefined') return null;
  const value = (window as unknown as { __PROLOG_SIGNALING__?: unknown }).__PROLOG_SIGNALING__;
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return list.length > 0 ? list : null;
  }
  return null;
}

function fromEnv(): string[] | null {
  const raw = import.meta.env?.VITE_SIGNALING as string | undefined;
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/** The signalling servers to use, honouring every override. */
export function resolveSignallingServers(): string[] {
  return fromGlobal() ?? fromQuery() ?? fromEnv() ?? DEFAULT_SIGNALLING;
}

/**
 * The local awareness state.
 *
 * Kept small: it is broadcast on every caret move, and every byte is paid for on
 * every peer's connection.
 */
export interface LocalPresence {
  name: string;
  color: string;
  cursor: number | null;
  goal: string | null;
  running: boolean;
}

export function createRoom(room: string, options: RoomOptions = {}): RoomHandle {
  const ydoc = new Y.Doc();
  const connect = options.connect ?? true;
  const persist = options.persist ?? true;

  const persistence = new IndexeddbPersistence(`prolog:${room}`, ydoc);

  const provider = new WebrtcProvider(room, ydoc, {
    // The room id is the encryption key; the same id on two peers means the same
    // key, so a relay only ever holds ciphertext.
    password: room,
    signaling: options.signalling ?? resolveSignallingServers(),
    maxConns: 24,
    filterBcConns: true,
  });

  if (!connect) {
    // Still created, so awareness has a home, but with no transports.
    provider.disconnect();
  }
  if (!persist) {
    persistence.destroy();
  }

  /*
   * Leave loudly.
   *
   * Awareness drops a silent client only after `outdatedTimeout`, which is 30
   * seconds in y-protocols. Without this, closing a tab parks the departing
   * collaborator's name and cursor on the room for half a minute.
   *
   * `pagehide` rather than `unload` because the latter blocks navigation and is
   * unreliable on mobile, and because a bfcache restore re-fires it.
   */
  const announceLeave = () => provider.awareness.setLocalState(null);
  window.addEventListener('pagehide', announceLeave);

  return {
    room,
    ydoc,
    awareness: provider.awareness,
    provider,
    persistence,
    whenLoaded: persistence.whenSynced.then(() => undefined),
    destroy: () => {
      window.removeEventListener('pagehide', announceLeave);
      provider.destroy();
      persistence.destroy();
      ydoc.destroy();
    },
  };
}

/** Reads every remote peer's presence, excluding our own client. */
export function readPeers(awareness: Awareness, localClientId: number): PeerState[] {
  const peers: PeerState[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const raw = state as Partial<LocalPresence>;
    peers.push({
      clientId,
      name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : `Peer ${clientId}`,
      color: typeof raw.color === 'string' ? raw.color : '#5B6167',
      cursor: typeof raw.cursor === 'number' && Number.isFinite(raw.cursor) ? raw.cursor : null,
      goal: typeof raw.goal === 'string' && raw.goal.length > 0 ? raw.goal : null,
      running: raw.running === true,
    });
  });
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** Number of peers currently connected through the WebRTC provider. */
export function connectedPeerCount(provider: WebrtcProvider): number {
  try {
    // `room.webrtcConns` is the provider's live connection map.
    const room = (provider as unknown as { room?: { webrtcConns?: Map<unknown, unknown> } }).room;
    return room?.webrtcConns?.size ?? 0;
  } catch {
    return 0;
  }
}

export { DEFAULT_SIGNALLING };
