//! Several Microsoft Fabric and Azure CLI accounts on one computer: list them,
//! add one, choose the one Fabricator uses, and sign one out. (GitHub accounts
//! live with the rest of the GitHub CLI integration in `commands::github`.)
//!
//! Azure: the Azure CLI keeps every account it signs in to. Its current account
//! — the one its default subscription belongs to — is the one Fabricator and the
//! terminal use. Fabric: each account is a Rayfin CLI config folder; see
//! `services::fabric_accounts`.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::auth::{self, AZ_AUTH_ACTION, RAYFIN_AUTH_ACTION};
use crate::services::emit::proc_streamer;
use crate::services::exec::{self, OnData, RunOptions, Stream};
use crate::services::fabric_accounts as fabric;
use crate::types::{AzureAccount, AzureAccountsResult, FabricAccountsResult, ProcResult};

static GUID_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$").unwrap()
});
static DOMAIN_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$").unwrap()
});
/// An Azure CLI account name safe to pass as an argument (the CLI is a batch
/// script on Windows): a sign-in name, or a service principal's app id.
static AZ_USER_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"^[A-Za-z0-9._+#'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$").unwrap());

const FABRIC_BUSY: &str = "A Fabric sign-in, sign-out, or account change is already in progress.";
const AZURE_BUSY: &str = "An Azure sign-in, sign-out, or account change is already in progress.";
/// Signing in to Azure on demand, from a feature that needs it, before the
/// optional Azure CLI is installed.
const AZURE_MISSING: &str =
  "The Azure CLI isn't installed, so Fabricator can't sign you in to Azure. Install it from setup (open Settings and select Open setup), then try again.";

fn done(exit_code: Option<i32>) -> ProcResult {
  ProcResult { ok: true, exit_code, error: None }
}

/// An optional organization to sign in to: a tenant id or a domain.
pub(crate) fn checked_tenant(tenant: Option<String>) -> Result<Option<String>, String> {
  let Some(tenant) = tenant.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) else {
    return Ok(None);
  };
  if GUID_RE.is_match(&tenant) || DOMAIN_RE.is_match(&tenant) {
    Ok(Some(tenant))
  } else {
    Err("Enter the organization as a tenant ID or a domain, such as contoso.onmicrosoft.com.".into())
  }
}

fn safe_az_user(user: &str) -> bool {
  AZ_USER_RE.is_match(user) || GUID_RE.is_match(user)
}

/* --------------------------------- Fabric --------------------------------- */

/// Every Fabric account signed in on this computer, the one in use first.
#[tauri::command]
pub async fn fabric_accounts() -> FabricAccountsResult {
  FabricAccountsResult { accounts: fabric::list(), shared_token_store: fabric::SHARED_TOKEN_STORE }
}

/// Sign in to another Fabric account and use it. The first account signs in to
/// the Rayfin CLI's own folder; each one after it gets a folder of its own.
/// `tenant` (an id or domain) picks the organization. Streams on `login:rayfin`.
#[tauri::command]
pub async fn fabric_add_account(app: AppHandle, tenant: Option<String>, project_id: Option<String>) -> ProcResult {
  let tenant = match checked_tenant(tenant) {
    Ok(tenant) => tenant,
    Err(error) => return auth::auth_failure("fabric-add-account", None, error),
  };
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth::auth_failure("fabric-add-account", None, FABRIC_BUSY.into());
  };
  let project_dir = match auth::rayfin_project_dir(project_id.as_deref()) {
    Ok(dir) => dir,
    Err(error) => return auth::auth_failure("fabric-add-account", None, error),
  };
  let on_data = proc_streamer(&app, "login:rayfin");
  let _access = auth::rayfin_auth_write().await;
  let previous = fabric::active_id();
  let id = if fabric::identity(&fabric::shared_dir()).is_none() {
    fabric::SHARED.to_string()
  } else {
    match fabric::create() {
      Ok(id) => id,
      Err(error) => return auth::auth_failure("fabric-add-account", None, error),
    }
  };
  if let Err(error) = fabric::activate(&id) {
    let _ = fabric::remove(&id);
    return auth::auth_failure("fabric-add-account", None, error);
  }
  auth::forget_identity();
  let result = auth::login_rayfin(project_dir.as_deref(), tenant, on_data.clone()).await;
  if !result.ok {
    // Keep using the account that was in use, and drop the new, empty folder.
    let _ = fabric::remove(&id);
    let _ = fabric::activate(&previous);
    auth::forget_identity();
    return result;
  }
  if let Some(existing) = fabric::duplicate_of(&id) {
    // That account was already signed in here: keep one folder for it,
    // preferring the CLI's own.
    if id == fabric::SHARED {
      let _ = fabric::remove(&existing);
    } else {
      let _ = fabric::remove(&id);
      let _ = fabric::activate(&existing);
      auth::forget_identity();
    }
    on_data(Stream::System, "That account was already signed in here, so Fabricator is using it.\n");
  }
  result
}

