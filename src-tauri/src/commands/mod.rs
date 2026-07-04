//! Tauri command handlers — one module per feature area, mirroring the
//! `ipcMain.handle(...)` registrations in `src/main/ipc.ts`. Command names use
//! snake_case (Tauri maps the renderer's camelCase invoke args automatically).

pub mod advisor;
pub mod auth;
pub mod chat;
pub mod deploy;
pub mod design;
pub mod doctor;
pub mod fabric;
pub mod files;
pub mod git;
pub mod misc;
pub mod projects;
pub mod projects_impl;
pub mod rayfin_version;
pub mod screenshot;
pub mod settings;
pub mod skills;
pub mod suggest;
pub mod updates;
pub mod util;
