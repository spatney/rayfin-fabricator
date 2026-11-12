//! Attributes the Rayfin CLI's telemetry to Fabricator.
//!
//! The Rayfin CLI and `create-rayfin` label each command's telemetry with the
//! kind of host it ran in (GitHub Actions, a dev container, ...), or with the
//! label a host sets in `RAYFIN_TELEMETRY_ENV`. [`init`] sets Fabricator's at
//! startup, in its own environment, so every process it starts inherits it:
//! sign-ins, publishes, new projects, chat's commands and the local backends.
//! It replaces a label Fabricator was launched with, so all of them count as
//! Fabricator's. It's only a label: the CLI's opt-out still applies.
//!
//! Programs Fabricator opens for the user rather than runs itself, VS Code,
//! sign-in terminals and the project terminal's shells, get the label
//! Fabricator was launched with instead ([`for_user_program`],
//! [`for_user_shell`]): the commands the user runs there aren't Fabricator's.

use std::ffi::{OsStr, OsString};
use std::process::Command;

use once_cell::sync::OnceCell;

/// The variable the Rayfin CLI and `create-rayfin` read the host's label from.
pub const ENV: &str = "RAYFIN_TELEMETRY_ENV";
/// Fabricator's label. The CLI keeps a custom label of letters, digits, `-` and `_`.
pub const LABEL: &str = "fabricator";

/// The label Fabricator was launched with, for the programs it opens for the user.
static INHERITED: OnceCell<Option<OsString>> = OnceCell::new();

/// Once at startup, before anything starts the Rayfin CLI.
pub fn init() {
  let _ = INHERITED.set(users_label(std::env::var_os(ENV)));
  std::env::set_var(ENV, LABEL);
}

/// The label Fabricator was launched with, unless it's Fabricator's own: a
/// restart, or an update, starts the next Fabricator with this one's environment.
fn users_label(inherited: Option<OsString>) -> Option<OsString> {
  inherited.filter(|label| label != LABEL)
}

/// Start a program Fabricator opens for the user, such as VS Code, with the
/// label Fabricator was launched with rather than Fabricator's.
pub fn for_user_program(cmd: &mut Command) -> &mut Command {
  with_label(cmd, INHERITED.get().and_then(Option::as_deref))
}

/// The label for a shell the user runs, such as the project terminal's: the one
/// Fabricator was launched with (`None`: unset), as [`for_user_program`] gives it.
pub fn for_user_shell() -> (&'static str, Option<OsString>) {
  (ENV, INHERITED.get().cloned().flatten())
}

fn with_label<'a>(cmd: &'a mut Command, label: Option<&OsStr>) -> &'a mut Command {
  match label {
    Some(label) => cmd.env(ENV, label),
    None => cmd.env_remove(ENV),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn programs_opened_for_the_user_get_the_label_fabricator_was_launched_with() {
    let opened = |launched_with: Option<&str>| {
      let mut cmd = Command::new("code");
      with_label(&mut cmd, users_label(launched_with.map(OsString::from)).as_deref());
      cmd.get_envs().map(|(k, v)| (k.to_owned(), v.map(OsStr::to_owned))).collect::<Vec<_>>()
    };
    let label = |value: Option<&str>| vec![(OsString::from(ENV), value.map(OsString::from))];
    assert_eq!(opened(Some("contoso-lab")), label(Some("contoso-lab")));
    // Without one of the user's own, none, so the CLI detects the host as usual.
    // Fabricator's own label, which a restart passes on, isn't the user's.
    assert_eq!(opened(None), label(None));
    assert_eq!(opened(Some(LABEL)), label(None));
  }
}
