// Keep this in lockstep with `intar_image_scenario::BUILD_FORMAT_VERSION`.
// The Worker cannot import the Rust constant directly, so bundle uploads and
// registry validation must agree on the current image format.
// Bump in lockstep with the Rust constant whenever the compiled image changes
// without a change to any hashed scenario input, such as an embedded kernel
// fix. See the Rust constant for the full rule.
export const IMAGE_BUILD_FORMAT_VERSION = "intar-image-build-v15";
