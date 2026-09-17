## Moving Write Ownership

Lead owns decomposition and moving write-scope assignment: give each moving scope
exactly one owner, with at most one active writable Peer across the project at a time.
Lead must not edit a scope concurrently with its writing Peer.

Before transferring write ownership, stop the prior writer and establish a stable
handoff. Read-only review does not create another writer.
