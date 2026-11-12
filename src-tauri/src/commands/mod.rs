//! Tauri command handlers — one module per feature area, mirroring the
//! `ipcMain.handle(...)` registrations in `src/main/ipc.ts`. Command names use
//! snake_case (Tauri maps the renderer's camelCase invoke args automatically).

pub mod accounts;
pub mod advisor;
pub mod apps;
pub mod auth;
pub mod byok;
pub mod chat;
pub mod chat_tools;
pub mod commit_message;
pub mod custom_skills;
pub mod deploy;
pub mod diagnostics;
pub mod doctor;
pub mod export;
pub mod fabric;
pub mod files;
pub mod gallery;
pub mod git;
pub mod github;
pub mod github_repo;
pub mod goals;
pub mod help;
pub mod mcp;
pub mod migration;
pub mod misc;
pub mod pick;
pub mod projects;
pub mod projects_impl;
pub mod rayfin_version;
pub mod screenshot;
pub mod secrets;
pub mod security;
pub mod settings;
pub mod skills;
pub mod suggest;
pub mod team;
pub mod terminal;
pub mod transient;
pub mod updates;
pub mod util;
pub mod local;
