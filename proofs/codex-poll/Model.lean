/-
Executable coordination model for src/auto/openai-codex.ts and src/store.ts.
Times are seconds, matching usage_polls.held_until.
-/

namespace CodexPoll

structure ReadingsTag where
  present : Bool
  deriving Repr, DecidableEq

structure PollState where
  heldUntil : Option Nat
  failures : Nat
  backoffUntil : Option Nat
  readings : ReadingsTag
  lastStatus : String
  lastAttemptAt : Nat
  deriving Repr, DecidableEq

structure TickResult where
  probe : Bool
  heldUntil : Option Nat
  deriving Repr, DecidableEq

/-- Models `pollOpenAiCodex`: a live renewer lease owns polling strictly before expiry. -/
def tickGate (now : Nat) (state : PollState) : TickResult :=
  match state.heldUntil with
  | some held => if now < held then { probe := false, heldUntil := some held }
                 else { probe := true, heldUntil := none }
  | none => { probe := true, heldUntil := none }

/-- Models the `refresh.status === 'held'` arm in `pollOpenAiCodex`. -/
def leaseForHeld (now interval : Nat) : Nat := now + max 60 interval

inductive ResultKind where
  | codexWon | failure | success
  deriving Repr, DecidableEq

/-- Same capped exponential backoff used by Store.recordUsagePollResult without Retry-After. -/
def failureBackoff (failures : Nat) : Nat :=
  min (30 * 2 ^ min (failures - 1) 32) 600

/-- Models Store.recordUsagePollResult's coordination, failure, and readings branches. -/
def recordResult (attemptedAt : Nat) (kind : ResultKind) (state : PollState) : PollState :=
  match kind with
  | .codexWon => { state with lastAttemptAt := attemptedAt, lastStatus := "codex-won" }
  | .failure => { state with
      failures := state.failures + 1
      backoffUntil := some (attemptedAt + failureBackoff (state.failures + 1))
      lastAttemptAt := attemptedAt
      lastStatus := "failure" }
  | .success => { state with
      failures := 0
      backoffUntil := none
      readings := { present := true }
      lastAttemptAt := attemptedAt
      lastStatus := "ok" }

structure IdleHold where
  accountId : String
  sinceMs : Nat
  deriving Repr, DecidableEq

/-- The production writer's compact JSON representation (account identifiers in fixtures are ASCII). -/
def serialiseIdleHold (hold : IdleHold) : String :=
  "{\"accountId\":\"" ++ hold.accountId ++ "\",\"sinceMs\":" ++ toString hold.sinceMs ++ "}"

private def digitValue (c : Char) : Option Nat :=
  if c = '0' then some 0 else if c = '1' then some 1 else if c = '2' then some 2 else
  if c = '3' then some 3 else if c = '4' then some 4 else if c = '5' then some 5 else
  if c = '6' then some 6 else if c = '7' then some 7 else if c = '8' then some 8 else
  if c = '9' then some 9 else none

private def digitsToNat : List Char → Nat → Option Nat
  | [], value => some value
  | c :: rest, value => match digitValue c with
    | none => none
    | some digit => digitsToNat rest (value * 10 + digit)

/-- Deliberately accepts non-empty decimal integers only (not signs, fractions, or whitespace). -/
def parseNatural (value : String) : Option Nat :=
  match value.toList with
  | [] => none
  | chars => digitsToNat chars 0

private def afterPrefix (wanted : List Char) : List Char → Option (List Char)
  | value => if wanted.isPrefixOf value then some (value.drop wanted.length) else none

private def takeUntilQuote : List Char → List Char → Option (List Char × List Char)
  | [], _ => none
  | '"' :: rest, collected => some (collected.reverse, rest)
  | c :: rest, collected => takeUntilQuote rest (c :: collected)

private def parseJsonHold (raw : String) : Option IdleHold := do
  let accountPrefix : List Char := ['{', '"', 'a', 'c', 'c', 'o', 'u', 'n', 't', 'I', 'd', '"', ':', '"']
  let sincePrefix : List Char := [',', '"', 's', 'i', 'n', 'c', 'e', 'M', 's', '"', ':']
  let afterAccount ← afterPrefix accountPrefix raw.toList
  let (account, afterAccount) ← takeUntilQuote afterAccount []
  let afterSince ← afterPrefix sincePrefix afterAccount
  let reversedDigits ← match afterSince.reverse with
    | '}' :: rest => some rest.reverse
    | _ => none
  let since ← parseNatural (String.ofList reversedDigits)
  return { accountId := String.ofList account, sinceMs := since }

/-- Models idleHold in `pollOpenAiCodex`: JSON first, then a legacy integer for the active account. -/
def parseIdleHold (activeAccount : String) (raw : String) : Option IdleHold :=
  match parseJsonHold raw with
  | some hold => some hold
  | none => match parseNatural raw with
    | some since => some { accountId := activeAccount, sinceMs := since }
    | none => none

end CodexPoll
