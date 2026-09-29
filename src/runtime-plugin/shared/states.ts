/**
 * The states in which Lead or Human has decided an assignment. The runtime's domain, the room's
 * counts and the panel's Open / Finished split all read this one list.
 */
export const SETTLED_STATES = ['accepted', 'rejected', 'abandoned'] as const;
export type SettledState = (typeof SETTLED_STATES)[number];
