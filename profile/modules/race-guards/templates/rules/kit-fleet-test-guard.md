- TESTS NEVER TOUCH LIVE STATE. The test suite's conftest installs the guard: a
  suite that changes a live control, inbox or outbox file fails, and runtime roots
  point at the test's temporary directory.
