import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_PASEO_TOOLS, ROLE_PEER_REPORTING } from '../src/roles.js';

describe('role reporting policy', () => {
  it('separates reporting eligibility from room-tool access', () => {
    // Peer may report its own assignment, and still reaches nothing in the room.
    expect(ROLE_PEER_REPORTING.peer).toBe(true);
    expect(ROLE_PASEO_TOOLS.peer).toBe(false);

    // The orchestrating seats already report through room tools and gain no second surface.
    for (const role of ['supervisor', 'lead'] as const) {
      expect(ROLE_PEER_REPORTING[role]).toBe(false);
      expect(ROLE_PASEO_TOOLS[role]).toBe(true);
    }
  });

  it('declares exactly one decision per role so a new role cannot default open', () => {
    for (const role of ROLES) {
      expect(typeof ROLE_PEER_REPORTING[role]).toBe('boolean');
      expect(typeof ROLE_PASEO_TOOLS[role]).toBe('boolean');
    }
    expect(Object.keys(ROLE_PEER_REPORTING).sort()).toEqual([...ROLES].sort());
  });

  it('never lets reporting eligibility imply room-tool access', () => {
    // The two policies are independent by construction: eligibility is not a room grant, so no
    // role may be reporting-eligible only because it holds room tools, or vice versa.
    for (const role of ROLES) {
      expect(ROLE_PEER_REPORTING[role] && ROLE_PASEO_TOOLS[role]).toBe(false);
    }
  });
});
