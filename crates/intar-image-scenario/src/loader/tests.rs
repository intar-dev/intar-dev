use super::lower::shell_quote;
use super::*;
use intar_contracts::scenario::SpecMode;
use std::process::Command;

const SCENARIO: &str = r#"scenario "repair-nginx" {
  title      = "Repair nginx"
  summary    = "A web server is down."
  difficulty = "easy"
  minutes    = 20
  tags       = ["linux"]
  briefing   = markdown("briefing.md")
  solution   = <<-MD
    Start it: `systemctl start nginx`.
    MD

  hint "look" {
    body = "Look at the unit."
  }

  machine "web" {
    cpu      = 2
    memory   = "3Gi"
    disk     = "8Gi"
    from     = "base-web"
    packages = ["nginx", "curl"]
    defer    = ["nginx.service"]
    env      = { KUBECONFIG = "/etc/k" }

    setup "break" {
      run = file("break.sh")
    }
    setup "page" {
      file {
        path    = "/var/www/html/index.html"
        content = "it's <up>\n"
        mode    = "0644"
        owner   = "www-data:www-data"
      }
    }
    ready "unit" { service = "nginx" }
  }

  task "nginx-runs" {
    title = "nginx runs"
    check { service = "nginx" }
    check {
      http     = "http://127.0.0.1/"
      contains = "up"
      fail     = "The page is not served."
    }
    solve {
      run = <<-SH
        systemctl start nginx
        echo "$${HOME:-none}" '%%{http_code}'
        SH
    }
  }

  task "page-served" {
    title = "The page is served"
    needs = ["nginx-runs"]
    check { port = 80 }
  }
}
"#;

const IMAGE: &str = r#"image "base-web" {
  from = "trixie"
  disk = "8Gi"
  setup "tools" { run = "apt-get install -y jq" }
}
"#;

/// A repository with one image and one scenario; `change` edits files first.
fn repository(
    change: impl FnOnce(&Path),
) -> (tempfile::TempDir, Result<Repository, Vec<Diagnostic>>) {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path();
    let write = |path: &str, text: &str| {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    };
    write("intar.hcl", "repository {}\n");
    write("images/base-web.hcl", IMAGE);
    write("scenarios/repair-nginx/scenario.hcl", SCENARIO);
    write(
        "scenarios/repair-nginx/briefing.md",
        "# Broken\n\nSee [the docs](https://nginx.org).\n",
    );
    write(
        "scenarios/repair-nginx/break.sh",
        "systemctl disable --now nginx\necho \"${HOME}\"\n",
    );
    write("scenarios/repair-nginx/README.md", "not shipped");
    change(root);
    let loaded = load_repository(root);
    (temp, loaded)
}

fn problems(change: impl FnOnce(&Path)) -> String {
    let (_temp, loaded) = repository(change);
    let found = loaded.err().unwrap_or_default();
    found
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

fn edit(root: &Path, path: &str, from: &str, to: &str) {
    let path = root.join(path);
    let text = std::fs::read_to_string(&path).expect("read");
    assert!(text.contains(from), "`{from}` is in {}", path.display());
    std::fs::write(path, text.replacen(from, to, 1)).expect("write");
}

fn edit_scenario(from: &'static str, to: &'static str) -> String {
    problems(|root| edit(root, "scenarios/repair-nginx/scenario.hcl", from, to))
}

/// stdout and whether the script passed, run as Kino runs it.
fn bash(script: &str) -> (String, bool) {
    let output = Command::new("bash")
        .args(["-euo", "pipefail", "-c", script])
        .output()
        .expect("bash");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        output.status.success(),
    )
}

