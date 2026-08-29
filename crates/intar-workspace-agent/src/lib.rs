//! Guest-side control plane for direct Workshop learner servers.
//!
//! The agent deliberately knows nothing about the cloud provider. It receives a
//! short-lived, one-use bootstrap capability, exchanges it for credentials that
//! are bound to one runtime execution generation, applies a content-addressed
//! checkpoint, and reports sanitized health observations.

pub mod agent;
pub mod checkpoint;
pub mod client;
pub mod config;
pub mod kino;
pub mod model;
mod recordings;
mod run_cli;
pub mod secrets;
pub mod state;

pub use agent::WorkspaceAgent;
pub use client::{ControlPlane, HttpControlPlane};
pub use config::AgentConfig;
pub use model::{AgentPhase, ExecutionIdentity, HealthStatus};
