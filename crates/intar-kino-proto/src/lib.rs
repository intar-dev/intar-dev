#![forbid(unsafe_code)]

pub mod host;

pub mod kino_v1 {
    #![allow(clippy::all, clippy::pedantic, clippy::restriction, clippy::nursery)]

    include!(concat!(env!("OUT_DIR"), "/kino.v1.rs"));
}

pub mod kino_v2 {
    #![allow(clippy::all, clippy::pedantic, clippy::restriction, clippy::nursery)]

    include!(concat!(env!("OUT_DIR"), "/kino.v2.rs"));

    /// The largest frame either side sends or accepts.
    pub const MAX_FRAME_BYTES: usize = 256 * 1024;
}