#[test]
fn the_example_loads_and_lowers() {
    let (_temp, loaded) = repository(|_| {});
    let repository = loaded.unwrap_or_else(|problems| panic!("{problems:?}"));
    let scenario = &repository.scenarios[0];
    assert_eq!(repository.images[0].disk_mib, Some(8192));
    assert_eq!(
        scenario.briefing,
        "# Broken\n\nSee [the docs](https://nginx.org).\n"
    );
    assert_eq!(scenario.solution, "Start it: `systemctl start nginx`.\n");

    let web = &scenario.machines[0];
    assert_eq!(
        (web.cpu_millis, web.memory_mib, web.disk_mib),
        (2000, 3072, 8192)
    );
    let names: Vec<&str> = web.setup.iter().map(|stage| stage.name.as_str()).collect();
    assert_eq!(names, ["packages", "break", "page"]);
    assert!(
        web.setup[0]
            .script
            .contains("--no-install-recommends 'nginx' 'curl'")
    );
    // file() content comes back verbatim, `${` included.
    assert_eq!(
        web.setup[1].script,
        "systemctl disable --now nginx\necho \"${HOME}\"\n"
    );
    assert_eq!(
        web.setup[2].script,
        "printf '%s' 'it'\\''s <up>\n' > '/var/www/html/index.html'\nchmod 0644 '/var/www/html/index.html'\nchown www-data:www-data '/var/www/html/index.html'\n"
    );

    // One machine, so tasks need not name it; the escapes are unescaped.
    assert_eq!(scenario.tasks[0].machine, "web");
    let solve = scenario.tasks[0].solve.as_deref().unwrap_or_default();
    assert!(
        solve.ends_with("systemctl start nginx\necho \"${HOME:-none}\" '%{http_code}'\n"),
        "{solve}"
    );
    let learn = scenario.machine_spec("intar/repair-nginx", "web", SpecMode::Learn);
    assert!(learn.is_some_and(|spec| spec.tasks.len() == 2 && spec.ready.len() == 1));
}

#[test]
fn lowered_checks_behave_in_bash() {
    let temp = tempfile::tempdir().expect("tempdir");
    let file = temp.path().join("it's here");
    let file = file.to_string_lossy();
    let lower = |checks: &str| {
        let text = format!("task \"t\" {{\n{checks}\n}}\n");
        let source = Source {
            root: temp.path(),
            path: Path::new("scenario.hcl"),
            text: &text,
            files: PathBuf::new(),
            referenced: std::cell::RefCell::default(),
            scripts: std::cell::RefCell::default(),
        };
        let body = source.parse().expect("parses");
        let block = body.blocks().next().expect("a block");
        let mut fields = Fields::of(&source, block).expect("fields");
        let blocks = fields.children("check");
        lower::checks(&source, &blocks).unwrap_or_else(|problem| panic!("{problem}"))
    };
    let hcl = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");

    // Sugar without `fail`: its specific message.
    let missing = lower(&format!("check {{ file = \"{}\" }}", hcl(&file)));
    assert_eq!(
        bash(&missing),
        (
            format!("FAIL: {file} does not exist.\nFAIL: Not done yet.\n"),
            false
        )
    );
    std::fs::write(&*file, "hello $(touch /tmp/pwned) `x`\n").expect("write");
    assert_eq!(bash(&missing), (String::new(), true));

    // Sugar with `fail`: only the author's text.
    let authored = lower(&format!(
        "check {{\n file = \"{}\"\n contains = \"absent\"\n fail = \"Say hello.\"\n}}",
        hcl(&file)
    ));
    assert_eq!(bash(&authored), ("FAIL: Say hello.\n".to_owned(), false));

    // `run`: the script's own FAIL line comes first; errexit holds inside.
    let own = lower("check { run = \"echo 'FAIL: mine'; exit 1\" }");
    assert!(bash(&own).0.starts_with("FAIL: mine\n"));
    let errexit = lower("check { run = \"false\\necho reached\" }");
    assert_eq!(bash(&errexit), ("FAIL: Not done yet.\n".to_owned(), false));

    // Several bodies are ANDed in file order.
    let both = lower(&format!(
        "check {{ file = \"{}\" }}\ncheck {{ run = \"exit 1\" }}",
        hcl(&file)
    ));
    assert_eq!(bash(&both), ("FAIL: Not done yet.\n".to_owned(), false));
}

