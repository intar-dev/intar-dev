use std::io::{BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, bail, ensure};
use serde_json::{Value, json};

use super::super::{connect_qmp_socket, read_qmp_message};

pub(super) struct Qmp {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    sequence: u64,
}

impl Qmp {
    pub(super) fn connect(path: &Path, deadline: Instant) -> Result<Self> {
        let stream = loop {
            match connect_qmp_socket(path) {
                Ok(stream) => break stream,
                Err(error) if Instant::now() >= deadline => return Err(error),
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        };
        stream.set_read_timeout(Some(Duration::from_millis(100)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let greeting = read_qmp_message(&mut reader, "checkpoint greeting", deadline, &|| false)?;
        ensure!(
            greeting.get("QMP").is_some_and(Value::is_object),
            "invalid checkpoint QMP greeting"
        );
        let mut qmp = Self {
            stream,
            reader,
            sequence: 0,
        };
        qmp.execute("qmp_capabilities", json!({}), deadline)?;
        Ok(qmp)
    }

    pub(super) fn execute(
        &mut self,
        command: &str,
        arguments: Value,
        deadline: Instant,
    ) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        let timeout = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .context("checkpoint QMP deadline expired before command write")?;
        self.stream
            .set_write_timeout(Some(Duration::from_secs(2).min(timeout)))
            .context("failed to set checkpoint QMP command write timeout")?;
        serde_json::to_writer(
            &mut self.stream,
            &json!({"execute": command, "arguments": arguments, "id": id}),
        )?;
        self.stream.write_all(b"\n")?;
        self.stream.flush()?;
        loop {
            let message = read_qmp_message(&mut self.reader, command, deadline, &|| false)?;
            if message.get("event").is_some() {
                ensure!(
                    message.get("event").and_then(Value::as_str) != Some("SHUTDOWN")
                        || (command == "quit"
                            && message.pointer("/data/guest").and_then(Value::as_bool)
                                == Some(false)
                            && message.pointer("/data/reason").and_then(Value::as_str)
                                == Some("host-qmp-quit")),
                    "guest shut down during checkpoint operation"
                );
                continue;
            }
            ensure!(
                message.get("id").and_then(Value::as_u64) == Some(id),
                "checkpoint QMP response ID mismatch"
            );
            if let Some(error) = message.get("error") {
                bail!("QMP {command} failed: {error}");
            }
            return message
                .get("return")
                .cloned()
                .context("QMP response has no return value");
        }
    }

    pub(super) fn wait_migration(&mut self, deadline: Instant) -> Result<()> {
        loop {
            ensure!(
                Instant::now() < deadline,
                "QEMU checkpoint migration timed out"
            );
            let status = self.execute("query-migrate", json!({}), deadline)?;
            match status.get("status").and_then(Value::as_str) {
                Some("completed") => return Ok(()),
                Some("failed" | "cancelled") => bail!("QEMU checkpoint migration failed: {status}"),
                _ => {
                    let remaining = deadline
                        .checked_duration_since(Instant::now())
                        .filter(|remaining| !remaining.is_zero())
                        .context("QEMU checkpoint migration timed out")?;
                    std::thread::sleep(Duration::from_millis(100).min(remaining));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::io::BufRead as _;
    use std::os::unix::net::UnixListener;

    #[test]
    fn checkpoint_qmp_handles_events_and_rejects_bad_ids() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("qmp.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"{\"QMP\":{}}\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            stream
                .write_all(b"{\"event\":\"STOP\"}\n{\"return\":{},\"id\":1}\n")
                .unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            stream.write_all(b"{\"return\":{},\"id\":99}\n").unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut client = Qmp::connect(&path, deadline).unwrap();
        assert!(
            client
                .execute("stop", json!({}), deadline)
                .unwrap_err()
                .to_string()
                .contains("ID mismatch")
        );
        server.join().unwrap();
    }

    #[test]
    fn checkpoint_quit_accepts_its_host_shutdown_event_before_acknowledgement() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("qmp.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.write_all(b"{\"QMP\":{}}\n").unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            stream.write_all(b"{\"return\":{},\"id\":1}\n").unwrap();
            line.clear();
            reader.read_line(&mut line).unwrap();
            stream.write_all(b"{\"event\":\"SHUTDOWN\",\"data\":{\"guest\":false,\"reason\":\"host-qmp-quit\"}}\n{\"return\":{},\"id\":2}\n").unwrap();
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut client = Qmp::connect(&path, deadline).unwrap();
        assert!(client.execute("quit", json!({}), deadline).is_ok());
        server.join().unwrap();
    }
}
