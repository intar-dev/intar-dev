//! `build_key`: the identity of a built image (#311 §6.1). The Worker and
//! the builder each recompute it from a bundle's inline inputs and refuse a
//! bundle or build whose claimed key differs, so the encoding below is a
//! contract. A TypeScript port must match it byte for byte; the golden
//! vectors in `fixtures/scenario/build-keys.json` pin it.
//!
//! # Encoding
//!
//! A key is `sha256:` and the lowercase hex SHA-256 of one record:
//!
//! ```text
//! record = str(IMAGE_FORMAT) str(kind) str(parent)
//!          list(defer) list(env) list(stages) str(disk) [str("wake")]
//! str(s)   = u32be(byte length of s as UTF-8) ‖ the UTF-8 bytes of s
//! list(xs) = u32be(number of items) ‖ each item
//! defer item = str(unit)                  units sorted by byte order, duplicates dropped
//! env item   = str(name) ‖ str(value)     sorted by name in byte order
//! stage item = str(name) ‖ str(script)    lowered stages in run order (`packages` first)
//! ```
//!
//! - `kind` is `base`, `image` or `machine`, so an image and a machine with
//!   the same inputs never share a key.
//! - `parent` is the parent's key as text (`sha256:…`); the base, which has
//!   no parent, puts its name `trixie` there.
//! - `disk` is the geometry in MiB as decimal ASCII, or empty.
//! - `str("wake")` ends the record of an image with `wake = true` only, so
//!   every other key is the same as before wake images existed.
//!
//! Which inputs a record holds:
//!
//! | Node | defer | env | stages | disk |
//! |---|---|---|---|---|
//! | base `trixie` | none | none | none | empty |
//! | image | its own | none | its setup | its `disk` when `from = "trixie"`, else empty |
//! | machine with setup (or packages) | its own | its `env` | its setup | its `disk` when `from = "trixie"`, else empty |
//! | machine without setup | its own | none | none | empty |
//!
//! A machine with no setup, no packages and no `defer` of its own on
//! `trixie` builds nothing: its key is the base key. A zero-setup machine on
//! a repository image still gets a key of its own (image key, defer), for its
//! finalize. `scenario_id` and `egress` are never inputs, so the same machine
//! in two scenarios, or with `egress` flipped, has the same key.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest as _, Sha256};

use super::{ImageV1, MachineV1, PLATFORM_BASE_IMAGE, ScenarioV1, ScriptV1};
use crate::oci::{IMAGE_FORMAT, OciDigest};

/// The keys of a scenario's machines and of its repository's images.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BuildKeys {
    pub images: BTreeMap<String, OciDigest>,
    pub machines: BTreeMap<String, OciDigest>,
}

struct Record<'a> {
    kind: &'a str,
    parent: &'a str,
    defer: &'a [String],
    env: Option<&'a BTreeMap<String, String>>,
    stages: &'a [ScriptV1],
    disk: Option<u32>,
    wake: bool,
}

fn put(bytes: &mut Vec<u8>, text: &str) {
    count(bytes, text.len());
    bytes.extend_from_slice(text.as_bytes());
}

fn count(bytes: &mut Vec<u8>, length: usize) {
    // Every field is capped far below 4 GiB (64 KiB scripts).
    let length = u32::try_from(length).unwrap_or(u32::MAX);
    bytes.extend_from_slice(&length.to_be_bytes());
}

fn key(record: &Record) -> OciDigest {
    let mut bytes = Vec::new();
    put(&mut bytes, IMAGE_FORMAT);
    put(&mut bytes, record.kind);
    put(&mut bytes, record.parent);
    let defer: BTreeSet<&str> = record.defer.iter().map(String::as_str).collect();
    count(&mut bytes, defer.len());
    for unit in defer {
        put(&mut bytes, unit);
    }
    let env = record.env.map(BTreeMap::iter).into_iter().flatten();
    count(&mut bytes, record.env.map_or(0, BTreeMap::len));
    for (name, value) in env {
        put(&mut bytes, name);
        put(&mut bytes, value);
    }
    count(&mut bytes, record.stages.len());
    for stage in record.stages {
        put(&mut bytes, &stage.name);
        put(&mut bytes, &stage.script);
    }
    put(
        &mut bytes,
        &record.disk.map(|mib| mib.to_string()).unwrap_or_default(),
    );
    if record.wake {
        put(&mut bytes, "wake");
    }
    OciDigest::from_sha256(&Sha256::digest(&bytes).into())
}

/// The key of the platform base `trixie`.
pub fn base_key() -> OciDigest {
    key(&Record {
        kind: "base",
        parent: PLATFORM_BASE_IMAGE,
        defer: &[],
        env: None,
        stages: &[],
        disk: None,
        wake: false,
    })
}

/// The key of every repository image, or why one has none (an unknown
/// `from` or a cycle).
pub fn image_keys(images: &[ImageV1]) -> Result<BTreeMap<String, OciDigest>, String> {
    let by_name: BTreeMap<&str, &ImageV1> = images
        .iter()
        .map(|image| (image.name.as_str(), image))
        .collect();
    let mut keys = BTreeMap::new();
    for image in images {
        image_key(&image.name, &by_name, &mut keys, &mut Vec::new())?;
    }
    Ok(keys)
}

