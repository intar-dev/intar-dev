//! What any host of a lab's machines needs (#397), whether it is a platform
//! host's agent or the desktop app: reading the sessions Kino recorded and
//! rendering them into the replay intar shows.
//!
//! The modules were the agent's own; they moved here unchanged so the app
//! produces the same files.

pub mod check_passes;
pub mod krec;
pub mod recordings;
pub mod replay_compose;
pub mod replay_media;
pub mod transcript;
