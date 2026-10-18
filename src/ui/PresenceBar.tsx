/**
 * Presence.
 *
 * Who is in the room, what they are running, and whether the connection is live.
 * Presence is always name-plus-colour, never colour alone, and the colour is
 * chosen so the text drawn on it stays legible in either theme.
 *
 * The connection line is deliberately honest about a partial state: peers in the
 * same browser reach each other over BroadcastChannel with no network at all, so
 * "connected" and "the network works" are different claims and are reported
 * separately.
 */

import { useState } from 'react';
import { presenceInk, type Identity } from '../collab/identity';
import type { PeerState } from '../collab/provider';

interface Props {
  me: Identity;
  peers: PeerState[];
  /** Peers connected over WebRTC specifically, as opposed to in this browser. */
  networkPeers: number;
  /** True when at least one signalling server is configured. */
  signaling: boolean;
  onRename: (name: string) => void;
}

export function PresenceBar({ me, peers, networkPeers, signaling, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(me.name);

  const commit = () => {
    const name = draft.trim().slice(0, 32);
    if (name.length > 0) onRename(name);
    else setDraft(me.name);
    setEditing(false);
  };

  return (
    <div className="presence">
      <div className="presence__people" role="list" aria-label="People in this room">
        <span className="presence__you" role="listitem">
          {editing ? (
            <input
              className="presence__rename"
              value={draft}
              autoFocus
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commit();
                if (event.key === 'Escape') {
                  setDraft(me.name);
                  setEditing(false);
                }
              }}
              aria-label="Your name"
              maxLength={32}
            />
          ) : (
            <button
              type="button"
              className="avatar avatar--me"
              style={{ background: me.color, color: presenceInk(me.color) }}
              onClick={() => setEditing(true)}
              title="Change your name"
            >
              {initials(me.name)}
            </button>
          )}
          <span className="visually-hidden">{editing ? '' : `${me.name} (you)`}</span>
        </span>

        {peers.map((peer) => (
          <span key={peer.clientId} className="presence__peer" role="listitem" title={peerTitle(peer)}>
            <span className="avatar" style={{ background: peer.color, color: presenceInk(peer.color) }}>
              {initials(peer.name)}
            </span>
            {peer.running ? <span className="presence__busy" aria-hidden="true" /> : null}
            <span className="visually-hidden">
              {peer.name}
              {peer.running ? ', running a goal' : ''}
            </span>
          </span>
        ))}
      </div>

      <p className="presence__status">
        {peers.length === 0 ? (
          signaling ? (
            <span className="status status--idle">Waiting for others</span>
          ) : (
            <span className="status status--warn">No signalling server</span>
          )
        ) : networkPeers > 0 ? (
          <span className="status status--ok">
            {peers.length} {peers.length === 1 ? 'person' : 'people'} connected
          </span>
        ) : (
          <span className="status status--local">
            {peers.length} {peers.length === 1 ? 'tab' : 'tabs'} in this browser
          </span>
        )}
      </p>
    </div>
  );
}

function peerTitle(peer: PeerState): string {
  if (peer.running && peer.goal) return `${peer.name} is running ${peer.goal}`;
  if (peer.running) return `${peer.name} is running a goal`;
  if (peer.goal) return `${peer.name} · ${peer.goal}`;
  return peer.name;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
