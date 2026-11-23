/-
Executable model of the Codex stop latch in src/codex-stage.ts:
`latchStep`, `deriveLatch`, `admitCodexAction` and `decideLatchClear`.
The generated cases replay through those functions, which is the tie between
this model and the shipped code.
-/

namespace CodexStopLatch

/-- `latched` carries the newest stop's row id; a clear must name it. -/
inductive Latch where
  | unarmed
  | armed
  | latched (newest : Nat)
  deriving Repr, DecidableEq

/-- One `codex_stage_events` row as the latch sees it. A stop is a latch-set row with its own id. -/
inductive Event where
  | stageStart (stage : Nat)
  | stageClose (stage : Nat) (passed : Bool)
  | stop (id : Nat)
  | clear (throughId : Nat)
  /-- A row the latch and the run ignore: `initialize` (and `initialize-required`, which the store reads as unknown). -/
  | ignored
  deriving Repr, DecidableEq

structure State where
  latch : Latch
  /-- Automatic switching is in scope: a Stage 2 run is open, or Stage 2 closed passed. -/
  autoAllowed : Bool
  deriving Repr, DecidableEq

def initial : State := { latch := .unarmed, autoAllowed := false }

/-- Models `latchStep`. A clear not through the newest stop changes nothing. -/
def latchStep : Latch → Event → Latch
  | .unarmed, .stageStart _ => .armed
  | .unarmed, .stageClose _ _ => .armed
  | current, .stageStart _ => current
  | current, .stageClose _ _ => current
  | current, .ignored => current
  | _, .stop id => .latched id
  | .latched newest, .clear throughId => if throughId = newest then .armed else .latched newest
  | current, .clear _ => current

/-- Models `automaticSwitchingAllowed`: a stop or any clear ends the run; an ignored row changes nothing. -/
def autoStep (allowed : Bool) : Event → Bool
  | .stageStart stage => stage == 2
  | .stageClose stage passed => stage == 2 && passed
  | .stop _ => false
  | .clear _ => false
  | .ignored => allowed

def step (state : State) (event : Event) : State :=
  { latch := latchStep state.latch event, autoAllowed := autoStep state.autoAllowed event }

/-- Models `deriveLatch` over a readable log. -/
def run (events : List Event) : State := events.foldl step initial

inductive Action where
  | switch (manual : Bool)
  | refresh
  /-- Import, adoption and stash: they never reach the refresh transport. -/
  | other
  deriving Repr, DecidableEq

inductive Refusal where
  | stopLatched
  | switchDisabled
  | autoOutsideStage2
  deriving Repr, DecidableEq

def isLatched : Latch → Bool
  | .latched _ => true
  | _ => false

/--
Models `admitCodexAction`; `none` is admitted. `unknown` is an unreadable
log (missing tables, an unreadable row, or initialize-required), which reads
as latched.
-/
def admit (state : State) (unknown : Bool) (flagEnabled : Bool) (action : Action) : Option Refusal :=
  match action with
  | .other => none
  | .refresh => if unknown || isLatched state.latch then some .stopLatched else none
  | .switch manual =>
    if unknown || isLatched state.latch then some .stopLatched
    else if !flagEnabled then some .switchDisabled
    else if manual then none
    else if state.autoAllowed then none
    else some .autoOutsideStage2

inductive ClearRefusal where
  | emptyReason
  | latchUnknown
  | notLatched
  | newerStop (newest : Nat)
  | openWatch
  | fenceSet
  deriving Repr, DecidableEq

/-- Models `decideLatchClear`; `none` is a clear that may be recorded. The refusal order is the shipped one. -/
def decideClear (latch : Latch) (unknown : Bool) (throughId : Nat)
    (openWatch fenceSet reasonEmpty : Bool) : Option ClearRefusal :=
  if reasonEmpty then some .emptyReason
  else if unknown then some .latchUnknown
  else match latch with
    | .latched newest =>
      if throughId ≠ newest then some (.newerStop newest)
      else if openWatch then some .openWatch
      else if fenceSet then some .fenceSet
      else none
    | _ => some .notLatched

end CodexStopLatch
