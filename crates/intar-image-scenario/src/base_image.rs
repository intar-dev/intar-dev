#![allow(clippy::missing_errors_doc)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use crate::{Scenario, ScenarioError, assert_supported_builder_arch, normalize_arch};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BaseImageCatalog {
    pub base_images: HashMap<String, BaseImageSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseImageSpec {
    pub name: String,
    pub suite: String,
    pub mirror: String,
    pub arch: String,
    pub kernel_package: String,
    pub packages: Vec<String>,
}

impl BaseImageSpec {
    #[must_use]
    pub fn definition_for_arch(&self, arch: &str) -> Option<&Self> {
        let normalized = normalize_arch(arch);
        (self.arch == normalized).then_some(self)
    }

    #[must_use]
    pub fn content_identity(&self) -> String {
        [
            format!("suite={}", self.suite),
            format!("mirror={}", self.mirror),
            format!("arch={}", self.arch),
            format!("kernel_package={}", self.kernel_package),
            format!("packages={}", self.packages.join(",")),
        ]
        .join("\n")
    }
}

impl BaseImageCatalog {
    pub fn from_file(path: &Path) -> Result<Self, ScenarioError> {
        let content = std::fs::read_to_string(path)?;
        Self::parse(&content)
    }

    pub fn parse(content: &str) -> Result<Self, ScenarioError> {
        let body: hcl::Body =
            hcl::from_str(content).map_err(|error| ScenarioError::HclParse(error.to_string()))?;
        let mut base_images = HashMap::new();

        for block in body.blocks() {
            if block.identifier.as_str() != "base_image" {
                continue;
            }

            let base_image = parse_base_image(block)?;
            let name = base_image.name.clone();
            if base_images.insert(name.clone(), base_image).is_some() {
                return Err(ScenarioError::InvalidBaseImageCatalog(format!(
                    "duplicate base image '{name}'"
                )));
            }
        }

        if base_images.is_empty() {
            return Err(ScenarioError::InvalidBaseImageCatalog(
                "no base_image blocks found".into(),
            ));
        }

        Ok(Self { base_images })
    }

    #[must_use]
    pub fn base_image_by_name(&self, name: &str) -> Option<&BaseImageSpec> {
        self.base_images.get(name)
    }

    pub fn validate_for_builder_arch(&self, target_arch: &str) -> Result<(), ScenarioError> {
        let normalized_arch = assert_supported_builder_arch(target_arch)?;

        for base_image in self.base_images.values() {
            validate_safe_base_image_identifier("base image name", &base_image.name)?;
            if base_image.definition_for_arch(normalized_arch).is_none() {
                return Err(ScenarioError::MissingBaseImageSource {
                    base_image: base_image.name.clone(),
                    arch: normalized_arch.to_string(),
                });
            }
        }

        Ok(())
    }

    pub fn validate_scenario_for_builder_arch(
        &self,
        scenario: &Scenario,
        target_arch: &str,
    ) -> Result<(), ScenarioError> {
        let normalized_arch = assert_supported_builder_arch(target_arch)?;

        for image in scenario.images.values() {
            let Some(base_image) = self.base_image_by_name(&image.base) else {
                return Err(ScenarioError::BaseImageNotFound(image.base.clone()));
            };

            if base_image.definition_for_arch(normalized_arch).is_none() {
                return Err(ScenarioError::MissingBaseImageSource {
                    base_image: base_image.name.clone(),
                    arch: normalized_arch.to_string(),
                });
            }
        }

        Ok(())
    }
}

fn validate_safe_base_image_identifier(label: &str, value: &str) -> Result<(), ScenarioError> {
    if (1..=128).contains(&value.len())
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Ok(());
    }

    Err(ScenarioError::InvalidBaseImageCatalog(format!(
        "invalid {label} '{value}' (expected 1-128 safe slug characters)"
    )))
}