#[test]
fn shell_quote_survives_hostile_input() {
    for hostile in [
        "it's",
        "$(id) `id` ${HOME}",
        "a\nb",
        "'; rm -rf /; '",
        "\\'",
        "-n",
        "",
    ] {
        let (stdout, passed) = bash(&format!("printf '%s' {}", shell_quote(hostile)));
        assert!(passed);
        assert_eq!(stdout, hostile);
    }
}

#[test]
fn defer_takes_only_units_a_lab_target_starts() {
    assert_eq!(
        edit_scenario("[\"nginx.service\"]", "[\"nginx.service\", \"kube.slice\"]"),
        "scenarios/repair-nginx/scenario.hcl:22:34: `machine`: `defer`: `kube.slice` is not a service, socket, timer, path or target unit"
    );
    let image = problems(|root| {
        edit(
            root,
            "images/base-web.hcl",
            "  disk = \"8Gi\"\n",
            "  disk = \"8Gi\"\n  defer = [\"k3s\"]\n",
        );
    });
    // The image does not load, so the machine's `from` names none next.
    assert_eq!(
        image.lines().next().unwrap_or_default(),
        "images/base-web.hcl:4:12: `image`: `defer`: `k3s` is not a service, socket, timer, path or target unit"
    );
    for unit in [
        "docker.socket",
        "apt-daily.timer",
        "getty@tty1.service",
        "multi-user.target",
        "x.path",
    ] {
        let replaced = format!("[\"{unit}\"]");
        let found = problems(|root| {
            edit(
                root,
                "scenarios/repair-nginx/scenario.hcl",
                "[\"nginx.service\"]",
                &replaced,
            );
        });
        assert_eq!(found, "", "{unit}");
    }
}

#[test]
fn problems_carry_their_place() {
    let at = "scenarios/repair-nginx/scenario.hcl";
    for (from, to, expected) in [
        (
            "tags       = [\"linux\"]",
            "titel = \"x\"",
            format!("{at}:6:3: `scenario`: unknown field `titel`"),
        ),
        (
            "check { port = 80 }",
            "check { servise = \"x\" }",
            format!("{at}:58:13: `check`: unknown field `servise`"),
        ),
        (
            "check { port = 80 }",
            "check {\n port = 80\n service = \"x\"\n }",
            "takes exactly one of".to_owned(),
        ),
        (
            "check { port = 80 }",
            "check { port = 0 }",
            "`port` is 1 to 65535".to_owned(),
        ),
        (
            "service = \"nginx\" }\n    check",
            "service = \"-x\" }\n    check",
            "`service` is not a unit name".to_owned(),
        ),
        (
            "minutes    = 20",
            "minutes    = 10 + 10",
            "an expression is not supported".to_owned(),
        ),
        (
            "minutes    = 20",
            "minutes    = var.minutes",
            "a variable or reference is not supported".to_owned(),
        ),
        (
            "\"A web server is down.\"",
            "\"down ${1}\"",
            "interpolation is not supported; write `$${`".to_owned(),
        ),
        (
            "\"A web server is down.\"",
            "upper(\"x\")",
            "a function other than file() and markdown()".to_owned(),
        ),
        (
            "\"A web server is down.\"",
            "file(\"break.sh\")",
            "`summary` takes a string".to_owned(),
        ),
        (
            "markdown(\"briefing.md\")",
            "file(\"briefing.md\")",
            "`briefing` takes markdown(), not file()".to_owned(),
        ),
        (
            "file(\"break.sh\")",
            "markdown(\"briefing.md\")",
            "`run` takes file(), not markdown()".to_owned(),
        ),
        (
            "file(\"break.sh\")",
            "file(\"../../intar.hcl\")",
            "is not a plain relative path".to_owned(),
        ),
        (
            "file(\"break.sh\")",
            "file(\"/etc/passwd\")",
            "is not a plain relative path".to_owned(),
        ),
        (
            "file(\"break.sh\")",
            "file(\"nope.sh\")",
            "scenarios/repair-nginx/nope.sh:".to_owned(),
        ),
        (
            "scenario \"repair-nginx\"",
            "scenario \"other-name\"",
            "must be in scenarios/other-name/".to_owned(),
        ),
        (
            "task \"page-served\"",
            "task \"nginx-runs\"",
            "task `nginx-runs` is declared twice".to_owned(),
        ),
        (
            "needs = [\"nginx-runs\"]",
            "needs = [\"nope\"]",
            "needs unknown task `nope`".to_owned(),
        ),
        (
            "machine \"web\" {",
            "vm \"web\" {",
            "retired scenario format".to_owned(),
        ),
        (
            "mode    = \"0644\"",
            "mode    = \"644; id\"",
            "`mode` is like \"0644\"".to_owned(),
        ),
        (
            "Look at the unit.",
            "Look at <b>the</b> unit.",
            "raw HTML is not rendered".to_owned(),
        ),
        (
            "Look at the unit.",
            "See [this](notes.md).",
            "a relative link or image target".to_owned(),
        ),
        (
            "machine \"web\" {",
            "machine \"web-server-with-a-name-far-too-long-for-ids\" {",
            format!(
                "{at}: machine `web-server-with-a-name-far-too-long-for-ids`: a name is at most 39 characters"
            ),
        ),
    ] {
        let found = edit_scenario(from, to);
        assert!(
            found.contains(&expected),
            "expected `{expected}` in `{found}`"
        );
    }
}

