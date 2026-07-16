use super::*;

pub(super) fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, FrameError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    Ok(bytes)
}

pub(super) fn decode_frame<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, FrameError> {
    if bytes.is_empty() {
        return Err(FrameError::Empty);
    }
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge);
    }
    Ok(serde_json::from_slice(bytes)?)
}

pub(super) fn validate_tap_name(value: &str) -> Result<(), ValidationError> {
    if value.is_empty()
        || value.len() > 15
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ValidationError::InvalidTapName);
    }
    Ok(())
}

pub(super) fn is_normal_absolute_path(path: &Path) -> bool {
    let bytes = path.as_os_str().as_bytes();
    bytes.first() == Some(&b'/')
        && (bytes.len() == 1
            || bytes[1..]
                .split(|byte| *byte == b'/')
                .all(|component| !component.is_empty() && component != b"." && component != b".."))
}

pub(super) fn validate_mac(value: &str) -> Result<(), ValidationError> {
    let valid = value.len() == 17
        && value == value.to_ascii_lowercase()
        && value
            .split(':')
            .all(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let unicast = value
        .get(..2)
        .and_then(|octet| u8::from_str_radix(octet, 16).ok())
        .is_some_and(|octet| octet & 1 == 0);
    if !valid || !unicast {
        return Err(ValidationError::InvalidMacAddress);
    }
    Ok(())
}

pub(super) fn parse_cidr(value: &str) -> Result<(std::net::IpAddr, u8), ValidationError> {
    let Some((address, prefix)) = value.rsplit_once('/') else {
        return Err(ValidationError::InvalidGuestCidr);
    };
    let address: std::net::IpAddr = address
        .parse()
        .map_err(|_| ValidationError::InvalidGuestCidr)?;
    let prefix: u8 = prefix
        .parse()
        .map_err(|_| ValidationError::InvalidGuestCidr)?;
    if !address.is_ipv4() || prefix > 32 {
        return Err(ValidationError::InvalidGuestCidr);
    }
    Ok((address, prefix))
}

pub(super) fn parse_ipv4_cidr(value: &str) -> Result<(std::net::Ipv4Addr, u8), ValidationError> {
    let (address, prefix) = parse_cidr(value)?;
    let std::net::IpAddr::V4(address) = address else {
        return Err(ValidationError::InvalidGuestCidr);
    };
    Ok((address, prefix))
}

pub(super) fn ipv4_mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    }
}

pub(super) fn ipv4_subnet_contains(
    outer: std::net::Ipv4Addr,
    outer_prefix: u8,
    inner: std::net::Ipv4Addr,
    inner_prefix: u8,
) -> bool {
    inner_prefix >= outer_prefix
        && (u32::from(outer) & ipv4_mask(outer_prefix))
            == (u32::from(inner) & ipv4_mask(outer_prefix))
}

pub(super) fn validate_guest_network_pool(value: &str) -> Result<(), ValidationError> {
    let (network, prefix) =
        parse_ipv4_cidr(value).map_err(|_| ValidationError::InvalidGuestNetworkPool)?;
    let (intar_network, intar_prefix) = parse_ipv4_cidr(DEFAULT_GUEST_NETWORK_POOL)
        .expect("compiled-in guest network pool is valid");
    if prefix < intar_prefix
        || prefix > RUN_GUEST_NETWORK_PREFIX
        || u32::from(network) & !ipv4_mask(prefix) != 0
        || !ipv4_subnet_contains(intar_network, intar_prefix, network, prefix)
    {
        return Err(ValidationError::InvalidGuestNetworkPool);
    }
    Ok(())
}

pub(super) fn validate_ssh_public_port_range(start: u16, end: u16) -> Result<(), ValidationError> {
    if start < MIN_SSH_PUBLIC_PORT || end > MAX_SSH_PUBLIC_PORT || end < start {
        return Err(ValidationError::InvalidSshPortRange);
    }
    Ok(())
}
