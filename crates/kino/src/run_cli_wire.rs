//! Bounded framing helpers for Kino's private run-CLI sockets.
//!
//! The public learner CLI has no JSON output. JSON is only used on these
//! root-owned/local transport boundaries through the shared contract framing.

use intar_contracts::run_cli::{
    RUN_CLI_FRAME_HEADER_BYTES, RunCliFrameError, decode_run_cli_frame, encode_run_cli_frame,
    run_cli_frame_payload_len,
};
use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[derive(Debug, Error)]
pub(crate) enum WireError {
    #[error("run CLI socket I/O failed")]
    Io(#[source] std::io::Error),
    #[error("run CLI socket frame was invalid")]
    Frame(#[source] RunCliFrameError),
}

pub(crate) async fn read_message<T, S>(stream: &mut S) -> Result<T, WireError>
where
    T: DeserializeOwned,
    S: AsyncRead + Unpin,
{
    let mut prefix = [0_u8; RUN_CLI_FRAME_HEADER_BYTES];
    stream
        .read_exact(&mut prefix)
        .await
        .map_err(WireError::Io)?;
    let payload_len = run_cli_frame_payload_len(prefix).map_err(WireError::Frame)?;
    let mut frame = Vec::with_capacity(RUN_CLI_FRAME_HEADER_BYTES + payload_len);
    frame.extend_from_slice(&prefix);
    frame.resize(RUN_CLI_FRAME_HEADER_BYTES + payload_len, 0);
    stream
        .read_exact(&mut frame[RUN_CLI_FRAME_HEADER_BYTES..])
        .await
        .map_err(WireError::Io)?;
    decode_run_cli_frame(&frame).map_err(WireError::Frame)
}

pub(crate) async fn write_message<T, S>(stream: &mut S, message: &T) -> Result<(), WireError>
where
    T: Serialize,
    S: AsyncWrite + Unpin,
{
    let frame = encode_run_cli_frame(message).map_err(WireError::Frame)?;
    stream.write_all(&frame).await.map_err(WireError::Io)?;
    stream.flush().await.map_err(WireError::Io)
}

#[cfg(test)]
mod tests {
    use super::{read_message, write_message};
    use intar_contracts::run_cli::{RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliRequestV1};
    use tokio::io::duplex;

    #[tokio::test]
    async fn round_trips_a_bounded_message() {
        let (mut left, mut right) = duplex(4096);
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "test-request".to_owned(),
            action: RunCliActionV1::Status,
        };
        let expected = request.clone();
        let writer = tokio::spawn(async move { write_message(&mut left, &request).await });
        let actual = read_message::<RunCliRequestV1, _>(&mut right)
            .await
            .expect("read frame");
        writer.await.expect("writer task").expect("write frame");
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn refuses_oversized_frame_before_allocating_payload() {
        let (mut left, mut right) = duplex(64);
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt as _;
            left.write_all(&((256_u32 * 1024) + 1).to_be_bytes())
                .await
                .expect("write prefix");
        });
        let error = read_message::<RunCliRequestV1, _>(&mut right)
            .await
            .expect_err("oversized frame must fail");
        writer.await.expect("writer task");
        assert!(error.to_string().contains("frame"));
    }
}
