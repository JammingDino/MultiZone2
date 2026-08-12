-- Live task state (0.12.1) — intervening in a run without ending it.
--
-- Cancelling a turn is the only control the app has ever offered over work in
-- flight, and it is a blunt one: everything the agent has done so far stays,
-- everything it was about to do is lost, and the only way to change one step is
-- to throw away the other nine. Striking and adding steps needs no schema (the
-- steps blob is rewritten), but "finish what you are doing and then stop" does:
-- it is a request that has to survive until the loop reaches a step boundary and
-- can honour it.

ALTER TABLE plans ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;
