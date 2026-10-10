//! Cross-cutting services shared by the Tauri commands (process execution,
//! persistence, paths, event emission, telemetry, crash logging).

pub mod agent_skills;
pub mod agent_tools;
pub mod copilot;
pub mod crashlog;
pub mod design_locate;
pub mod dev_server;
pub mod diagnostics;
pub mod emit;
pub mod env_path;
pub mod exec;
pub mod fabric_accounts;
pub mod fabric_auth;
pub mod fingerprint;
pub mod git;
pub mod grounding;
pub mod help_session;
pub mod history;
pub mod journal;
pub mod local_ports;
pub mod npm_env;
pub mod paths;
pub mod preview;
pub mod project_layout;
pub mod project_mutation;
pub mod redirect_uris;
pub mod semantic_model;
pub mod store;
pub mod team;
pub mod telemetry;
pub mod updater;
pub mod version_history;
pub mod watchdog;
