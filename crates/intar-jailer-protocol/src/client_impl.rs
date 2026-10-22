use super::*;

impl AsyncSeqpacketClient {
    pub fn connect(path: &Path) -> Result<Self, ClientError> {
        #[cfg(target_os = "linux")]
        let flags = SocketFlags::CLOEXEC;
        #[cfg(not(target_os = "linux"))]
        let flags = SocketFlags::empty();
        let fd = socket_with(AddressFamily::UNIX, SocketType::SEQPACKET, flags, None)?;
        let address = SocketAddrUnix::new(path)?;
        connect(&fd, &address)?;
        #[cfg(target_os = "linux")]
        if rustix::net::sockopt::socket_peercred(&fd)?.uid != rustix::process::Uid::ROOT {
            return Err(ClientError::UnauthorizedPeer);
        }
        #[cfg(not(target_os = "linux"))]
        rustix::io::fcntl_setfd(&fd, rustix::io::FdFlags::CLOEXEC)?;
        rustix::fs::fcntl_setfl(&fd, rustix::fs::OFlags::NONBLOCK)?;
        Ok(Self {
            io: AsyncFd::new(fd)?,
            next_request_id: 1,
        })
    }

    pub async fn request(&mut self, request: Request) -> Result<Response, ClientError> {
        let request_id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        let frame = RequestEnvelope::new(request_id, request).encode()?;

        loop {
            let mut ready = self.io.writable().await?;
            match ready.try_io(|fd| {
                send(fd, &frame, SendFlags::empty())
                    .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
            }) {
                Ok(Ok(written)) if written == frame.len() => break,
                Ok(Ok(_)) => return Err(ClientError::TruncatedPacket),
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => continue,
            }
        }

        let mut buffer = vec![0_u8; MAX_FRAME_BYTES + 1];
        let length = loop {
            let mut ready = self.io.readable().await?;
            match ready.try_io(|fd| {
                recv(fd, &mut buffer, RecvFlags::empty())
                    .map_err(|error| std::io::Error::from_raw_os_error(error.raw_os_error()))
            }) {
                Ok(Ok((_, length))) => break length,
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => continue,
            }
        };
        if length > MAX_FRAME_BYTES {
            return Err(ClientError::Frame(FrameError::TooLarge));
        }
        let response = ResponseEnvelope::decode(&buffer[..length])?;
        if response.version != PROTOCOL_VERSION {
            return Err(ClientError::UnsupportedVersion(response.version));
        }
        if response.request_id != request_id {
            return Err(ClientError::MismatchedRequestId {
                expected: request_id,
                actual: response.request_id,
            });
        }
        Ok(response.response)
    }
}
