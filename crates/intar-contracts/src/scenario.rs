//! The lowered scenario format: what the loader produces from `scenario.hcl`
//! and `images/*.hcl`, and the rules every consumer checks again.
//!
//! Nothing here knows HCL. Every script is lowered bash, every markdown
//! field is inlined text.

mod build_key;

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub use build_key::{BuildKeys, base_key, build_keys, image_keys};

/// The platform base image every chain starts from.
pub const PLATFORM_BASE_IMAGE: &str = "trixie";
pub const MAX_MACHINES: usize = 8;
pub const MAX_TASKS_PER_MACHINE: usize = 32;
pub const MAX_READY_PER_MACHINE: usize = 16;
pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
pub const MAX_MARKDOWN_BYTES: usize = 64 * 1024;
pub const MAX_MACHINE_SPEC_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Difficulty {
    Easy,
    Medium,
    Hard,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioV1 {
    pub slug: String,
    pub title: String,
    pub summary: String,
    pub difficulty: Difficulty,
    pub minutes: u32,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credit: Option<String>,
    pub play: bool,
    pub briefing: String,
    pub solution: String,
    pub hints: Vec<HintV1>,
    /// File order is the terminal tab order.
    pub machines: Vec<MachineV1>,
    /// File order is the order learners see.
    pub tasks: Vec<TaskV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HintV1 {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MachineV1 {
    pub name: String,
    #[schemars(range(min = 1))]
    pub cpu_millis: u32,
    pub memory_mib: u32,
    pub disk_mib: u32,
    /// `trixie` or the name of an image.
    pub from: String,
    pub defer: Vec<String>,
    pub terminal: bool,
    pub egress: bool,
    pub env: BTreeMap<String, String>,
    /// Build-time stages in run order; `packages` is lowered to the first.
    pub setup: Vec<ScriptV1>,
    pub ready: Vec<ScriptV1>,
}

/// A named lowered bash script: a setup stage or a ready block.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScriptV1 {
    pub name: String,
    pub script: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TaskV1 {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub machine: String,
    /// Bare task IDs, on any machine.
    pub needs: Vec<String>,
    pub optional: bool,
    /// The task's check bodies lowered into one script.
    pub check: String,
    /// Absent on an implied task: it must pass once its needs pass.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve: Option<String>,
    pub hints: Vec<HintV1>,
}

/// A repository image, `images/<name>.hcl`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImageV1 {
    pub name: String,
    pub from: String,
    /// The chain's build geometry: set exactly when `from` is `trixie`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_mib: Option<u32>,
    pub defer: Vec<String>,
    pub setup: Vec<ScriptV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecMode {
    Learn,
    Verify,
}

/// What one machine's Kino runs. A learn spec holds no solve script and no
/// other machine's scripts.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MachineSpecV1 {
    /// `<org-slug>/<scenario-slug>`; empty on a build boot.
    pub scenario_id: String,
    pub machine: String,
    pub env: BTreeMap<String, String>,
    pub defer: Vec<String>,
    pub ready: Vec<ScriptV1>,
    pub tasks: Vec<SpecTaskV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpecTaskV1 {
    pub id: String,
    pub check: String,
    /// A need on another machine is `<machine>/<task-id>`.
    pub needs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solve: Option<String>,
}

impl ScenarioV1 {
    /// The spec of one machine, or `None` for an unknown machine. `defer`
    /// is the machine's own; the image chain's is baked into the image.
    pub fn machine_spec(
        &self,
        scenario_id: &str,
        machine: &str,
        mode: SpecMode,
    ) -> Option<MachineSpecV1> {
        let declared = self.machines.iter().find(|entry| entry.name == machine)?;
        let home: BTreeMap<&str, &str> = self
            .tasks
            .iter()
            .map(|task| (task.id.as_str(), task.machine.as_str()))
            .collect();
        let tasks = self
            .tasks
            .iter()
            .filter(|task| task.machine == machine)
            .map(|task| SpecTaskV1 {
                id: task.id.clone(),
                check: task.check.clone(),
                needs: task
                    .needs
                    .iter()
                    .map(|need| match home.get(need.as_str()) {
                        Some(other) if *other != machine => format!("{other}/{need}"),
                        _ => need.clone(),
                    })
                    .collect(),
                solve: match mode {
                    SpecMode::Learn => None,
                    SpecMode::Verify => task.solve.clone(),
                },
            })
            .collect();
        Some(MachineSpecV1 {
            scenario_id: scenario_id.to_owned(),
            machine: machine.to_owned(),
            env: declared.env.clone(),
            defer: declared.defer.clone(),
            ready: declared.ready.clone(),
            tasks,
        })
    }
}

/// `^[a-z0-9][a-z0-9-]{2,62}$`
pub fn is_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (3..=63).contains(&bytes.len())
        && bytes[0] != b'-'
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// Every rule a lowered scenario and its repository's images must keep. The
/// loader, the Worker's ingest and the builder all run it; the result lists
/// every problem found.
pub fn validate(scenario: &ScenarioV1, images: &[ImageV1]) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    let mut problem = |text: String| problems.push(text);

    let geometry = image_geometry(images, &mut problem);

    if !is_id(&scenario.slug) {
        problem(format!("scenario `{}`: not a valid ID", scenario.slug));
    }
    for (field, text) in [
        ("briefing", Some(&scenario.briefing)),
        ("solution", Some(&scenario.solution)),
        ("credit", scenario.credit.as_ref()),
    ] {
        if text.is_some_and(|text| text.len() > MAX_MARKDOWN_BYTES) {
            problem(format!("{field}: over {MAX_MARKDOWN_BYTES} bytes"));
        }
    }
    check_hints("scenario", &scenario.hints, &mut problem);

    if scenario.machines.is_empty() || scenario.machines.len() > MAX_MACHINES {
        problem(format!("a scenario has 1 to {MAX_MACHINES} machines"));
    }
    let mut machine_names = BTreeSet::new();
    for machine in &scenario.machines {
        let name = &machine.name;
        if !is_id(name) {
            problem(format!("machine `{name}`: not a valid ID"));
        }
        if !machine_names.insert(name.as_str()) {
            problem(format!("machine `{name}`: declared twice"));
        }
        if machine.cpu_millis == 0 || machine.memory_mib == 0 {
            problem(format!(
                "machine `{name}`: cpu and memory must be above zero"
            ));
        }
        match geometry.get(machine.from.as_str()) {
            None => problem(format!(
                "machine `{name}`: from `{}` names no image",
                machine.from
            )),
            Some(minimum) if machine.disk_mib < *minimum => problem(format!(
                "machine `{name}`: disk is smaller than its image's {minimum} MiB"
            )),
            Some(_) => {}
        }
        if machine.ready.len() > MAX_READY_PER_MACHINE {
            problem(format!(
                "machine `{name}`: more than {MAX_READY_PER_MACHINE} ready blocks"
            ));
        }
        check_scripts(
            &format!("machine `{name}` setup"),
            &machine.setup,
            &mut problem,
        );
        check_scripts(
            &format!("machine `{name}` ready"),
            &machine.ready,
            &mut problem,
        );
        let tasks = scenario.tasks.iter().filter(|task| task.machine == *name);
        if tasks.count() > MAX_TASKS_PER_MACHINE {
            problem(format!(
                "machine `{name}`: more than {MAX_TASKS_PER_MACHINE} tasks"
            ));
        }
        let spec = scenario.machine_spec("", name, SpecMode::Verify);
        let size = spec
            .and_then(|spec| serde_json::to_vec(&spec).ok())
            .map(|json| json.len());
        if size.is_none_or(|size| size > MAX_MACHINE_SPEC_BYTES) {
            problem(format!(
                "machine `{name}`: its spec is over {MAX_MACHINE_SPEC_BYTES} bytes"
            ));
        }
    }

    let mut task_ids = BTreeSet::new();
    for task in &scenario.tasks {
        let id = &task.id;
        if !is_id(id) {
            problem(format!("task `{id}`: not a valid ID"));
        }
        if !task_ids.insert(id.as_str()) {
            problem(format!("task `{id}`: declared twice"));
        }
        if !machine_names.contains(task.machine.as_str()) {
            problem(format!(
                "task `{id}`: machine `{}` is not declared",
                task.machine
            ));
        }
        if task.check.trim().is_empty() {
            problem(format!("task `{id}`: needs a check"));
        }
        if task.solve.is_none() && task.needs.is_empty() {
            problem(format!(
                "task `{id}`: has neither solve nor needs, so it cannot be verified"
            ));
        }
        for (what, script) in [("check", Some(&task.check)), ("solve", task.solve.as_ref())] {
            if script.is_some_and(|script| script.len() > MAX_SCRIPT_BYTES) {
                problem(format!("task `{id}` {what}: over {MAX_SCRIPT_BYTES} bytes"));
            }
        }
        if task
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_MARKDOWN_BYTES)
        {
            problem(format!("task `{id}` body: over {MAX_MARKDOWN_BYTES} bytes"));
        }
        check_hints(&format!("task `{id}`"), &task.hints, &mut problem);
    }
    for task in &scenario.tasks {
        for need in &task.needs {
            if !task_ids.contains(need.as_str()) {
                problem(format!("task `{}`: needs unknown task `{need}`", task.id));
            }
        }
    }
    let edges = scenario
        .tasks
        .iter()
        .map(|task| {
            (
                task.id.as_str(),
                task.needs.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    if let Some(id) = cycle_member(&edges) {
        problem(format!("task `{id}`: its needs form a cycle"));
    }

    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// The image rules alone, for a repository that may have no scenario.
pub fn validate_images(images: &[ImageV1]) -> Result<(), Vec<String>> {
    let mut problems = Vec::new();
    image_geometry(images, &mut |text| problems.push(text));
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// Each usable `from` name with its chain's disk geometry in MiB (0 for the
/// platform base, which a machine may grow freely).
fn image_geometry<'a>(
    images: &'a [ImageV1],
    problem: &mut impl FnMut(String),
) -> BTreeMap<&'a str, u32> {
    let mut by_name = BTreeMap::new();
    for image in images {
        let name = image.name.as_str();
        if !is_id(name) || name == PLATFORM_BASE_IMAGE {
            problem(format!("image `{name}`: not a valid image name"));
        }
        if by_name.insert(name, image).is_some() {
            problem(format!("image `{name}`: declared twice"));
        }
        if (image.from == PLATFORM_BASE_IMAGE) != image.disk_mib.is_some() {
            problem(format!(
                "image `{name}`: disk is set exactly when from is `{PLATFORM_BASE_IMAGE}`"
            ));
        }
        check_scripts(&format!("image `{name}` setup"), &image.setup, problem);
    }
    let edges = by_name
        .iter()
        .map(|(name, image)| (*name, vec![image.from.as_str()]))
        .collect();
    if let Some(name) = cycle_member(&edges) {
        problem(format!("image `{name}`: its from chain forms a cycle"));
        return BTreeMap::new();
    }
    let mut geometry = BTreeMap::from([(PLATFORM_BASE_IMAGE, 0)]);
    for name in by_name.keys() {
        let mut image = by_name[name];
        // No cycle, so the walk ends at the base or at an unknown name.
        while image.from != PLATFORM_BASE_IMAGE {
            match by_name.get(image.from.as_str()) {
                Some(parent) => image = parent,
                None => break,
            }
        }
        if image.from == PLATFORM_BASE_IMAGE {
            geometry.insert(*name, image.disk_mib.unwrap_or(0));
        } else {
            problem(format!(
                "image `{name}`: from `{}` names no image",
                image.from
            ));
        }
    }
    geometry
}

fn check_scripts(context: &str, scripts: &[ScriptV1], problem: &mut impl FnMut(String)) {
    let mut names = BTreeSet::new();
    for entry in scripts {
        let name = &entry.name;
        if !is_id(name) {
            problem(format!("{context} `{name}`: not a valid ID"));
        }
        if !names.insert(name.as_str()) {
            problem(format!("{context} `{name}`: declared twice"));
        }
        if entry.script.len() > MAX_SCRIPT_BYTES {
            problem(format!("{context} `{name}`: over {MAX_SCRIPT_BYTES} bytes"));
        }
    }
}

fn check_hints(context: &str, hints: &[HintV1], problem: &mut impl FnMut(String)) {
    let mut ids = BTreeSet::new();
    for hint in hints {
        let id = &hint.id;
        if !is_id(id) {
            problem(format!("{context} hint `{id}`: not a valid ID"));
        }
        if !ids.insert(id.as_str()) {
            problem(format!("{context} hint `{id}`: declared twice"));
        }
        if hint.body.len() > MAX_MARKDOWN_BYTES {
            problem(format!(
                "{context} hint `{id}`: over {MAX_MARKDOWN_BYTES} bytes"
            ));
        }
    }
}

/// A node on a cycle of `edges`, if there is one. Edges to unknown nodes are
/// ignored.
fn cycle_member<'a>(edges: &BTreeMap<&'a str, Vec<&'a str>>) -> Option<&'a str> {
    // Kahn: peel nodes nothing unpeeled points at; what is left holds a cycle.
    let mut left: BTreeSet<&str> = edges.keys().copied().collect();
    loop {
        let free = left
            .iter()
            .copied()
            .find(|node| edges[node].iter().all(|next| !left.contains(next)));
        match free {
            Some(node) => left.remove(node),
            None => return left.first().copied(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script(name: &str) -> ScriptV1 {
        ScriptV1 {
            name: name.to_owned(),
            script: "true".to_owned(),
        }
    }

    fn task(id: &str, machine: &str, needs: &[&str], solve: bool) -> TaskV1 {
        TaskV1 {
            id: id.to_owned(),
            title: id.to_owned(),
            body: None,
            machine: machine.to_owned(),
            needs: needs.iter().map(|need| (*need).to_owned()).collect(),
            optional: false,
            check: "true".to_owned(),
            solve: solve.then(|| "fix".to_owned()),
            hints: Vec::new(),
        }
    }

    fn machine(name: &str, from: &str) -> MachineV1 {
        MachineV1 {
            name: name.to_owned(),
            cpu_millis: 2000,
            memory_mib: 3072,
            disk_mib: 8192,
            from: from.to_owned(),
            defer: vec!["k3s.service".to_owned()],
            terminal: true,
            egress: false,
            env: BTreeMap::from([("KUBECONFIG".to_owned(), "/etc/k".to_owned())]),
            setup: vec![script("faults")],
            ready: vec![script("node")],
        }
    }

    fn scenario() -> ScenarioV1 {
        ScenarioV1 {
            slug: "two-routers".to_owned(),
            title: "Two routers".to_owned(),
            summary: "s".to_owned(),
            difficulty: Difficulty::Easy,
            minutes: 30,
            tags: Vec::new(),
            credit: None,
            play: false,
            briefing: "b".to_owned(),
            solution: "s".to_owned(),
            hints: Vec::new(),
            machines: vec![machine("router-a", "k3s"), machine("router-b", "trixie")],
            tasks: vec![
                task("a-up", "router-a", &[], true),
                task("b-peers", "router-b", &["a-up"], true),
                task("both", "router-a", &["a-up", "b-peers"], false),
            ],
        }
    }

    fn images() -> Vec<ImageV1> {
        vec![ImageV1 {
            name: "k3s".to_owned(),
            from: "trixie".to_owned(),
            disk_mib: Some(8192),
            defer: Vec::new(),
            setup: vec![script("install")],
        }]
    }

    fn problems(scenario: &ScenarioV1, images: &[ImageV1]) -> String {
        validate(scenario, images)
            .err()
            .unwrap_or_default()
            .join("\n")
    }

    #[test]
    fn a_sound_scenario_passes() {
        assert_eq!(problems(&scenario(), &images()), "");
    }

    #[test]
    fn specs_qualify_peer_needs_and_learn_drops_solves() {
        let scenario = scenario();
        let verify = scenario.machine_spec("intar/two-routers", "router-a", SpecMode::Verify);
        let verify = verify.unwrap_or_default();
        assert_eq!(verify.tasks.len(), 2);
        assert_eq!(verify.tasks[1].needs, ["a-up", "router-b/b-peers"]);
        assert!(verify.tasks[0].solve.is_some());
        let learn = scenario.machine_spec("intar/two-routers", "router-a", SpecMode::Learn);
        let learn = serde_json::to_string(&learn).unwrap_or_default();
        assert!(
            !learn.contains("solve") && !learn.contains("fix"),
            "{learn}"
        );
        assert!(
            scenario
                .machine_spec("x", "nope", SpecMode::Learn)
                .is_none()
        );
    }

    #[test]
    fn each_rule_is_enforced() {
        type Break = fn(&mut ScenarioV1, &mut Vec<ImageV1>);
        let broken: [(&str, Break); 14] = [
            ("not a valid ID", |s, _| s.slug = "Ab".to_owned()),
            ("1 to 8 machines", |s, _| s.machines.clear()),
            ("declared twice", |s, _| {
                s.machines[1].name = "router-a".to_owned()
            }),
            ("names no image", |s, _| {
                s.machines[0].from = "nope".to_owned()
            }),
            ("smaller than its image", |s, _| {
                s.machines[0].disk_mib = 4096
            }),
            ("ready blocks", |s, _| {
                s.machines[0].ready = (0..17).map(|n| script(&format!("r-{n:02}"))).collect();
            }),
            ("more than 32 tasks", |s, _| {
                s.tasks = (0..33)
                    .map(|n| task(&format!("t-{n:02}"), "router-a", &[], true))
                    .collect();
            }),
            ("is not declared", |s, _| {
                s.tasks[0].machine = "nope".to_owned()
            }),
            ("needs a check", |s, _| s.tasks[0].check = " ".to_owned()),
            ("cannot be verified", |s, _| s.tasks[0].solve = None),
            ("unknown task", |s, _| {
                s.tasks[1].needs = vec!["nope".to_owned()]
            }),
            ("form a cycle", |s, _| {
                s.tasks[0].needs = vec!["both".to_owned()]
            }),
            ("over 65536 bytes", |s, _| {
                s.tasks[0].check = "x".repeat(MAX_SCRIPT_BYTES + 1)
            }),
            ("disk is set exactly", |_, i| i[0].disk_mib = None),
        ];
        for (expected, mutate) in broken {
            let (mut scenario, mut images) = (scenario(), images());
            mutate(&mut scenario, &mut images);
            let found = problems(&scenario, &images);
            assert!(
                found.contains(expected),
                "expected `{expected}` in `{found}`"
            );
        }
    }

    #[test]
    fn image_chains_resolve_and_cycles_are_refused() {
        let mut images = images();
        images.push(ImageV1 {
            name: "klustered".to_owned(),
            from: "k3s".to_owned(),
            disk_mib: None,
            defer: Vec::new(),
            setup: Vec::new(),
        });
        let mut scenario = scenario();
        scenario.machines[0].from = "klustered".to_owned();
        assert_eq!(problems(&scenario, &images), "");
        scenario.machines[0].disk_mib = 100;
        assert!(problems(&scenario, &images).contains("smaller than its image"));
        images[0].from = "klustered".to_owned();
        images[0].disk_mib = None;
        assert!(problems(&scenario, &images).contains("from chain forms a cycle"));
    }

    #[test]
    fn a_spec_over_the_limit_is_refused() {
        let mut scenario = scenario();
        scenario.tasks = (0..8)
            .map(|n| {
                let mut task = task(&format!("t-{n:02}"), "router-a", &[], true);
                task.check = "x".repeat(40 * 1024);
                task
            })
            .collect();
        assert!(problems(&scenario, &images()).contains("its spec is over"));
    }
}
