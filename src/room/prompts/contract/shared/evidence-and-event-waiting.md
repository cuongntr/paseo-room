## Evidence and Event-Driven Waiting

Use tests, artifacts, lifecycle states, and completion/error/attention events as
evidence, not as automatic authorization or acceptance.

Wait for state-changing events when progress depends on another actor. Do not
repeatedly poll unchanged state; resume when new evidence or a relevant event arrives.
