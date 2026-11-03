import Model
import Proofs

open CodexPoll

private def boolJson (value : Bool) : String := if value then "true" else "false"
private def natOptionJson : Option Nat → String
  | none => "null"
  | some value => toString value
private def readingsJson (value : ReadingsTag) : String := boolJson value.present
private def escape (value : String) : String := value.replace "\\" "\\\\" |>.replace "\"" "\\\""
private def holdJson : Option IdleHold → String
  | none => "null"
  | some hold => "{\"accountId\":\"" ++ escape hold.accountId ++ "\",\"sinceMs\":" ++ toString hold.sinceMs ++ "}"

private def stateJson (state : PollState) : String :=
  "{\"failures\":" ++ toString state.failures ++ ",\"backoffUntil\":" ++ natOptionJson state.backoffUntil ++
  ",\"readings\":" ++ readingsJson state.readings ++ ",\"lastStatus\":\"" ++ escape state.lastStatus ++
  "\",\"lastAttemptAt\":" ++ toString state.lastAttemptAt ++ "}"

/-- Held refresh cases alternate between the 60-second floor and a longer plan. -/
private def r1Case (index : Nat) : String :=
  let now := 1_700_000_000 + index * 17
  let interval := if index % 20 = 0 then 15 + index % 45 else 61 + index % 700
  if index % 10 = 0 then
    let expected := leaseForHeld now interval
    "{\"rule\":\"r1\",\"input\":{\"kind\":\"held\",\"now\":" ++ toString now ++
      ",\"heldUntil\":null,\"interval\":" ++ toString interval ++ "},\"expected\":{\"probe\":false,\"heldUntil\":" ++ toString expected ++ "}}"
  else
    let held := (match index % 3 with
      | 0 => now + 1
      | 1 => now
      | _ => now - 1)
    let state : PollState := {
      heldUntil := some held
      failures := 0
      backoffUntil := none
      readings := { present := false }
      lastStatus := ""
      lastAttemptAt := 0
    }
    let expected := tickGate now state
    "{\"rule\":\"r1\",\"input\":{\"kind\":\"tick\",\"now\":" ++ toString now ++
      ",\"heldUntil\":" ++ toString held ++ ",\"interval\":" ++ toString interval ++
      "},\"expected\":{\"probe\":" ++ boolJson expected.probe ++ ",\"heldUntil\":" ++ natOptionJson expected.heldUntil ++ "}}"

/-- Six neighboring cases enumerate each result/readings combination per failure count. -/
private def r4StepJson (now : Nat) (held : Bool) : String :=
  "{\"now\":" ++ toString now ++ ",\"held\":" ++ boolJson held ++ "}"

/-- Multi-tick lease traces cover stale holder receipts, expiry, and post-expiry renewal. -/
private def r4Case (index : Nat) : String :=
  let start := 1_710_000_000 + index * 101
  let interval := if index % 2 = 0 then 15 + index % 45 else 61 + index % 120
  let initial := leaseForHeld start interval
  let stale := heldLeaseStep (start + 1) interval (some initial) true
  let expired := heldLeaseStep initial interval stale false
  let renew := heldLeaseStep (initial + 1) interval expired true
  let steps := if index % 2 = 0 then
    [r4StepJson (start + 1) true, r4StepJson initial false]
  else
    [r4StepJson (start + 1) true, r4StepJson initial false, r4StepJson (initial + 1) true]
  let expected := if index % 2 = 0 then expired else renew
  "{\"rule\":\"r4\",\"input\":{\"initialHeldUntil\":" ++ toString initial ++
    ",\"interval\":" ++ toString interval ++ ",\"steps\":[" ++ String.intercalate "," steps ++
    "]},\"expected\":{\"heldUntil\":" ++ natOptionJson expected ++ "}}"

private def r2Case (index : Nat) : String :=
  let failures := index / 6
  let hasReadings := (index / 3) % 2 = 0
  let seedAt := 20_000 + index * 20
  let priorAttempt := if failures = 0 then seedAt else seedAt + failures
  let priorBackoff := if failures = 0 then none else some (priorAttempt + failureBackoff failures)
  let attempted := seedAt + 100
  let kind := (match index % 3 with | 0 => ResultKind.codexWon | 1 => ResultKind.failure | _ => ResultKind.success)
  let kindText := (match kind with | .codexWon => "codex-won" | .failure => "failure" | .success => "success")
  let state : PollState := {
    heldUntil := none
    failures := failures
    backoffUntil := priorBackoff
    readings := { present := hasReadings }
    lastStatus := "seed"
    lastAttemptAt := priorAttempt
  }
  let expected := recordResult attempted kind state
  "{\"rule\":\"r2\",\"input\":{\"kind\":\"" ++ kindText ++ "\",\"failures\":" ++ toString failures ++
    ",\"readings\":" ++ boolJson hasReadings ++ ",\"seedAt\":" ++ toString seedAt ++
    ",\"attemptedAt\":" ++ toString attempted ++ "},\"expected\":" ++ stateJson expected ++ "}"

private def r3Raw (index : Nat) (active : String) : String :=
  match index % 7 with
  | 0 => serialiseIdleHold {
    accountId := active
    sinceMs := 1_700_000_000_000 + index
  }
  | 1 => toString (index * 99991 + 7)
  | 2 => ""
  | 3 => "not-a-number"
  | 4 => "garbage"
  | 5 => "999999999999999"
  | _ => serialiseIdleHold {
    accountId := "other-user:other-account"
    sinceMs := 1_700_000_000_000 + index
  }

private def r3Case (index : Nat) : String :=
  let active := "fixture-user:fixture-account"
  let raw := r3Raw index active
  let expected := parseIdleHold active raw
  "{\"rule\":\"r3\",\"input\":{\"activeAccount\":\"" ++ active ++ "\",\"raw\":\"" ++ escape raw ++
    "\"},\"expected\":{\"parsed\":" ++ holdJson expected ++ "}}"

private def cases : List String :=
  (List.range 800).map r1Case ++ (List.range 600).map r2Case ++ (List.range 600).map r3Case ++ (List.range 80).map r4Case

private def fixture : String := "[\n" ++ String.intercalate ",\n" cases ++ "\n]\n"

def main (args : List String) : IO UInt32 := do
  let output := args.getD 0 "../../test/fixtures/codex-poll-model-cases.json"
  IO.FS.writeFile output fixture
  IO.println s!"generated {cases.length} fixed-seed cases"
  return 0
