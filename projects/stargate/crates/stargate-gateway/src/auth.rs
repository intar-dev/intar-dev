use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use http::HeaderMap;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use reqwest::redirect::Policy;
use serde::Deserialize;
use tokio::sync::RwLock;

use stargate_core::{AssertionAuthSettings, Result, StargateError};

#[derive(Clone)]
pub struct AssertionValidator {
    config: AssertionAuthSettings,
    client: reqwest::Client,
    cache: Arc<RwLock<Option<JwksCache>>>,
}

#[derive(Clone)]
struct JwksCache {
    fetched_at: Instant,
    set: JwkSet,
}

#[derive(Debug, Clone, Deserialize)]
struct AccessClaims {
    iss: String,
    aud: AudClaim,
    exp: u64,
    sub: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum AudClaim {
    One(String),
    Many(Vec<String>),
}

impl AudClaim {
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::One(value) => value == expected,
            Self::Many(values) => values.iter().any(|value| value == expected),
        }
    }
}

impl AssertionValidator {
    pub fn new(config: AssertionAuthSettings) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .https_only(true)
            .build()
            .map_err(|error| StargateError::Internal(error.to_string()))?;

        Ok(Self {
            config,
            client,
            cache: Arc::new(RwLock::new(None)),
        })
    }

    pub fn header_name(&self) -> &str {
        self.config.assertion_header.as_str()
    }

    pub async fn validate_headers(&self, headers: &HeaderMap) -> Result<()> {
        let token = headers
            .get(self.header_name())
            .ok_or(StargateError::Unauthorized)?
            .to_str()
            .map_err(|_| StargateError::Unauthorized)?;
        self.validate_token(token).await
    }

    pub async fn validate_token(&self, token: &str) -> Result<()> {
        let header = decode_header(token).map_err(|_| StargateError::Unauthorized)?;
        self.validate_algorithm(header.alg)?;
        let key = self.resolve_key(&header).await?;
        let mut validation = Validation::new(header.alg);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        validation.set_issuer(std::slice::from_ref(&self.config.issuer));
        validation.set_audience(std::slice::from_ref(&self.config.audience));
        let decoded = decode::<AccessClaims>(token, &key, &validation)
            .map_err(|_| StargateError::Unauthorized)?;

        if decoded.claims.iss != self.config.issuer
            || !decoded.claims.aud.contains(&self.config.audience)
        {
            return Err(StargateError::Unauthorized);
        }

        let _ = decoded.claims.exp;
        let _ = decoded.claims.sub;
        Ok(())
    }

    fn validate_algorithm(&self, algorithm: Algorithm) -> Result<()> {
        if self.config.hs256_secret.is_some() {
            return if algorithm == Algorithm::HS256 {
                Ok(())
            } else {
                Err(StargateError::Unauthorized)
            };
        }

        if matches!(
            algorithm,
            Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512
        ) {
            return Err(StargateError::Unauthorized);
        }

        Ok(())
    }

    async fn resolve_key(&self, header: &jsonwebtoken::Header) -> Result<DecodingKey> {
        if let Some(secret) = &self.config.hs256_secret {
            return Ok(DecodingKey::from_secret(secret.as_bytes()));
        }

        let kid = header.kid.clone().ok_or(StargateError::Unauthorized)?;
        let jwks_url = self.config.jwks_url.clone().ok_or_else(|| {
            StargateError::Internal("jwks_url is required when hs256_secret is unset".to_owned())
        })?;
        let set = self.load_jwks(jwks_url.as_str()).await?;
        let jwk = set.find(&kid).ok_or(StargateError::Unauthorized)?;
        DecodingKey::from_jwk(jwk).map_err(|error| StargateError::Internal(error.to_string()))
    }

    async fn load_jwks(&self, url: &str) -> Result<JwkSet> {
        {
            let guard = self.cache.read().await;
            if let Some(cache) = guard.as_ref()
                && cache.fetched_at.elapsed() < Duration::from_secs(300)
            {
                return Ok(cache.set.clone());
            }
        }

        let set = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| StargateError::Internal(error.to_string()))?
            .error_for_status()
            .map_err(|error| StargateError::Internal(error.to_string()))?
            .json::<JwkSet>()
            .await
            .map_err(|error| StargateError::Internal(error.to_string()))?;

        let mut guard = self.cache.write().await;
        *guard = Some(JwksCache {
            fetched_at: Instant::now(),
            set: set.clone(),
        });
        Ok(set)
    }
}

#[cfg(test)]
mod tests {
    use jsonwebtoken::{EncodingKey, Header, encode};

    use super::*;

    #[derive(Debug, serde::Serialize)]
    struct Claims<'a> {
        iss: &'a str,
        aud: &'a str,
        exp: u64,
        sub: &'a str,
    }

    #[tokio::test]
    async fn validates_hs256_assertions() {
        let validator = AssertionValidator::new(AssertionAuthSettings {
            assertion_header: "cf-access-jwt-assertion".to_owned(),
            audience: "aud".to_owned(),
            issuer: "issuer".to_owned(),
            jwks_url: None,
            hs256_secret: Some("secret".to_owned()),
        })
        .expect("validator");
        let token = encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                iss: "issuer",
                aud: "aud",
                exp: u64::MAX / 2,
                sub: "worker",
            },
            &EncodingKey::from_secret(b"secret"),
        )
        .expect("encode");

        let mut headers = HeaderMap::new();
        headers.insert(
            "cf-access-jwt-assertion",
            token.parse().expect("header value"),
        );

        assert!(validator.validate_headers(&headers).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_wrong_algorithm_in_hs256_mode() {
        let validator = AssertionValidator::new(AssertionAuthSettings {
            assertion_header: "cf-access-jwt-assertion".to_owned(),
            audience: "aud".to_owned(),
            issuer: "issuer".to_owned(),
            jwks_url: None,
            hs256_secret: Some("secret".to_owned()),
        })
        .expect("validator");
        let token = encode(
            &Header::new(Algorithm::HS384),
            &Claims {
                iss: "issuer",
                aud: "aud",
                exp: u64::MAX / 2,
                sub: "worker",
            },
            &EncodingKey::from_secret(b"secret"),
        )
        .expect("encode");

        let mut headers = HeaderMap::new();
        headers.insert(
            "cf-access-jwt-assertion",
            token.parse().expect("header value"),
        );

        assert!(validator.validate_headers(&headers).await.is_err());
    }
}
