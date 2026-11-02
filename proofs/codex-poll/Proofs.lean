import Model

namespace CodexPoll

/-- A live lease blocks the outbound probe and is not rewritten before expiry. -/
theorem lease_blocks_until_expiry (now held : Nat) (state : PollState)
    (hasLease : state.heldUntil = some held) (before : now < held) :
    tickGate now state = { probe := false, heldUntil := some held } := by
  simp [tickGate, hasLease, before]

/-- A held refresh installs at least a 60-second lease. -/
theorem lease_set_on_held (now interval : Nat) :
    leaseForHeld now interval = now + max 60 interval := by
  rfl

/-- Expired leases are cleared, allowing the polling scheduler to decide normally. -/
theorem lease_cleared_after_expiry (now held : Nat) (state : PollState)
    (hasLease : state.heldUntil = some held) (expired : held ≤ now) :
    tickGate now state = { probe := true, heldUntil := none } := by
  simp [tickGate, hasLease, Nat.not_lt_of_ge expired]

/-- A Codex holder receipt is coordination metadata rather than a failed fetch. -/
theorem codex_won_preserves_failures_backoff_readings (attemptedAt : Nat) (state : PollState) :
    (recordResult attemptedAt .codexWon state).failures = state.failures ∧
    (recordResult attemptedAt .codexWon state).backoffUntil = state.backoffUntil ∧
    (recordResult attemptedAt .codexWon state).readings = state.readings := by
  simp [recordResult]

/-- A genuine failed fetch advances the consecutive-failure count exactly once. -/
theorem failure_increments (attemptedAt : Nat) (state : PollState) :
    (recordResult attemptedAt .failure state).failures = state.failures + 1 := by
  rfl

/-- Core-only string reduction proves the canonical serialized fixture form. -/
theorem parse_serialise_roundtrip :
    parseIdleHold "active-account" "{\"accountId\":\"active-account\",\"sinceMs\":123}" =
      some { accountId := "active-account", sinceMs := 123 } := by
  decide

/-- Legacy decimal values attach to the active account. -/
theorem legacy_numeric_parses_to_active_hold :
    parseIdleHold "active-account" "42" = some { accountId := "active-account", sinceMs := 42 } := by
  decide

/-- Empty configuration and non-decimal garbage have no idle hold meaning. -/
theorem garbage_parses_to_none_empty : parseIdleHold "active-account" "" = none := by
  decide

theorem garbage_parses_to_none_nondigit : parseIdleHold "active-account" "not-a-number" = none := by
  decide

end CodexPoll