/// Use Fabric account `id` for deploys, workspace lists, sharing and secrets.
#[tauri::command]
pub async fn fabric_use_account(id: String) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth::auth_failure("fabric-use-account", None, FABRIC_BUSY.into());
  };
  let _access = auth::rayfin_auth_write().await;
  match fabric::activate(&id) {
    Ok(()) => {
      auth::forget_identity();
      done(None)
    }
    Err(error) => auth::auth_failure("fabric-use-account", None, error),
  }
}

/// Sign Fabric account `id` out. Streams on `logout:rayfin`.
#[tauri::command]
pub async fn fabric_sign_out_account(app: AppHandle, id: String, project_id: Option<String>) -> ProcResult {
  let Ok(_guard) = RAYFIN_AUTH_ACTION.try_lock() else {
    return auth::auth_failure("fabric-logout", None, FABRIC_BUSY.into());
  };
  let on_data = proc_streamer(&app, "logout:rayfin");
  let _access = auth::rayfin_auth_write().await;
  sign_out_fabric(&id, project_id.as_deref(), on_data).await
}

/// Sign account `id` out (`rayfin logout` in its folder), forget the folder
/// when it was an added one and, when it was in use, switch to another signed-in
/// account. Callers hold the Fabric action lock and the auth write guard.
pub(crate) async fn sign_out_fabric(id: &str, project_id: Option<&str>, on_data: OnData) -> ProcResult {
  let Some(dir) = fabric::dir_of(id) else {
    return auth::auth_failure(
      "fabric-logout",
      None,
      "That Fabric account isn't on this computer anymore. Re-check your accounts.".into(),
    );
  };
  let project_dir = match auth::rayfin_project_dir(project_id) {
    Ok(dir) => dir,
    Err(error) => return auth::auth_failure("fabric-logout", None, error),
  };
  let res = auth::run_rayfin(
    project_dir.as_deref(),
    &["logout"],
    auth::account_command_options(
      project_dir.as_deref(),
      RunOptions {
        env: vec![(fabric::CONFIG_DIR_ENV.into(), dir.to_string_lossy().into_owned())],
        on_data: Some(on_data),
        timeout_ms: Some(60_000),
        ..Default::default()
      },
    ),
  )
  .await;
  if !res.ok {
    return auth::auth_failure(
      "fabric-logout",
      res.exit_code,
      auth::cli_failure_detail(&res, "Fabric sign-out", "Try signing out again."),
    );
  }
  let was_active = fabric::active_id() == id;
  if let Err(error) = fabric::remove(id) {
    return auth::auth_failure("fabric-logout", None, error);
  }
  if was_active {
    let _ = fabric::activate(&fabric::successor(id));
    auth::forget_identity();
  }
  done(res.exit_code)
}

/* ---------------------------------- Azure --------------------------------- */

/// The Azure CLI's accounts (users in tenants), grouped from its subscription
/// list — which `az login --allow-no-subscriptions` fills with a tenant-level
/// entry for tenants without one. Current account first.
pub(crate) fn parse_azure_accounts(stdout: &str) -> Option<Vec<AzureAccount>> {
  let entries: Vec<Value> = serde_json::from_str(stdout.trim()).ok()?;
  let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
  // Each account with whether the subscription chosen to select it is enabled.
  let mut accounts: Vec<(AzureAccount, bool)> = Vec::new();
  for entry in &entries {
    let (Some(user), Some(tenant), Some(subscription)) =
      (text(&entry["user"]["name"]), text(&entry["tenantId"]), text(&entry["id"]))
    else {
      continue;
    };
    let active = entry["isDefault"].as_bool().unwrap_or(false);
    let enabled = entry["state"].as_str().map_or(true, |s| s.eq_ignore_ascii_case("enabled"));
    let tenant_name = text(&entry["tenantDisplayName"]).or_else(|| text(&entry["tenantDefaultDomain"]));
    let same = |a: &AzureAccount| a.user.eq_ignore_ascii_case(&user) && a.tenant.eq_ignore_ascii_case(&tenant);
    match accounts.iter_mut().find(|(a, _)| same(a)) {
      Some((account, chosen_enabled)) => {
        // Select it by its default subscription, else by an enabled one.
        if active || (!account.active && enabled && !*chosen_enabled) {
          account.subscription = subscription;
          *chosen_enabled = enabled;
        }
        account.active |= active;
        if account.tenant_name.is_none() {
          account.tenant_name = tenant_name;
        }
      }
      None => accounts.push((AzureAccount { user, tenant, tenant_name, subscription, active }, enabled)),
    }
  }
  let mut accounts: Vec<AzureAccount> = accounts.into_iter().map(|(a, _)| a).collect();
  accounts.sort_by_key(|a| !a.active);
  Some(accounts)
}