#[test]
fn files_follow_the_path_rules() {
    let directory = "scenarios/repair-nginx";
    let lfs = problems(|root| {
        std::fs::write(
            root.join(directory).join("break.sh"),
            "version https://git-lfs.github.com/spec/v1\n",
        )
        .expect("write");
    });
    assert!(lfs.contains("lfs_unsupported"), "{lfs}");

    let unread =
        problems(|root| std::fs::write(root.join(directory).join("old.sh"), "x").expect("write"));
    assert!(
        unread.contains("old.sh: no file() or markdown() reads this file"),
        "{unread}"
    );

    let fence = problems(|root| {
        std::fs::write(
            root.join(directory).join("briefing.md"),
            "text\n\n```sh\nls\n",
        )
        .expect("write");
    });
    assert!(
        fence.contains("briefing.md:3:1: a code fence is never closed"),
        "{fence}"
    );

    #[cfg(unix)]
    {
        let linked = problems(|root| {
            std::fs::remove_file(root.join(directory).join("break.sh")).expect("remove");
            std::os::unix::fs::symlink("/etc/hostname", root.join(directory).join("break.sh"))
                .expect("symlink");
        });
        assert!(
            linked.contains("symlinks and special files") || linked.contains("not a plain file"),
            "{linked}"
        );
    }
}

#[test]
fn retired_layouts_are_refused() {
    let yaml = problems(|root| std::fs::write(root.join("intar.yaml"), "x: 1\n").expect("write"));
    assert!(
        yaml.contains("intar.yaml: intar.yaml is retired; add intar.hcl"),
        "{yaml}"
    );

    let old = problems(|root| {
        std::fs::create_dir_all(root.join("courses/a/b")).expect("mkdir");
        std::fs::write(root.join("courses/a/b/scenario.hcl"), "scenario \"x\" {}\n")
            .expect("write");
    });
    assert!(
        old.contains("courses/a/b/scenario.hcl: retired scenario format"),
        "{old}"
    );

    let missing = problems(|root| std::fs::remove_file(root.join("intar.hcl")).expect("remove"));
    assert!(missing.contains("intar.hcl:"), "{missing}");

    let named = problems(|root| {
        edit(
            root,
            "images/base-web.hcl",
            "image \"base-web\"",
            "image \"other\"",
        )
    });
    assert!(
        named.contains("image `other` must be in images/other.hcl"),
        "{named}"
    );
}

