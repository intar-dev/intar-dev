use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScenarioError {
    #[error("failed to parse HCL: {0}")]
    HclParse(String),

    #[error("invalid scenario: {0}")]
    InvalidScenario(String),

    #[error("invalid base image catalog: {0}")]
    InvalidBaseImageCatalog(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("probe '{0}' not found in scenario")]
    ProbeNotFound(String),

    #[error("vm '{0}' not found in scenario")]
    VmNotFound(String),

    #[error("image '{0}' not found in scenario")]
    ImageNotFound(String),

    #[error("base image '{0}' not found in catalog")]
    BaseImageNotFound(String),

    #[error("base image '{base_image}' does not define a supported '{arch}' source")]
    MissingBaseImageSource { base_image: String, arch: String },

    #[error("unsupported builder arch '{arch}'; only 'amd64' is supported")]
    UnsupportedBuilderArch { arch: String },

    #[error("scenario is missing required field '{field}'")]
    MissingScenarioField { field: String },

    #[error("scenario field '{field}' is invalid: {message}")]
    InvalidScenarioField { field: String, message: String },

    #[error("{scope} has duplicate hint id '{id}'")]
    DuplicateHintId { scope: String, id: String },

    #[error("probe '{probe}' is missing a description")]
    MissingProbeDescription { probe: String },

    #[error("kino defaults are invalid: {message}")]
    InvalidKinoDefaults { message: String },

    #[error("{context} references managed path '{path}'")]
    ManagedPath { context: String, path: String },

    #[error("{context} references managed unit '{unit}'")]
    ManagedUnit { context: String, unit: String },

    #[error("{context} references Intar-managed Kino or SSH bootstrap assets")]
    ManagedCommand { context: String },

    #[error("{context} references Intar-managed Kino or SSH bootstrap assets")]
    ManagedText { context: String },

    #[error("probe '{probe}' has invalid config: {message}")]
    InvalidProbeConfig { probe: String, message: String },
}