fn parse_base_image(block: &hcl::Block) -> Result<BaseImageSpec, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidBaseImageCatalog("missing base image name".into()))?;

    let mut suite = String::new();
    let mut mirror = String::new();
    let mut arch = String::new();
    let mut kernel_package = String::new();
    let mut packages = Vec::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "suite" => suite = extract_string(&attr.expr)?,
            "mirror" => mirror = extract_string(&attr.expr)?,
            "arch" => arch = extract_string(&attr.expr)?,
            "kernel_package" => kernel_package = extract_string(&attr.expr)?,
            "packages" => packages = extract_string_array(&attr.expr)?,
            other => {
                return Err(ScenarioError::InvalidBaseImageCatalog(format!(
                    "base_image '{name}' does not support attribute '{other}'"
                )));
            }
        }
    }

    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' does not support nested block '{}'",
            inner_block.identifier
        )));
    }

    if suite.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' missing 'suite'"
        )));
    }
    if mirror.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' missing 'mirror'"
        )));
    }
    if arch.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' missing 'arch'"
        )));
    }
    if kernel_package.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' missing 'kernel_package'"
        )));
    }
    if packages.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' missing non-empty 'packages'"
        )));
    }

    Ok(BaseImageSpec {
        name,
        suite,
        mirror,
        arch: normalize_arch(&arch).to_string(),
        kernel_package,
        packages,
    })
}

fn extract_string(expr: &hcl::Expression) -> Result<String, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(value.clone()),
        _ => Err(ScenarioError::InvalidBaseImageCatalog(
            "expected string literal".into(),
        )),
    }
}

fn extract_string_array(expr: &hcl::Expression) -> Result<Vec<String>, ScenarioError> {
    match expr {
        hcl::Expression::Array(array) => array.iter().map(extract_string).collect(),
        _ => Err(ScenarioError::InvalidBaseImageCatalog(
            "expected string array".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::{Scenario, ScenarioError};

    use super::BaseImageCatalog;

    fn catalog_hcl() -> &'static str {
        r#"
base_image "trixie" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server", "ca-certificates", "sudo", "zstd"]
}
"#
    }

    #[test]
    fn parses_base_image_catalog() {
        let catalog = BaseImageCatalog::parse(catalog_hcl()).unwrap();
        let base_image = catalog.base_image_by_name("trixie").unwrap();
        let definition = base_image.definition_for_arch("x86_64").unwrap();

        assert_eq!(definition.arch, "amd64");
        assert_eq!(definition.suite, "trixie");
        assert_eq!(definition.mirror, "https://deb.debian.org/debian");
        assert_eq!(definition.kernel_package, "linux-image-cloud-amd64");
        assert_eq!(
            definition.content_identity(),
            "suite=trixie\nmirror=https://deb.debian.org/debian\narch=amd64\nkernel_package=linux-image-cloud-amd64\npackages=openssh-server,ca-certificates,sudo,zstd"
        );
    }

    #[test]
    fn errors_on_unsafe_base_image_name() {
        let catalog = BaseImageCatalog::parse(
            r#"
base_image "../escape" {
  suite          = "trixie"
  mirror         = "https://deb.debian.org/debian"
  arch           = "amd64"
  kernel_package = "linux-image-cloud-amd64"
  packages       = ["openssh-server"]
}
"#,
        )
        .unwrap();

        let error = catalog.validate_for_builder_arch("amd64").unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidBaseImageCatalog(message) if message.contains("invalid base image name"))
        );
    }

    #[test]
    fn errors_on_unknown_base_reference() {
        let catalog = BaseImageCatalog::parse(catalog_hcl()).unwrap();
        let scenario = Scenario::parse_course(
            r#"
scenario "broken-nginx" {
  image "debian-13-generic" {
    base = "missing"
  }
  kino {
    probe "svc" {
      kind = "service"
      service = "nginx"
      state = "running"
      description = "Nginx"
    }
  }
  vm "web" {
    image = "debian-13-generic"
    probes = ["svc"]
  }
}
"#,
        )
        .unwrap();

        let error = catalog
            .validate_scenario_for_builder_arch(&scenario, "amd64")
            .unwrap_err();
        assert!(matches!(error, ScenarioError::BaseImageNotFound(name) if name == "missing"));
    }

    #[test]
    fn rejects_non_amd64_builder_arch() {
        let catalog = BaseImageCatalog::parse(catalog_hcl()).unwrap();
        let error = catalog.validate_for_builder_arch("arm64").unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::UnsupportedBuilderArch { arch } if arch == "arm64"
        ));
    }
}