#[test]
fn tab_indented_heredocs_are_refused() {
    let found = edit_scenario(
        "    Start it: `systemctl start nginx`.\n",
        "\tStart it: `systemctl start nginx`.\n",
    );
    assert!(
        found.contains("scenario.hcl:9:1: a `<<-` heredoc is indented with tabs"),
        "{found}"
    );
}

/// The repository of [`repository`] with a course whose second lecture
/// links `link`.
fn with_course(root: &Path, link: &str) {
    let write = |path: &str, text: &str| {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, text).expect("write");
    };
    write(
        "courses/linux/course.md",
        "---\ntitle: Linux\nsummary: Repair things.\nsequential: true\n---\n\nBody.\n",
    );
    write(
        "courses/linux/00-theory/lecture.md",
        "---\ntitle: Theory\nsummary: Read first.\ncategory: linux\ntags: [linux]\nestimated_minutes: 5\n---\n\nRead.\n",
    );
    write(
        "courses/linux/01-repair/lecture.md",
        &format!(
            "---\ntitle: Repair\nsummary: Fix it.\ncategory: linux\ntags: [nginx]\ndifficulty: easy\nestimated_minutes: 15\nscenario: {link}\n---\n\nFix.\n"
        ),
    );
}

fn compiled(change: impl FnOnce(&Path)) -> Result<intar_contracts::source::SourceBundleV2, String> {
    let (temp, _) = repository(|_| {});
    change(temp.path());
    compile(temp.path())
        .map(|(bundle, _)| bundle)
        .map_err(|problems| {
            problems
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        })
}

#[test]
fn lectures_link_scenarios_of_their_repository() {
    let bundle = compiled(|root| with_course(root, "repair-nginx")).expect("compiles");
    let lectures = &bundle.course_catalog.courses[0].lectures;
    assert_eq!(lectures.len(), 2);
    assert_eq!(lectures[0].scenario_id, None);
    assert_eq!(lectures[1].scenario_id.as_deref(), Some("repair-nginx"));
    assert_eq!(lectures[1].body_markdown, "\nFix.\n");

    for link in ["nope-nope", "rawkode-academy/systemd-timers"] {
        let found = compiled(|root| with_course(root, link))
            .err()
            .unwrap_or_default();
        assert!(
            found.contains(&format!(
                "courses/linux/01-repair/lecture.md:8:1: scenario `{link}` is not in this repository"
            )),
            "{found}"
        );
    }

    let stray = compiled(|root| {
        with_course(root, "repair-nginx");
        std::fs::write(root.join("courses/linux/01-repair/notes.txt"), "x").expect("write");
    })
    .err()
    .unwrap_or_default();
    assert!(
        stray.contains("courses/linux/01-repair/notes.txt: a lecture holds lecture.md"),
        "{stray}"
    );

    let unknown = compiled(|root| {
        with_course(root, "repair-nginx");
        edit(root, "courses/linux/course.md", "sequential", "ordered");
    })
    .err()
    .unwrap_or_default();
    assert!(
        unknown.contains("courses/linux/course.md:2:1: frontmatter:"),
        "{unknown}"
    );
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read as _;
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut json)
        .expect("gunzip");
    json
}

#[test]
fn bundles_round_trip_and_are_capped() {
    let bundle = compiled(|root| with_course(root, "repair-nginx")).expect("compiles");
    let encoded = encode_bundle(&bundle).expect("encodes");
    assert_eq!(
        encode_bundle(&bundle).as_ref(),
        Ok(&encoded),
        "deterministic"
    );
    let decoded: intar_contracts::source::SourceBundleV2 =
        serde_json::from_slice(&gunzip(&encoded)).expect("decodes");
    assert_eq!(decoded, bundle);
    assert_eq!(intar_contracts::source::validate_bundle(&decoded), Ok(()));

    // Incompressible text over the cap.
    let mut state = 1_u64;
    let noise: String = (0..3 * 1024 * 1024)
        .map(|_| {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            char::from(b'!' + u8::try_from(state >> 58).unwrap_or(0))
        })
        .collect();
    let mut huge = bundle;
    huge.scenarios[0].briefing = noise;
    let refused = encode_bundle(&huge).err().unwrap_or_default();
    assert!(refused.starts_with("bundle_too_large"), "{refused}");
}

