use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let proto_file = "../../proto/kino/v1/probes.proto";
    let proto_root = "../../proto";

    println!("cargo:rerun-if-changed={proto_file}");

    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);

    config.compile_protos(&[proto_file], &[proto_root])?;

    Ok(())
}
