import Lake
open Lake DSL

package "codex-stop-latch" where
  version := v!"0.1.0"

lean_lib "Model" where
  roots := #[`Model, `Proofs]

@[default_target]
lean_exe "gen" where
  root := `Gen