/// `content/` holds the builder's old files too, so the example is copied
/// out with what a new-format repository holds.
fn example() -> tempfile::TempDir {
    let content = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let temp = tempfile::tempdir().expect("tempdir");
    for file in [
        "intar.hcl",
        "scenarios/broken-nginx/scenario.hcl",
        "courses/linux-operations/course.md",
        "courses/linux-operations/00-operating-model/lecture.md",
        "courses/linux-operations/01-broken-nginx/lecture.md",
    ] {
        let to = temp.path().join(file);
        std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
        std::fs::copy(content.join(file), to).expect("copy");
    }
    temp
}

#[test]
fn the_example_content_validates_and_bundles() {
    let temp = example();
    let (bundle, scripts) = compile(temp.path()).unwrap_or_else(|problems| panic!("{problems:?}"));
    assert_eq!(bundle.scenarios[0].slug, "broken-nginx");
    assert_eq!(bundle.scenarios[0].tasks.len(), 3);
    assert!(encode_bundle(&bundle).is_ok());
    // No lint fires on it, shellcheck included when it is installed.
    assert_eq!(warnings(&scripts), Vec::new());
    assert_eq!(format_repository(temp.path(), false), Ok(Vec::new()));
}

/// Only shell an author wrote is linted: a manifest, a file's content and a
/// check sugar's values are data, so a literal `$NAME` in them is no finding.
#[test]
fn data_is_not_linted_as_shell() {
    let (_temp, loaded) = repository(|root| {
        let at = "scenarios/repair-nginx/scenario.hcl";
        edit(
            root,
            at,
            "content = \"it's <up>\\n\"",
            "content = \"echo $HOME\\n\"",
        );
        edit(
            root,
            at,
            "    setup \"page\" {",
            "    setup \"database\" {\n      k8s_apply = \"command: [\\\"sh\\\", \\\"-c\\\", \\\"echo $POSTGRES_USER\\\"]\\n\"\n    }\n    setup \"page\" {",
        );
        edit(root, at, "contains = \"up\"", "contains = \"$counter\"");
        edit(
            root,
            at,
            "check { port = 80 }",
            "check { run = \"echo '$HOME'\" }",
        );
    });
    let repository = loaded.unwrap_or_else(|problems| panic!("{problems:?}"));
    let web = &repository.scenarios[0].machines[0];
    assert!(
        web.setup
            .iter()
            .any(|stage| stage.script.contains("echo $POSTGRES_USER"))
    );
    let linted: Vec<&str> = repository
        .scripts
        .iter()
        .map(|lowered| lowered.script.as_str())
        .collect();
    assert!(
        linted
            .iter()
            .all(|script| !script.contains("$POSTGRES_USER")
                && !script.contains("echo $HOME")
                && !script.contains("$counter")),
        "{linted:?}"
    );
    assert!(linted.contains(&"systemctl disable --now nginx\necho \"${HOME}\"\n"));
    let found: Vec<String> = warnings(&repository.scripts)
        .iter()
        .map(ToString::to_string)
        .collect();
    let sc2016: Vec<&String> = found
        .iter()
        .filter(|warning| warning.contains("SC2016"))
        .collect();
    if Command::new("shellcheck").arg("--version").output().is_ok() {
        // The author's single-quoted `$HOME` in `run` is still warned, and
        // nothing else is.
        assert_eq!(sc2016.len(), 1, "{found:?}");
        assert!(sc2016[0].contains("`check` lowered line 2"), "{found:?}");
    } else {
        assert!(sc2016.is_empty());
    }
}

