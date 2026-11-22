//! A repository compiled into one `SourceBundleV2`, and the bundle's wire
//! encoding: gzipped JSON of at most `MAX_SOURCE_BUNDLE_GZIP_BYTES`.

use super::courses::load_courses;
use super::{Diagnostic, LoweredScript, load_repository};
use flate2::{Compression, GzBuilder};
use intar_contracts::oci::IMAGE_FORMAT;
use intar_contracts::source::{
    MAX_SOURCE_BUNDLE_GZIP_BYTES, SOURCE_COMPILER_VERSION_V2, SourceBundleV2, validate_bundle,
};
use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::Path;

/// The bundle of the repository at `root` and its lowered scripts for the
/// lints, or every problem found.
pub fn compile(root: &Path) -> Result<(SourceBundleV2, Vec<LoweredScript>), Vec<Diagnostic>> {
    // Lecture links resolve against the scenario directories, so a broken
    // scenario does not also break every lecture that links it.
    let slugs: Vec<String> = std::fs::read_dir(root.join("scenarios"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().join("scenario.hcl").is_file())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let slugs: BTreeSet<&str> = slugs.iter().map(String::as_str).collect();
    let repository = load_repository(root);
    let catalog = load_courses(root, &slugs);
    let (repository, course_catalog) = match (repository, catalog) {
        (Ok(repository), Ok(catalog)) => (repository, catalog),
        (repository, catalog) => {
            let mut problems = repository.err().unwrap_or_default();
            problems.extend(catalog.err().unwrap_or_default());
            return Err(problems);
        }
    };
    // A scenario is reached through a course only (#494), so one no lecture
    // names would be published and never started. Here and not in the bundle
    // rules: a bundle stored before this must stay readable.
    let named: BTreeSet<&str> = course_catalog
        .courses
        .iter()
        .flat_map(|course| &course.lectures)
        .filter_map(|lecture| lecture.scenario_id.as_deref())
        .collect();
    let unnamed: Vec<Diagnostic> = repository
        .scenarios
        .iter()
        .filter(|scenario| !named.contains(scenario.slug.as_str()))
        .map(|scenario| Diagnostic {
            path: Path::new("scenarios").join(&scenario.slug).join("scenario.hcl"),
            line: 0,
            column: 0,
            message: format!(
                "no lecture names the scenario `{}`: give a lecture of a course `scenario: {}`, or remove the scenario",
                scenario.slug, scenario.slug
            ),
        })
        .collect();
    if !unnamed.is_empty() {
        return Err(unnamed);
    }
    let bundle = SourceBundleV2 {
        compiler: SOURCE_COMPILER_VERSION_V2.to_owned(),
        image_format: IMAGE_FORMAT.to_owned(),
        scenarios: repository.scenarios,
        images: repository.images,
        course_catalog,
    };
    // The loader has checked all of this already; the bundle rules are what
    // the Worker and the builder check again.
    validate_bundle(&bundle).map_err(|problems| {
        problems
            .into_iter()
            .map(|message| Diagnostic {
                path: ".".into(),
                line: 0,
                column: 0,
                message,
            })
            .collect::<Vec<_>>()
    })?;
    Ok((bundle, repository.scripts))
}

/// The bundle as gzipped JSON, or why it is too large. The same bundle
/// always encodes to the same bytes.
pub fn encode_bundle(bundle: &SourceBundleV2) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(bundle).map_err(|error| error.to_string())?;
    let mut encoder = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::best());
    encoder
        .write_all(&json)
        .map_err(|error| error.to_string())?;
    let gzipped = encoder.finish().map_err(|error| error.to_string())?;
    if gzipped.len() > MAX_SOURCE_BUNDLE_GZIP_BYTES {
        return Err(format!(
            "bundle_too_large: the bundle is {} bytes gzipped, over the {MAX_SOURCE_BUNDLE_GZIP_BYTES} byte limit",
            gzipped.len()
        ));
    }
    Ok(gzipped)
}
