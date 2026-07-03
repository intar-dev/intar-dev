#![allow(clippy::missing_errors_doc)]

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::ScenarioError;

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct BuildTools {
    pub kino: KinoTool,
}

#[derive(Debug, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct KinoTool {
    pub version: String,
}

impl BuildTools {
    pub fn from_file(path: &Path) -> Result<Self, ScenarioError> {
        let content = std::fs::read_to_string(path)?;
        Self::parse(&content)
    }

    pub fn parse(content: &str) -> Result<Self, ScenarioError> {
        let body: hcl::Body =
            hcl::from_str(content).map_err(|error| ScenarioError::HclParse(error.to_string()))?;
        if let Some(attr) = body.attributes().next() {
            return Err(ScenarioError::InvalidBuildTools(format!(
                "root attribute '{}' is not supported",
                attr.key
            )));
        }

        let mut kino = None;
        for block in body.blocks() {
            match block.identifier.as_str() {
                "kino" => {
                    if kino.is_some() {
                        return Err(ScenarioError::InvalidBuildTools(
                            "duplicate kino block".into(),
                        ));
                    }
                    kino = Some(parse_kino_tool(block)?);
                }
                other => {
                    return Err(ScenarioError::InvalidBuildTools(format!(
                        "root block '{other}' is not supported"
                    )));
                }
            }
        }

        let Some(kino) = kino else {
            return Err(ScenarioError::InvalidBuildTools(
                "missing kino block".into(),
            ));
        };
        Ok(Self { kino })
    }
}

fn parse_kino_tool(block: &hcl::Block) -> Result<KinoTool, ScenarioError> {
    if !block.labels.is_empty() {
        return Err(ScenarioError::InvalidBuildTools(
            "kino block does not support labels".into(),
        ));
    }
    if let Some(inner_block) = block.body.blocks().next() {
        return Err(ScenarioError::InvalidBuildTools(format!(
            "kino block does not support nested block '{}'",
            inner_block.identifier
        )));
    }

    let mut version = None;
    for attr in block.body.attributes() {
        match attr.key.as_str() {
            "version" => version = Some(extract_string(&attr.expr)?),
            other => {
                return Err(ScenarioError::InvalidBuildTools(format!(
                    "kino block does not support attribute '{other}'"
                )));
            }
        }
    }

    let version = version
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ScenarioError::InvalidBuildTools("kino.version is required".into()))?;
    if version.bytes().any(|byte| byte.is_ascii_whitespace()) {
        return Err(ScenarioError::InvalidBuildTools(
            "kino.version must not contain whitespace".into(),
        ));
    }

    Ok(KinoTool { version })
}

fn extract_string(expr: &hcl::Expression) -> Result<String, ScenarioError> {
    match expr {
        hcl::Expression::String(value) => Ok(value.clone()),
        _ => Err(ScenarioError::InvalidBuildTools(
            "expected string literal".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use crate::{BuildTools, ScenarioError};

    #[test]
    fn parses_kino_version() {
        let tools = BuildTools::parse(
            r#"
kino {
  version = "0.1.24"
}
"#,
        )
        .unwrap();

        assert_eq!(tools.kino.version, "0.1.24");
    }

    #[test]
    fn rejects_missing_kino_block() {
        let error = BuildTools::parse("").unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidBuildTools(message) if message.contains("missing kino"))
        );
    }

    #[test]
    fn rejects_unknown_kino_attribute() {
        let error = BuildTools::parse(
            r#"
kino {
  channel = "stable"
  version = "0.1.24"
}
"#,
        )
        .unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidBuildTools(message) if message.contains("channel"))
        );
    }
}
