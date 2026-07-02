#![forbid(unsafe_code)]

#[cfg_attr(not(target_os = "linux"), allow(unused_imports))]
pub use intar_kino_proto::kino_v1;
