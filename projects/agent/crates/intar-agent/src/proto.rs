#![forbid(unsafe_code)]

pub mod kino_v1 {
    include!(concat!(env!("OUT_DIR"), "/kino.v1.rs"));
}
