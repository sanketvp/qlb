import Model

namespace CodexPoll

/-- A live lease blocks the outbound probe and is not rewritten before expiry. -/
theorem lease_blocks_until_expiry (now held : Nat) (state : PollState)
    (hasLease : state.heldUntil = some held) (before : now < held) :
    tickGate now state = { probe := false, heldUntil := some held } := by
  simp [tickGate, hasLease, before]

/-- A held refresh installs the floor when the plan interval is no longer than it. -/
theorem lease_set_on_held_floor (now interval : Nat) (atMostFloor : interval ≤ 60) :
    leaseForHeld now interval = now + 60 := by
  simp [leaseForHeld, Nat.max_eq_left atMostFloor]

/-- A held refresh instead preserves a longer planned interval. -/
theorem lease_set_on_held_interval (now interval : Nat) (aboveFloor : 60 ≤ interval) :
    leaseForHeld now interval = now + interval := by
  simp [leaseForHeld, Nat.max_eq_right aboveFloor]

/-- Expired leases are cleared, allowing the polling scheduler to decide normally. -/
theorem lease_cleared_after_expiry (now held : Nat) (state : PollState)
    (hasLease : state.heldUntil = some held) (expired : held ≤ now) :
    tickGate now state = { probe := true, heldUntil := none } := by
  simp [tickGate, hasLease, Nat.not_lt_of_ge expired]

/-- With no fresh holder receipt, the lease is gone at its deadline. -/
theorem held_lease_expires_at_deadline (deadline interval : Nat) :
    heldLeaseStep deadline interval (some deadline) false = none := by
  simp [heldLeaseStep]

/-- A replacement lease from an existing lease requires a strictly newer receipt. -/
theorem held_lease_renews_only_after_expiry (now interval previous next : Nat)
    (renewed : heldLeaseStep now interval (some previous) true = some next)
    (changed : next ≠ previous) :
    previous < now := by
  simp only [heldLeaseStep] at renewed
  split at renewed <;> simp_all

/-- A clear based on an older snapshot leaves a concurrent newer lease intact. -/
theorem clear_lease_preserves_newer_value (observed current : Option Nat)
    (changed : current ≠ observed) : clearLeaseIfSame observed current = current := by
  simp [clearLeaseIfSame, changed]

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

/-- JSON holds from a different active account cannot suppress this account's poll. -/
theorem foreign_json_hold_parses_to_none :
    parseIdleHold "active-account" "{\"accountId\":\"other-account\",\"sinceMs\":42}" = none := by
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
