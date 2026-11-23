import Model

namespace CodexStopLatch

/-- While latched, no switch (manual or automatic) and no refresh is admitted, whatever the flag. -/
theorem latched_refuses_switch_and_refresh (state : State) (newest : Nat) (unknown flag manual : Bool)
    (latched : state.latch = .latched newest) :
    admit state unknown flag (.switch manual) = some .stopLatched ∧
    admit state unknown flag .refresh = some .stopLatched := by
  simp [admit, isLatched, latched]

/-- An unreadable log refuses switches and refreshes the same way. -/
theorem unknown_refuses_switch_and_refresh (state : State) (flag manual : Bool) :
    admit state true flag (.switch manual) = some .stopLatched ∧
    admit state true flag .refresh = some .stopLatched := by
  simp [admit]

/-- Import, adoption and stash are admitted in every state. -/
theorem other_always_admitted (state : State) (unknown flag : Bool) :
    admit state unknown flag .other = none := by
  simp [admit]

/-- Only a clear through the newest stop leaves the latched state. -/
theorem only_clear_leaves_latched (newest : Nat) (event : Event)
    (left : ∀ id, latchStep (.latched newest) event ≠ .latched id) :
    event = .clear newest := by
  cases event with
  | stageStart stage => exact absurd rfl (left newest)
  | stageClose stage passed => exact absurd rfl (left newest)
  | stop id => exact absurd rfl (left id)
  | ignored => exact absurd rfl (left newest)
  | clear throughId =>
    by_cases same : throughId = newest
    · rw [same]
    · exact absurd (by simp [latchStep, same]) (left newest)

/-- A clear naming an older stop leaves the latch set. -/
theorem stale_clear_keeps_latched (newest throughId : Nat) (older : throughId ≠ newest) :
    latchStep (.latched newest) (.clear throughId) = .latched newest := by
  simp [latchStep, older]

/-- A clear is refused when a newer stop exists, a watch is open, or a fence is set. -/
theorem clear_refused_newer_stop (newest throughId : Nat) (openWatch fenceSet : Bool) (older : throughId ≠ newest) :
    decideClear (.latched newest) false throughId openWatch fenceSet false = some (.newerStop newest) := by
  simp [decideClear, older]

theorem clear_refused_open_watch (newest : Nat) (fenceSet : Bool) :
    decideClear (.latched newest) false newest true fenceSet false = some .openWatch := by
  simp [decideClear]

theorem clear_refused_fence_set (newest : Nat) :
    decideClear (.latched newest) false newest false true false = some .fenceSet := by
  simp [decideClear]

/-- A clear the decision admits, when recorded, returns the latch to armed. -/
theorem admitted_clear_arms (newest throughId : Nat) (openWatch fenceSet : Bool)
    (ok : decideClear (.latched newest) false throughId openWatch fenceSet false = none) :
    latchStep (.latched newest) (.clear throughId) = .armed := by
  by_cases same : throughId = newest
  · simp [latchStep, same]
  · simp [decideClear, same] at ok

/-- After a clear no stage run is active, so automatic switching waits for the next stage start. -/
theorem clear_ends_stage_run (state : State) (throughId : Nat) :
    (step state (.clear throughId)).autoAllowed = false := by
  simp [step, autoStep]

/-- An ignored row (`initialize`) never changes the latch or the run. -/
theorem ignored_changes_nothing (state : State) :
    step state .ignored = state := by
  cases state with
  | mk latch autoAllowed => cases latch <;> simp [step, latchStep, autoStep]

/-- A stop also ends the run, and latches. -/
theorem stop_latches_and_ends_run (state : State) (id : Nat) :
    step state (.stop id) = { latch := .latched id, autoAllowed := false } := by
  simp [step, latchStep, autoStep]

/-- An automatic switch needs the flag, a readable armed latch, and an automatic-switching stage. -/
theorem auto_switch_admitted_iff (state : State) (unknown flag : Bool) :
    admit state unknown flag (.switch false) = none ↔
      (unknown = false ∧ (∀ newest, state.latch ≠ .latched newest) ∧ flag = true ∧ state.autoAllowed = true) := by
  cases state with
  | mk latch autoAllowed =>
    cases latch <;> cases unknown <;> cases flag <;> cases autoAllowed <;> simp [admit, isLatched]

end CodexStopLatch
