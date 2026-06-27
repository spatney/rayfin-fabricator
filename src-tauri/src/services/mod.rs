//! Cross-cutting services shared by the Tauri commands (process execution,
//! persistence, paths, event emission, telemetry, crash logging).

pub mod agent_skills;
pub mod agent_tools;
pub mod crashlog;
pub mod copilot;
pub mod emit;
pub mod env_path;
pub mod exec;
pub mod fingerprint;
pub mod history;
pub mod paths;
pub mod preview;
pub mod semantic_model;
pub mod store;
pub mod telemetry;
pub mod updater;