#[test]
fn quiet_greps_are_warned_at_their_block() {
    let (_temp, loaded) = repository(|root| {
        edit(
            root,
            "scenarios/repair-nginx/scenario.hcl",
            "check { port = 80 }",
            "check { run = \"ss -ltn | grep -q :80\" }",
        );
    });
    let repository = loaded.unwrap_or_else(|problems| panic!("{problems:?}"));
    let found: Vec<String> = warnings(&repository.scripts)
        .iter()
        .map(ToString::to_string)
        .collect();
    assert!(
        found.iter().any(|warning| warning.starts_with(
            "scenarios/repair-nginx/scenario.hcl:58:5: warning: `check` lowered line 2: `| grep -q`"
        )),
        "{found:?}"
    );
}

fn unnamed(slug: &str) -> String {
    format!(
        "scenarios/{slug}/scenario.hcl: no lecture names the scenario `{slug}`: give a lecture of a course `scenario: {slug}`, or remove the scenario"
    )
}

#[test]
fn every_scenario_is_named_by_a_lecture() {
    assert_eq!(compiled(|_| {}), Err(unnamed("repair-nginx")));

    // A text-only lecture names no scenario.
    let theory_only = compiled(|root| {
        with_course(root, "repair-nginx");
        std::fs::remove_dir_all(root.join("courses/linux/01-repair")).expect("rm");
    });
    assert_eq!(theory_only, Err(unnamed("repair-nginx")));

    // Two unnamed scenarios: one diagnostic each, in path order.
    let two = compiled(|root| {
        for file in ["scenario.hcl", "briefing.md", "break.sh"] {
            let from = root.join("scenarios/repair-nginx").join(file);
            let to = root.join("scenarios/a-nginx").join(file);
            std::fs::create_dir_all(to.parent().expect("parent")).expect("mkdir");
            std::fs::copy(from, to).expect("copy");
        }
        edit(
            root,
            "scenarios/a-nginx/scenario.hcl",
            "scenario \"repair-nginx\"",
            "scenario \"a-nginx\"",
        );
    });
    assert_eq!(
        two,
        Err(format!(
            "{}\n{}",
            unnamed("a-nginx"),
            unnamed("repair-nginx")
        ))
    );

    // Named once, or by lectures of two courses (the text-only lecture
    // beside it is fine).
    assert!(compiled(|root| with_course(root, "repair-nginx")).is_ok());
    let twice = compiled(|root| {
        with_course(root, "repair-nginx");
        std::fs::create_dir_all(root.join("courses/ops")).expect("mkdir");
        std::fs::copy(
            root.join("courses/linux/course.md"),
            root.join("courses/ops/course.md"),
        )
        .expect("copy");
        std::fs::create_dir_all(root.join("courses/ops/00-again")).expect("mkdir");
        std::fs::copy(
            root.join("courses/linux/01-repair/lecture.md"),
            root.join("courses/ops/00-again/lecture.md"),
        )
        .expect("copy");
    })
    .expect("compiles");
    let courses: Vec<&str> = twice
        .course_catalog
        .courses
        .iter()
        .map(|course| course.course_id.as_str())
        .collect();
    assert_eq!(courses, ["linux", "ops"]);
}

const TALOS: &str = r#"scenario "talos-lab" {
  title      = "Talos"
  summary    = "A cluster."
  difficulty = "medium"
  minutes    = 30
  briefing   = "Get the nodes Ready."
  solution   = "Wait."

  talos-cluster "lab" {
    talos      = "v1.15.0-beta.0"
    kubernetes = "v1.37.1"
    patch "ntp" { yaml = file("talos/ntp.yaml") }

    machine "cp1" {
      role   = "controlplane"
      cpu    = 2
      memory = "2Gi"
      disk   = "10Gi"
      egress = true
    }

    machine "wk1" {
      role   = "worker"
      cpu    = 1
      memory = "1536Mi"
      disk   = "8Gi"
    }

    machine "mgmt" {
      role   = "management"
      cpu    = 1
      memory = "512Mi"
      disk   = "4Gi"
      from   = "trixie"
      ready "nodes" { run = "kubectl get nodes" }
    }
  }

  task "nodes-ready" {
    title   = "Nodes are Ready"
    machine = "mgmt"
    check { run = "kubectl get nodes" }
    solve { run = "true" }
  }
}
"#;

