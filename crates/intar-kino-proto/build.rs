use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    let proto_files = ["proto/kino/v1/probes.proto", "proto/kino/v2/guest.proto"];
    let proto_root = "proto";

    for proto_file in proto_files {
        println!("cargo:rerun-if-changed={proto_file}");
    }

    let protoc = protoc_bin_vendored::protoc_bin_path()?;
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.compile_protos(&proto_files, &[proto_root])?;

    Ok(())
}
