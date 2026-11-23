import Model
import Proofs

open CodexStopLatch

/-
Fixed cases for test/codex-stop-latch-model.test.ts. Every trace of up to
three stage events is enumerated; event row ids are their 1-based positions,
so a stop's id is its own row id, as a latch-set row's is.
-/

/-- Event templates; a clear's target is resolved against the stops before it. -/
inductive Template where
  | start1 | start2 | close1 | close2Pass | close2Fail | stop | clearNewest | clearFirst
  deriving Repr, DecidableEq

private def templates : List Template :=
  [.start1, .start2, .close1, .close2Pass, .close2Fail, .stop, .clearNewest, .clearFirst]

/-- The newest stop id among the events so far, or 0 when there is none (no row has id 0). -/
private def newestStop (events : List Event) : Nat :=
  events.foldl (fun newest event => match event with | .stop id => id | _ => newest) 0

private def resolve (events : List Event) (template : Template) : Event :=
  let id := events.length + 1
  match template with
  | .start1 => .stageStart 1
  | .start2 => .stageStart 2
  | .close1 => .stageClose 1 true
  | .close2Pass => .stageClose 2 true
  | .close2Fail => .stageClose 2 false
  | .stop => .stop id
  | .clearNewest => .clear (newestStop events)
  | .clearFirst => .clear 1

private def build (picks : List Template) : List Event :=
  picks.foldl (fun events template => events ++ [resolve events template]) []

/-- Every list of templates of length at most `n`, shortest first. -/
private def picksUpTo : Nat → List (List Template)
  | 0 => [[]]
  | n + 1 =>
    let shorter := picksUpTo n
    shorter ++ (shorter.filter (·.length = n)).flatMap (fun picks => templates.map (picks ++ [·]))

private def eventJson : Event → String
  | .stageStart stage => "{\"kind\":\"stage-start\",\"stage\":" ++ toString stage ++ "}"
  | .stageClose stage passed => "{\"kind\":\"stage-close\",\"stage\":" ++ toString stage ++ ",\"passed\":" ++ (if passed then "true" else "false") ++ "}"
  | .stop _ => "{\"kind\":\"stop\"}"
  | .clear throughId => "{\"kind\":\"clear\",\"throughId\":" ++ toString throughId ++ "}"

private def latchViewJson (unknown : Bool) (latch : Latch) : String :=
  if unknown then "{\"state\":\"unknown\"}"
  else match latch with
    | .unarmed => "{\"state\":\"unarmed\"}"
    | .armed => "{\"state\":\"armed\"}"
    | .latched newest => "{\"state\":\"latched\",\"newestStopId\":" ++ toString newest ++ "}"

private def refusalJson : Option Refusal → String
  | none => "null"
  | some .stopLatched => "\"codex-stop-latched\""
  | some .switchDisabled => "\"codex-switch-disabled\""
  | some .autoOutsideStage2 => "\"codex-auto-outside-stage-2\""

private def admissionJson (state : State) (unknown : Bool) : String :=
  let entry := fun (name : String) (flag : Bool) (action : Action) =>
    "\"" ++ name ++ "\":" ++ refusalJson (admit state unknown flag action)
  "{" ++ String.intercalate "," [
    entry "manualOn" true (.switch true), entry "autoOn" true (.switch false),
    entry "refreshOn" true .refresh, entry "otherOn" true .other,
    entry "manualOff" false (.switch true), entry "autoOff" false (.switch false),
    entry "refreshOff" false .refresh, entry "otherOff" false .other] ++ "}"

private def traceCase (index : Nat) (picks : List Template) : String :=
  let events := build picks
  -- Every seventh trace is also replayed as an unreadable log.
  let unknown := index % 7 = 3
  let state := run events
  "{\"rule\":\"trace\",\"input\":{\"events\":[" ++ String.intercalate "," (events.map eventJson) ++
    "],\"unknown\":" ++ (if unknown then "true" else "false") ++ "},\"expected\":{\"latch\":" ++
    latchViewJson unknown state.latch ++ ",\"admission\":" ++ admissionJson state unknown ++ "}}"

private def clearRefusalJson : Option ClearRefusal → String
  | none => "null"
  | some .emptyReason => "{\"refusal\":\"empty-reason\"}"
  | some .latchUnknown => "{\"refusal\":\"latch-unknown\"}"
  | some .notLatched => "{\"refusal\":\"not-latched\"}"
  | some (.newerStop newest) => "{\"refusal\":\"newer-stop\",\"newestStopId\":" ++ toString newest ++ "}"
  | some .openWatch => "{\"refusal\":\"open-watch\"}"
  | some .fenceSet => "{\"refusal\":\"fence-set\"}"

private def bools : List Bool := [false, true]

private def clearCases : List String :=
  [Latch.unarmed, .armed, .latched 3].flatMap fun latch =>
  bools.flatMap fun unknown =>
  [3, 2].flatMap fun throughId =>
  bools.flatMap fun openWatch =>
  bools.flatMap fun fenceSet =>
  bools.map fun reasonEmpty =>
    "{\"rule\":\"clear\",\"input\":{\"latch\":" ++ latchViewJson unknown latch ++ ",\"throughId\":" ++ toString throughId ++
      ",\"openWatch\":" ++ (if openWatch then "true" else "false") ++ ",\"fenceSet\":" ++ (if fenceSet then "true" else "false") ++
      ",\"reasonEmpty\":" ++ (if reasonEmpty then "true" else "false") ++ "},\"expected\":" ++
      clearRefusalJson (decideClear latch unknown throughId openWatch fenceSet reasonEmpty) ++ "}"

private def traceCases : List String :=
  ((picksUpTo 3).zip (List.range (picksUpTo 3).length)).map fun (picks, index) => traceCase index picks

private def cases : List String := traceCases ++ clearCases

private def fixture : String := "[\n" ++ String.intercalate ",\n" cases ++ "\n]\n"

def main (args : List String) : IO UInt32 := do
  let output := args.getD 0 "../../test/fixtures/codex-stop-latch-model-cases.json"
  IO.FS.writeFile output fixture
  IO.println s!"generated {cases.length} fixed cases"
  return 0
