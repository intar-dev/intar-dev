#![forbid(unsafe_code)]

use getrandom::fill as getrandom_fill;

pub fn generate_local_unicast_mac() -> String {
    let mut bytes = [0u8; 6];
    getrandom_fill(&mut bytes).expect("OS randomness unavailable for MAC generation");

    // Ensure unicast + locally administered.
    bytes[0] = (bytes[0] & 0xfe) | 0x02;

    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_mac_is_local_unicast() {
        let mac = generate_local_unicast_mac();
        let parts: Vec<u8> = mac
            .split(':')
            .map(|p| u8::from_str_radix(p, 16).expect("hex byte"))
            .collect();
        assert_eq!(parts.len(), 6);

        // Unicast: least significant bit of first octet is 0.
        assert_eq!(parts[0] & 0x01, 0);
        // Locally administered: second least significant bit is 1.
        assert_eq!(parts[0] & 0x02, 0x02);
    }
}