fn talos(change: impl FnOnce(&Path)) -> (tempfile::TempDir, Result<Repository, Vec<Diagnostic>>) {
    repository(|root| {
        let dir = root.join("scenarios/talos-lab");
        std::fs::create_dir_all(dir.join("talos")).expect("mkdir");
        std::fs::write(dir.join("scenario.hcl"), TALOS).expect("write");
        std::fs::write(dir.join("talos/ntp.yaml"), "machine: {}\n").expect("write");
        change(root);
    })
}

#[test]
fn a_cluster_lowers_to_its_machines() {
    let (_temp, loaded) = talos(|_| {});
    let repository = loaded.expect("loads");
    let scenario = &repository.scenarios[1];
    assert_eq!(scenario.slug, "talos-lab");
    let found: Vec<_> = scenario
        .machines
        .iter()
        .map(|m| {
            let role = m
                .cluster
                .as_ref()
                .map(|c| (c.cluster.as_str(), c.role.as_str()));
            (
                m.name.as_str(),
                m.from.as_str(),
                m.terminal,
                m.cpu_millis,
                m.memory_mib,
                role,
            )
        })
        .collect();
    assert_eq!(
        found,
        [
            (
                "cp1",
                "talos",
                false,
                2000,
                2048,
                Some(("lab", "controlplane"))
            ),
            ("wk1", "talos", false, 1000, 1536, Some(("lab", "worker"))),
            (
                "mgmt",
                "trixie",
                true,
                1000,
                512,
                Some(("lab", "management"))
            ),
        ]
    );
    let cluster = &scenario.clusters[0];
    assert_eq!(
        (cluster.talos.as_str(), cluster.kubernetes.as_str()),
        ("v1.15.0-beta.0", "v1.37.1")
    );
    assert_eq!(cluster.patches[0].name, "ntp");
    assert_eq!(cluster.patches[0].script, "machine: {}\n");
}

#[test]
fn cluster_blocks_are_checked() {
    let at = "scenarios/talos-lab/scenario.hcl";
    for (from, to, expected) in [
        ("talos      = \"v1.15.0-beta.0\"", "", "`talos` is required"),
        (
            "talos      = \"v1.15.0-beta.0\"",
            "talos = \"v1.99.0\"",
            "is not a supported release",
        ),
        (
            "role   = \"worker\"",
            "role   = \"boss\"",
            "`role` is `controlplane`, `worker` or `management`",
        ),
        (
            "role   = \"worker\"",
            "",
            "`role` is `controlplane`, `worker` or `management`",
        ),
        (
            "role   = \"controlplane\"",
            "role   = \"worker\"",
            "needs at least one controlplane machine",
        ),
        (
            "role   = \"management\"",
            "role   = \"worker\"",
            "needs exactly one management machine",
        ),
        (
            "machine = \"mgmt\"",
            "machine = \"cp1\"",
            "a cluster node has no terminal",
        ),
        (
            "disk   = \"8Gi\"",
            "disk   = \"2Gi\"",
            "smaller than a cluster node's 4096 MiB",
        ),
        ("yaml = file(", "yml = file(", "`patch`: `yaml` is required"),
        (
            "talos-cluster \"lab\" {",
            "talos-cluster \"lab\" {\n    kind = \"talos\"",
            "unknown field `kind`",
        ),
        (
            "title   = \"Nodes are Ready\"",
            "title   = \"Nodes are Ready\"\n    role = \"worker\"",
            "unknown field `role`",
        ),
    ] {
        let (_temp, loaded) = talos(|root| edit(root, at, from, to));
        let found = loaded
            .err()
            .unwrap_or_default()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            found.contains(expected),
            "expected `{expected}` in `{found}`"
        );
    }
}
