use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use url::Url;

#[derive(Clone, Deserialize, Serialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([REDACTED])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct SanitizedError(String);

impl SanitizedError {
    pub const MAX_BYTES: usize = 1024;

    pub fn new(value: impl AsRef<str>, secrets: &[&str]) -> Self {
        let mut sanitized = value.as_ref().replace(['\r', '\0'], "");

        for secret in secrets.iter().filter(|value| !value.is_empty()) {
            sanitized = sanitized.replace(secret, "[REDACTED]");
        }

        sanitized = sanitized
            .split_whitespace()
            .map(redact_url_or_sensitive_token)
            .collect::<Vec<_>>()
            .join(" ");

        if sanitized.len() > Self::MAX_BYTES {
            sanitized.truncate(floor_char_boundary(&sanitized, Self::MAX_BYTES));
        }
        Self(sanitized)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SanitizedError {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(Self::new(value, &[]))
    }
}

fn redact_url_or_sensitive_token(token: &str) -> String {
    let lower = token.to_ascii_lowercase();
    if lower.contains("authorization=")
        || lower.contains("token=")
        || lower.contains("secret=")
        || lower.contains("credential=")
        || lower.contains("capability=")
    {
        return "[REDACTED]".to_owned();
    }

    let url_start = token.find("https://").or_else(|| token.find("http://"));
    if let Some(start) = url_start {
        let (prefix, candidate) = token.split_at(start);
        let candidate = candidate.trim_end_matches([')', ']', '}', ',', ';']);
        let suffix = &token[start + candidate.len()..];
        if let Ok(mut url) = Url::parse(candidate)
            && matches!(url.scheme(), "http" | "https")
        {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            return format!("{prefix}{url}{suffix}");
        }
    }

    token.to_owned()
}

fn floor_char_boundary(value: &str, index: usize) -> usize {
    let mut boundary = index.min(value.len());
    while !value.is_char_boundary(boundary) {
        boundary = boundary.saturating_sub(1);
    }
    boundary
}

#[cfg(test)]
mod tests {
    use super::{SanitizedError, SecretString};

    #[test]
    fn debug_and_errors_do_not_expose_credentials_or_signed_queries() {
        let capability = "bootstrap-super-secret";
        let report = "report-even-more-secret";
        let secret = SecretString::new(capability);
        assert_eq!(format!("{secret:?}"), "SecretString([REDACTED])");

        let raw = format!(
            "request token={capability} Authorization={report} failed at (https://store.example/bundle?X-Amz-Signature=another-secret)"
        );
        let sanitized = SanitizedError::new(raw, &[capability, report]);
        assert!(!sanitized.as_str().contains(capability));
        assert!(!sanitized.as_str().contains(report));
        assert!(!sanitized.as_str().contains("X-Amz-Signature"));
        assert!(sanitized.as_str().contains("https://store.example/bundle"));
    }
}
