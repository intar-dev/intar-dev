#![forbid(unsafe_code)]

fn main() {
    if let Err(error) = intar_jailer::run() {
        eprintln!("intar-jailer: {error:#}");
        std::process::exit(1);
    }
}
