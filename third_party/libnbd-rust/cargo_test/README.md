The solely purpose of this directory is to serve as a test crate for checking if Cargo is useable.
`cargo test`, `cargo doc` and `cargo fmt` are run in the Autoconf script in this directory. If any of the commands failes,
Cargo is assumed not to be useable and the Rust bindings will be disabled.
