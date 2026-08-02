// Keep this in lockstep with `intar_image_scenario::BUILD_FORMAT_VERSION`.
// The Worker cannot import the Rust constant directly, while both authoring
// uploads and registry validation must agree on the current image format.
export const IMAGE_BUILD_FORMAT_VERSION = "intar-image-build-v8";
