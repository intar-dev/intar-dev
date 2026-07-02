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
    pub sources: Vec<ImageSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSource {
    pub arch: String,
    pub url: String,
    pub checksum: String,
}

impl BaseImageSpec {
    #[must_use]
    pub fn source_for_arch(&self, arch: &str) -> Option<&ImageSource> {
        let normalized = normalize_arch(arch);
        self.sources.iter().find(|source| source.arch == normalized)
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
            if base_image.source_for_arch(normalized_arch).is_none() {
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

            if base_image.source_for_arch(normalized_arch).is_none() {
                return Err(ScenarioError::MissingBaseImageSource {
                    base_image: base_image.name.clone(),
                    arch: normalized_arch.to_string(),
                });
            }
        }

        Ok(())
    }
}

fn parse_base_image(block: &hcl::Block) -> Result<BaseImageSpec, ScenarioError> {
    let name = block
        .labels
        .first()
        .map(|label| label.as_str().to_string())
        .ok_or_else(|| ScenarioError::InvalidBaseImageCatalog("missing base image name".into()))?;

    let mut sources = Vec::new();
    if let Some(attr) = block.body.attributes().next() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' does not support attribute '{}'",
            attr.key
        )));
    }

    for inner_block in block.body.blocks() {
        if inner_block.identifier.as_str() == "source" {
            sources.push(parse_image_source(inner_block)?);
            continue;
        }

        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' does not support nested block '{}'",
            inner_block.identifier
        )));
    }

    if sources.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(format!(
            "base_image '{name}' has no sources"
        )));
    }

    Ok(BaseImageSpec { name, sources })
}

fn parse_image_source(block: &hcl::Block) -> Result<ImageSource, ScenarioError> {
    let mut arch = String::new();
    let mut url = String::new();
    let mut checksum = String::new();

    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "arch" => arch = extract_string(&attr.expr)?,
            "url" => url = extract_string(&attr.expr)?,
            "checksum" => checksum = extract_string(&attr.expr)?,
            other => {
                return Err(ScenarioError::InvalidBaseImageCatalog(format!(
                    "image source does not support attribute '{other}'"
                )));
            }
        }
    }

    if block.body.blocks().next().is_some() {
        return Err(ScenarioError::InvalidBaseImageCatalog(
            "image source does not support nested blocks".into(),
        ));
    }

    if arch.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(
            "image source missing 'arch'".into(),
        ));
    }
    if url.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(
            "image source missing 'url'".into(),
        ));
    }
    if checksum.is_empty() {
        return Err(ScenarioError::InvalidBaseImageCatalog(
            "image source missing 'checksum' (required for verification)".into(),
        ));
    }

    Ok(ImageSource {
        arch: normalize_arch(&arch).to_string(),
        url,
        checksum,
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::{Scenario, ScenarioError};

    use super::BaseImageCatalog;

    fn catalog_hcl() -> &'static str {
        r#"
base_image "trixie" {
  source {
    arch = "amd64"
    url = "https://example.com/trixie-amd64.qcow2"
    checksum = "sha512:abc123"
  }
}
"#
    }

    #[test]
    fn parses_base_image_catalog() {
        let catalog = BaseImageCatalog::parse(catalog_hcl()).unwrap();
        let base_image = catalog.base_image_by_name("trixie").unwrap();
        let source = base_image.source_for_arch("x86_64").unwrap();

        assert_eq!(source.arch, "amd64");
        assert_eq!(source.url, "https://example.com/trixie-amd64.qcow2");
        assert_eq!(source.checksum, "sha512:abc123");
    }

    #[test]
    fn errors_on_unknown_base_reference() {
        let catalog = BaseImageCatalog::parse(catalog_hcl()).unwrap();
        let scenario = Scenario::parse(
            r#"
scenario "broken-nginx" {
  category = "web"
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
