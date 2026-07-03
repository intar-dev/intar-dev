use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct KinoArtifact {
    pub binary_path: PathBuf,
    pub version: String,
}
