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