#[tauri::command]
pub async fn azure_accounts() -> AzureAccountsResult {
  let res = exec::run("az", &["account", "list", "--all", "--output", "json"], RunOptions::timeout(30_000)).await;
  if res.not_found {
    return AzureAccountsResult { az_installed: false, ..Default::default() };
  }
  if !res.ok {
    return AzureAccountsResult {
      az_installed: true,
      accounts: Vec::new(),
      error: Some(auth::cli_failure_detail(&res, "Listing your Azure accounts", "Re-check, or sign in to Azure again.")),
    };
  }
  match parse_azure_accounts(&res.stdout) {
    Some(accounts) => AzureAccountsResult { az_installed: true, accounts, error: None },
    None => AzureAccountsResult {
      az_installed: true,
      accounts: Vec::new(),
      error: Some("The Azure CLI returned an account list Fabricator couldn't read. Re-check your accounts.".into()),
    },
  }
}

async fn current_azure_user() -> Option<String> {
  let res = exec::run("az", &["account", "show", "--output", "json"], RunOptions::timeout(30_000)).await;
  if !res.ok {
    return None;
  }
  let value: Value = serde_json::from_str(res.stdout.trim()).ok()?;
  value["user"]["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

async fn select_azure(subscription: &str) -> exec::RunResult {
  exec::run("az", &["account", "set", "--subscription", subscription], RunOptions::timeout(30_000)).await
}

/// Make the Azure CLI's account `user` (selected by `subscription`) current.
#[tauri::command]
pub async fn azure_use_account(user: String, subscription: String) -> ProcResult {
  let subscription = subscription.trim().to_string();
  if !GUID_RE.is_match(&subscription) {
    return auth::auth_failure("azure-use-account", None, "That isn't an Azure subscription or tenant ID.".into());
  }
  let Ok(_guard) = AZ_AUTH_ACTION.try_lock() else {
    return auth::auth_failure("azure-use-account", None, AZURE_BUSY.into());
  };
  let res = select_azure(&subscription).await;
  if !res.ok {
    return auth::auth_failure(
      "azure-use-account",
      res.exit_code,
      auth::cli_failure_detail(&res, "Switching Azure accounts", "Re-check your accounts and try again."),
    );
  }
  // Two accounts can share a subscription, and the Azure CLI then picks one of
  // them: confirm it picked the one asked for.
  match current_azure_user().await {
    Some(current) if current.eq_ignore_ascii_case(user.trim()) => done(res.exit_code),
    _ => auth::auth_failure(
      "azure-use-account",
      None,
      format!("The Azure CLI couldn't switch to {} because another account shares its subscription. Add {} again to use it.", user.trim(), user.trim()),
    ),
  }
}

/// Sign Azure CLI account `user` out. Streams on `logout:az`.
#[tauri::command]
pub async fn azure_sign_out_account(app: AppHandle, user: String) -> ProcResult {
  let Ok(_guard) = AZ_AUTH_ACTION.try_lock() else {
    return auth::auth_failure("azure-logout", None, AZURE_BUSY.into());
  };
  let on_data = proc_streamer(&app, "logout:az");
  sign_out_azure(on_data, Some(user.trim().to_string())).await
}

/// Sign in with `az login`. The account just signed in becomes current; the
/// Azure CLI keeps the others. Callers hold the Azure action lock.
pub(crate) async fn login_az(on_data: OnData, tenant: Option<&str>) -> ProcResult {
  on_data(Stream::Stdout, "Starting Azure sign-in…\n");
  // Fabric users often have no Azure subscription: sign in to the tenant anyway.
  let mut args = vec!["login", "--allow-no-subscriptions"];
  if let Some(tenant) = tenant {
    args.extend(["--tenant", tenant]);
  }
  let res = exec::run(
    "az",
    &args,
    RunOptions { on_data: Some(on_data.clone()), timeout_ms: Some(5 * 60_000), ..Default::default() },
  )
  .await;
  if res.not_found {
    return auth::auth_failure("azure-login", None, AZURE_MISSING.into());
  }
  if !res.ok {
    return auth::auth_failure(
      "azure-login",
      res.exit_code,
      auth::cli_failure_detail(&res, "Azure sign-in", "Complete the browser sign-in and try again."),
    );
  }
  // `az login` prints the signed-in account's subscriptions: make it current.
  if let Some(account) = signed_in_account(&res.stdout, tenant) {
    if !account.active {
      let _ = select_azure(&account.subscription).await;
    }
  }
  let status = auth::get_az_auth().await;
  auth::verified_login("azure-login", "Azure", &res, status.signed_in, status.error)
}

/// From `az login`'s output, the account to make current: the one in `tenant`
/// when one was asked for, else the CLI's pick, else the first.
fn signed_in_account(stdout: &str, tenant: Option<&str>) -> Option<AzureAccount> {
  let accounts = parse_azure_accounts(stdout)?;
  let wanted = tenant.and_then(|t| {
    accounts.iter().find(|a| a.tenant.eq_ignore_ascii_case(t) || a.tenant_name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(t)))
  });
  wanted.or_else(|| accounts.iter().find(|a| a.active)).or_else(|| accounts.first()).cloned()
}

/// Sign `user` (else the current account) out of the Azure CLI, confirm it's
/// gone, and keep another account current when any remain. Callers hold the
/// Azure action lock.
pub(crate) async fn sign_out_azure(on_data: OnData, user: Option<String>) -> ProcResult {
  let user = match user.filter(|u| !u.is_empty()) {
    Some(user) => Some(user),
    None => current_azure_user().await,
  };
  on_data(Stream::Stdout, "Signing out of Azure...\n");
  let mut args = vec!["logout"];
  // An unusual name isn't passed to the CLI: plain `az logout` signs the
  // current account out, which is then confirmed gone below.
  if let Some(name) = user.as_deref().filter(|u| safe_az_user(u)) {
    args.extend(["--username", name]);
  }
  let res = exec::run(
    "az",
    &args,
    RunOptions { on_data: Some(on_data.clone()), timeout_ms: Some(60_000), ..Default::default() },
  )
  .await;
  if !res.ok {
    return auth::auth_failure(
      "azure-logout",
      res.exit_code,
      auth::cli_failure_detail(&res, "Azure sign-out", "Try signing out again."),
    );
  }
  let listed = exec::run("az", &["account", "list", "--all", "--output", "json"], RunOptions::timeout(30_000)).await;
  let remaining = match remaining_after_sign_out(&listed, user.as_deref()) {
    Ok(remaining) => remaining,
    Err(error) => return auth::auth_failure("azure-logout", res.exit_code, error),
  };
  if let Some(next) = remaining.first().filter(|_| !remaining.iter().any(|a| a.active)) {
    if select_azure(&next.subscription).await.ok {
      on_data(Stream::Stdout, &format!("The Azure CLI now uses {}.\n", next.user));
    }
  }
  on_data(Stream::Stdout, "Signed out of Azure.\n");
  done(res.exit_code)
}

/// The accounts left after `user` signed out, or why that can't be confirmed.
fn remaining_after_sign_out(listed: &exec::RunResult, user: Option<&str>) -> Result<Vec<AzureAccount>, String> {
  if !listed.ok {
    return Err(auth::cli_failure_detail(
      listed,
      "Azure sign-out verification",
      "Re-check your account status or try signing out again.",
    ));
  }
  let accounts = parse_azure_accounts(&listed.stdout)
    .ok_or_else(|| "Azure returned an invalid account list after sign-out. Re-check your account status.".to_string())?;
  match user {
    Some(user) if accounts.iter().any(|a| a.user.eq_ignore_ascii_case(user)) => {
      Err(format!("The Azure CLI still has {user} signed in. Try signing out again."))
    }
    Some(_) => Ok(accounts),
    None if accounts.is_empty() => Ok(accounts),
    None => Err("The Azure CLI still has signed-in accounts. Try signing out again.".into()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn listed(ok: bool, stdout: &str) -> exec::RunResult {
    exec::RunResult { ok, exit_code: Some(if ok { 0 } else { 1 }), stdout: stdout.into(), stderr: String::new(), not_found: false }
  }

  const LIST: &str = r#"[
    {"id":"11111111-1111-1111-1111-111111111111","isDefault":false,"state":"Disabled","tenantId":"aaaaaaaa-0000-0000-0000-000000000000","tenantDisplayName":"Contoso","user":{"name":"alice@contoso.com","type":"user"}},
    {"id":"22222222-2222-2222-2222-222222222222","isDefault":false,"state":"Enabled","tenantId":"aaaaaaaa-0000-0000-0000-000000000000","user":{"name":"Alice@Contoso.com","type":"user"}},
    {"id":"bbbbbbbb-0000-0000-0000-000000000000","isDefault":true,"state":"Enabled","tenantId":"bbbbbbbb-0000-0000-0000-000000000000","tenantDefaultDomain":"fabrikam.onmicrosoft.com","name":"N/A(tenant level account)","user":{"name":"alice@fabrikam.com","type":"user"}},
    {"id":"33333333-3333-3333-3333-333333333333","tenantId":"aaaaaaaa-0000-0000-0000-000000000000","user":{"name":""}},
    {"broken":true}
  ]"#;

  #[test]
  fn azure_accounts_group_subscriptions_by_user_and_tenant() {
    let accounts = parse_azure_accounts(LIST).unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(
      accounts[0],
      AzureAccount {
        user: "alice@fabrikam.com".into(),
        tenant: "bbbbbbbb-0000-0000-0000-000000000000".into(),
        tenant_name: Some("fabrikam.onmicrosoft.com".into()),
        subscription: "bbbbbbbb-0000-0000-0000-000000000000".into(),
        active: true,
      },
      "the current account comes first, selected by its default"
    );
    assert_eq!(accounts[1].user, "alice@contoso.com");
    assert_eq!(accounts[1].tenant_name.as_deref(), Some("Contoso"));
    assert_eq!(accounts[1].subscription, "22222222-2222-2222-2222-222222222222", "an enabled subscription selects it");
    assert!(!accounts[1].active);
    assert_eq!(parse_azure_accounts("[]"), Some(vec![]));
    assert_eq!(parse_azure_accounts("not json"), None);
  }

  #[test]
  fn signing_in_makes_the_signed_in_account_current() {
    let in_tenant = signed_in_account(LIST, Some("Contoso")).unwrap();
    assert_eq!(in_tenant.user, "alice@contoso.com", "the organization asked for wins");
    assert_eq!(signed_in_account(LIST, None).unwrap().user, "alice@fabrikam.com", "else the CLI's pick");
    assert_eq!(signed_in_account("[]", None), None);
  }

  #[test]
  fn azure_sign_out_must_remove_the_account() {
    let remaining = remaining_after_sign_out(&listed(true, LIST), Some("bob@contoso.com")).unwrap();
    assert_eq!(remaining.len(), 2, "other accounts stay signed in");
    assert!(remaining_after_sign_out(&listed(true, LIST), Some("ALICE@contoso.com")).unwrap_err().contains("still has"));
    assert!(remaining_after_sign_out(&listed(true, "[]"), None).unwrap().is_empty());
    assert!(remaining_after_sign_out(&listed(true, LIST), None).is_err());
    assert!(remaining_after_sign_out(&listed(true, "not json"), Some("a@b.com")).is_err());
    assert!(remaining_after_sign_out(&listed(false, ""), Some("a@b.com")).is_err());
  }

  #[test]
  fn organizations_and_account_names_are_validated_before_reaching_a_cli() {
    assert_eq!(checked_tenant(None), Ok(None));
    assert_eq!(checked_tenant(Some("  ".into())), Ok(None));
    assert_eq!(checked_tenant(Some(" contoso.onmicrosoft.com ".into())), Ok(Some("contoso.onmicrosoft.com".into())));
    assert_eq!(
      checked_tenant(Some("72F988BF-86F1-41AF-91AB-2D7CD011DB47".into())),
      Ok(Some("72F988BF-86F1-41AF-91AB-2D7CD011DB47".into()))
    );
    for bad in ["contoso", "contoso.com & calc", "-x.com", "a b.com", "https://contoso.com", "%TEMP%.com"] {
      assert!(checked_tenant(Some(bad.into())).is_err(), "{bad:?}");
    }
    assert!(safe_az_user("alice@contoso.com"));
    assert!(safe_az_user("live.com#alice@outlook.com"));
    assert!(safe_az_user("04b07795-8ddb-461a-bbee-02f9e1bf7b46"));
    for bad in ["alice", "a&b@c.com", "a@b.com|calc", "\"a\"@b.com", "a%PATH%@b.com"] {
      assert!(!safe_az_user(bad), "{bad:?}");
    }
  }
}
