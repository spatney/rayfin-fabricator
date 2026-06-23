//! Cross-cutting services shared by the Tauri commands (process execution,
//! persistence, paths, event emission, telemetry, crash logging).

pub mod crashlog;
pub mod copilot;
pub mod emit;
pub mod env_path;
pub mod exec;
pub mod history;
pub mod paths;
pub mod preview;
pub mod store;
pub mod telemetry;
pub mod updater;