fn image_key(
    name: &str,
    by_name: &BTreeMap<&str, &ImageV1>,
    keys: &mut BTreeMap<String, OciDigest>,
    walking: &mut Vec<String>,
) -> Result<OciDigest, String> {
    if name == PLATFORM_BASE_IMAGE {
        return Ok(base_key());
    }
    if let Some(found) = keys.get(name) {
        return Ok(found.clone());
    }
    if walking.iter().any(|seen| seen == name) {
        return Err(format!("image `{name}`: its from chain forms a cycle"));
    }
    let image = by_name
        .get(name)
        .ok_or_else(|| format!("`{name}` names no image"))?;
    walking.push(name.to_owned());
    let parent = image_key(&image.from, by_name, keys, walking)?;
    walking.pop();
    let found = key(&Record {
        kind: "image",
        parent: parent.as_str(),
        defer: &image.defer,
        env: None,
        stages: &image.setup,
        disk: if image.from == PLATFORM_BASE_IMAGE {
            image.disk_mib
        } else {
            None
        },
        wake: image.wake,
    });
    keys.insert(name.to_owned(), found.clone());
    Ok(found)
}

fn machine_key(
    machine: &MachineV1,
    images: &BTreeMap<String, OciDigest>,
) -> Result<OciDigest, String> {
    let on_base = machine.from == PLATFORM_BASE_IMAGE;
    let parent = if on_base {
        base_key()
    } else {
        images.get(&machine.from).cloned().ok_or_else(|| {
            format!(
                "machine `{}`: from `{}` names no image",
                machine.name, machine.from
            )
        })?
    };
    // `packages` is lowered into the first setup stage.
    let builds = !machine.setup.is_empty();
    if on_base && !builds && machine.defer.is_empty() {
        return Ok(parent);
    }
    Ok(key(&Record {
        kind: "machine",
        parent: parent.as_str(),
        defer: &machine.defer,
        env: builds.then_some(&machine.env),
        stages: &machine.setup,
        disk: (on_base && builds).then_some(machine.disk_mib),
        wake: false,
    }))
}

/// The key of every machine of `scenario` and of every image of its
/// repository.
pub fn build_keys(scenario: &ScenarioV1, images: &[ImageV1]) -> Result<BuildKeys, String> {
    let images = image_keys(images)?;
    let machines = scenario
        .machines
        .iter()
        .map(|machine| Ok((machine.name.clone(), machine_key(machine, &images)?)))
        .collect::<Result<_, String>>()?;
    Ok(BuildKeys { images, machines })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenario::Difficulty;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vectors {
        image_format: String,
        base_key: OciDigest,
        cases: Vec<Case>,
        /// `case/machine` pairs whose keys must be equal.
        equal: Vec<[String; 2]>,
        /// `case/machine` pairs whose keys must differ.
        differ: Vec<[String; 2]>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Case {
        name: String,
        scenario: String,
        images: Vec<ImageV1>,
        machines: Vec<MachineV1>,
        keys: Keys,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Keys {
        images: BTreeMap<String, OciDigest>,
        machines: BTreeMap<String, OciDigest>,
    }

    fn scenario(slug: &str, machines: Vec<MachineV1>) -> ScenarioV1 {
        ScenarioV1 {
            slug: slug.to_owned(),
            title: String::new(),
            summary: String::new(),
            difficulty: Difficulty::Easy,
            minutes: 1,
            tags: Vec::new(),
            credit: None,
            play: false,
            briefing: String::new(),
            solution: String::new(),
            hints: Vec::new(),
            machines,
            tasks: Vec::new(),
        }
    }

    #[test]
    fn the_golden_vectors_hold() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../../fixtures/scenario/build-keys.json"))
                .expect("the vectors parse");
        assert_eq!(vectors.image_format, IMAGE_FORMAT);
        assert_eq!(vectors.base_key, base_key());
        let mut found = BTreeMap::new();
        for case in vectors.cases {
            let keys = build_keys(&scenario(&case.scenario, case.machines), &case.images)
                .unwrap_or_else(|problem| panic!("{}: {problem}", case.name));
            assert_eq!(keys.images, case.keys.images, "{}", case.name);
            assert_eq!(keys.machines, case.keys.machines, "{}", case.name);
            for (machine, key) in keys.machines {
                found.insert(format!("{}/{machine}", case.name), key);
            }
        }
        let key = |name: &String| {
            found
                .get(name)
                .unwrap_or_else(|| panic!("no vector `{name}`"))
        };
        for [one, other] in &vectors.equal {
            assert_eq!(key(one), key(other), "{one} = {other}");
        }
        for [one, other] in &vectors.differ {
            assert_ne!(key(one), key(other), "{one} != {other}");
        }
    }

    #[test]
    fn unknown_parents_and_cycles_have_no_key() {
        let image = |name: &str, from: &str| ImageV1 {
            name: name.to_owned(),
            from: from.to_owned(),
            disk_mib: None,
            defer: Vec::new(),
            setup: Vec::new(),
            wake: false,
        };
        let looped = [image("a-img", "b-img"), image("b-img", "a-img")];
        assert!(image_keys(&looped).is_err_and(|problem| problem.contains("cycle")));
        assert!(image_keys(&[image("a-img", "nope")]).is_err());
    }
}
