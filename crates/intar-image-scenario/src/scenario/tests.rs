#![allow(clippy::unwrap_used)]

use super::*;
use crate::{KinoProbeKind, ScenarioError};

fn supported_hcl() -> &'static str {
    r#"
scenario "broken-nginx" {
  hint "check-service" {
    title = "Start with systemd"
    body  = "Check the nginx service state first."
  }

  solution {
    body = <<-MD
      Start nginx and restore the default site symlink.
    MD
  }

  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 2
      timeout_seconds = 3
    }

    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
      title       = "Bring nginx back"
      body        = "The service must be active before the site can answer traffic."
      phase       = "boot"

      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }
    }

    probe "port-80-open" {
      kind            = "port_open"
      host            = "127.0.0.1"
      port            = 80
      protocol        = "tcp"
      description     = "HTTP port 80 should be listening"
      every_seconds   = 5
      timeout_seconds = 1
    }

    probe "default-site-enabled" {
      kind        = "file_exists"
      path        = "/etc/nginx/sites-enabled/default"
      description = "Default site should be enabled"
    }

    probe "ssh-server-enabled" {
      kind        = "command_json_path"
      argv        = ["/usr/bin/env", "python3", "-c", "import json; print(json.dumps({'sshServer': {'enabled': True}}))"]
      json_path   = "$.sshServer.enabled"
      expected    = true
      description = "SSH server should be enabled"
    }

  }

  vm "webserver" {
    cpu    = 1
    memory = 512
    disk   = 2
    image  = "debian-12-minimal"
    packages = ["nginx"]

    step "break-nginx" {
      systemctl {
        unit   = "nginx"
        action = "stop"
      }

      file_delete {
        path = "/etc/nginx/sites-enabled/default"
      }
    }

    probes = ["nginx-running", "port-80-open", "default-site-enabled", "ssh-server-enabled"]
  }
}
"#
}

#[test]
fn parses_and_validates_supported_scenario() {
    let scenario = Scenario::parse_course(supported_hcl()).unwrap();
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();

    assert_eq!(scenario.name, "broken-nginx");
    assert_eq!(scenario.hints[0].id, "check-service");
    assert!(
        scenario
            .solution
            .as_ref()
            .unwrap()
            .body
            .contains("Start nginx")
    );
    let probe = scenario.kino.probes.get("nginx-running").unwrap();
    assert_eq!(probe.title.as_deref(), Some("Bring nginx back"));
    assert_eq!(probe.hints[0].id, "status");
    assert_eq!(scenario.total_probe_count(), 4);
    assert_eq!(scenario.images["debian-12-minimal"].base, "trixie");
    assert_eq!(scenario.vms[0].cpu_millis, 1_000);
    assert_eq!(scenario.vms[0].vcpu_count, 1);
}

#[test]
fn file_replace_requires_an_explicit_python3_package() {
    let mut scenario = Scenario::parse_course(supported_hcl()).unwrap();
    scenario.vms[0].steps[0]
        .actions
        .push(VmAction::FileReplace {
            path: "/etc/nginx/nginx.conf".to_string(),
            pattern: "worker_processes auto".to_string(),
            replacement: "worker_processes 1".to_string(),
            regex: false,
        });

    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(error.to_string().contains("must include python3"));

    scenario.vms[0].packages.push("python3".to_string());
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();
}

#[test]
fn parses_fractional_cpu_as_exact_millicores() {
    let hcl = supported_hcl().replace("cpu    = 1", "cpu    = 0.125");

    let scenario = Scenario::parse_course(&hcl).unwrap();

    assert_eq!(scenario.vms[0].cpu_millis, 125);
    assert_eq!(scenario.vms[0].vcpu_count, 1);
}

#[test]
fn defaults_vcpus_to_the_cpu_ceiling_and_accepts_an_explicit_topology() {
    let hcl = supported_hcl().replace("cpu    = 1", "cpu    = 2.125");
    let scenario = Scenario::parse_course(&hcl).unwrap();
    assert_eq!(scenario.vms[0].cpu_millis, 2_125);
    assert_eq!(scenario.vms[0].vcpu_count, 3);

    let hcl = supported_hcl().replace("cpu    = 1", "cpu    = 0.125\n    vcpus  = 4");
    let scenario = Scenario::parse_course(&hcl).unwrap();
    assert_eq!(scenario.vms[0].cpu_millis, 125);
    assert_eq!(scenario.vms[0].vcpu_count, 4);
}

#[test]
fn rejects_inexact_or_non_positive_cpu_literals() {
    for (literal, expected) in [
        ("0", "must be > 0"),
        ("-0.125", "positive integer or decimal literal"),
        ("0.0001", "at most three fractional digits"),
        ("1.0000", "at most three fractional digits"),
        ("1e-1", "must not use exponent notation"),
    ] {
        let hcl = supported_hcl().replace("cpu    = 1", &format!("cpu    = {literal}"));
        let error = Scenario::parse_course(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(ref message) if message.contains(expected)),
            "literal {literal} should fail with {expected}: {error:?}"
        );
    }
}

#[test]
fn rejects_cpu_above_explicit_vcpu_capacity() {
    let hcl = supported_hcl().replace("cpu    = 1", "cpu    = 1.001\n    vcpus  = 1");

    let error = Scenario::parse_course(&hcl).unwrap_err();

    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("exceeds vcpus capacity"))
    );
}

#[test]
fn errors_on_unknown_scenario_attribute() {
    let hcl = supported_hcl().replace(
        r#"scenario "broken-nginx" {"#,
        r#"scenario "broken-nginx" {
  typo_description = "This should not be silently ignored""#,
    );
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("does not support attribute 'typo_description'"))
    );
}

#[test]
fn errors_on_unknown_vm_attribute() {
    let hcl = supported_hcl().replace(
        r#"    packages = ["nginx"]"#,
        r#"    package = ["nginx"]
    packages = ["nginx"]"#,
    );

    let error = Scenario::parse_course(&hcl).unwrap_err();

    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("vm 'webserver' does not support attribute 'package'"))
    );
}

#[test]
fn errors_on_unknown_step_attribute() {
    let hcl = supported_hcl().replace(
        r#"    step "break-nginx" {"#,
        r#"    step "break-nginx" {
      summary = "This should not be accepted""#,
    );

    let error = Scenario::parse_course(&hcl).unwrap_err();

    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("step 'break-nginx' does not support attribute 'summary'"))
    );
}

#[test]
fn errors_on_unknown_vm_action_attribute() {
    let hcl = supported_hcl().replace(
        r#"        path = "/etc/nginx/sites-enabled/default""#,
        r#"        target = "/etc/nginx/sites-enabled/default"
        path = "/etc/nginx/sites-enabled/default""#,
    );

    let error = Scenario::parse_course(&hcl).unwrap_err();

    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("file_delete block does not support attribute 'target'"))
    );
}

#[test]
fn errors_on_nested_vm_action_block() {
    let hcl = supported_hcl().replace(
        r#"      file_delete {
        path = "/etc/nginx/sites-enabled/default"
      }"#,
        r#"      file_delete {
        path = "/etc/nginx/sites-enabled/default"
        nested {}
      }"#,
    );

    let error = Scenario::parse_course(&hcl).unwrap_err();

    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("file_delete block does not support nested block 'nested'"))
    );
}

#[test]
fn errors_on_extra_named_block_label() {
    let hcl = supported_hcl().replace(
        r#"scenario "broken-nginx" {"#,
        r#"scenario "broken-nginx" "extra" {"#,
    );
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("scenario block expects exactly one label"))
    );

    let hcl = supported_hcl().replace(
        r#"    probe "nginx-running" {"#,
        r#"    probe "nginx-running" "extra" {"#,
    );
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("kino probe block expects exactly one label"))
    );
}

#[test]
fn errors_on_label_free_block_labels() {
    let hcl = supported_hcl().replace(r#"  kino {"#, r#"  kino "checks" {"#);
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("kino block does not support labels"))
    );

    let hcl = supported_hcl().replace(r#"      systemctl {"#, r#"      systemctl "stop" {"#);
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("systemctl block does not support labels"))
    );
}

#[test]
fn errors_on_duplicate_hint_ids_per_scope() {
    let hcl = supported_hcl().replace(
        "  solution {",
        r#"  hint "check-service" {
    body = "Read the systemd state again."
  }

  solution {"#,
    );
    let scenario = Scenario::parse_course(&hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::DuplicateHintId { scope, id }
            if scope == "scenario" && id == "check-service"
    ));

    let hcl = supported_hcl().replace(
        r#"      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }"#,
        r#"      hint "status" {
        body = "systemctl status nginx shows whether the service is active."
      }

      hint "status" {
        body = "Check the service status again."
      }"#,
    );
    let scenario = Scenario::parse_course(&hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::DuplicateHintId { scope, id }
            if scope == "probe 'nginx-running'" && id == "status"
    ));
}

#[test]
fn errors_on_unsafe_scenario_identifiers() {
    let hcl = supported_hcl().replace(r#"scenario "broken-nginx" {"#, r#"scenario "../escape" {"#);
    let scenario = Scenario::parse_course(&hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("invalid scenario name"))
    );

    let hcl = supported_hcl().replace(r#"vm "webserver" {"#, r#"vm "../web" {"#);
    let scenario = Scenario::parse_course(&hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("invalid vm name"))
    );
}

#[test]
fn errors_on_duplicate_image_and_vm_labels() {
    let hcl = supported_hcl().replace(
        r#"  kino {"#,
        r#"  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {"#,
    );
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("duplicate image 'debian-12-minimal'"))
    );

    let hcl = supported_hcl().replace(
        r#"  vm "webserver" {"#,
        r#"  vm "webserver" {
    image = "debian-12-minimal"
    probes = ["nginx-running"]
  }

  vm "webserver" {"#,
    );
    let error = Scenario::parse_course(&hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("duplicate vm 'webserver'"))
    );
}

#[test]
fn rejects_lecture_presentation_attributes() {
    for (field, attribute) in [
        ("title", r#"title = "Broken Nginx""#),
        ("category", r#"category = "web""#),
        ("tags", r#"tags = ["nginx"]"#),
        ("difficulty", r#"difficulty = "easy""#),
        ("estimated_minutes", "estimated_minutes = 15"),
        ("description", r#"description = "Fix nginx""#),
        ("briefing", r#"briefing = "Restore nginx""#),
    ] {
        let hcl = supported_hcl().replace(
            r#"scenario "broken-nginx" {"#,
            &format!("scenario \"broken-nginx\" {{\n  {attribute}"),
        );
        let error = Scenario::parse_course(&hcl).unwrap_err();
        assert!(
            matches!(error, ScenarioError::InvalidScenario(ref message) if message.contains(&format!("course-mode scenario must not define {field}"))),
            "{field} should be rejected: {error}"
        );
    }
}

#[test]
fn hint_and_solution_prose_may_reference_managed_commands() {
    let hcl = supported_hcl()
        .replace(
            "Check the nginx service state first.",
            "The hint can mention `systemctl restart sshd.service` as text.",
        )
        .replace(
            "Start nginx and restore the default site symlink.",
            "The solution may discuss why `chsh ubuntu` would be wrong without running it.",
        );
    let scenario = Scenario::parse_course(&hcl).unwrap();
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();
}

#[test]
fn derives_kino_config_from_vm_probes() {
    let scenario = Scenario::parse_course(supported_hcl()).unwrap();
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();

    let kino = scenario.derive_kino_config_for_vm("webserver").unwrap();
    assert!(
        kino.config_hcl
            .contains("bind = \"vsock://__INTAR_KINO_CID__:__INTAR_KINO_PORT__\"")
    );
    assert!(kino.config_hcl.contains("every_seconds = 2"));
    assert!(kino.config_hcl.contains("timeout_seconds = 3"));
    assert!(kino.config_hcl.contains("probe \"nginx-running\""));
    assert!(kino.config_hcl.contains("kind = \"service\""));
    assert!(kino.config_hcl.contains("intar_alias = \"check-1\""));
    assert!(
        kino.config_hcl
            .contains("intar_label = \"Nginx should be running\"")
    );
    assert!(kino.config_hcl.contains("intar_phase = \"boot\""));
    assert!(kino.config_hcl.contains("probe \"port-80-open\""));
    assert!(kino.config_hcl.contains("kind = \"port_open\""));
    assert!(kino.config_hcl.contains("host = \"127.0.0.1\""));
    assert!(kino.config_hcl.contains("kind = \"command_json_path\""));
    assert!(
        kino.config_hcl
            .contains("json_path = \"$.sshServer.enabled\"")
    );
    assert_eq!(kino.probe_descriptors.len(), 4);
    assert_eq!(kino.probe_descriptors[0].kind, KinoProbeKind::Service);
    assert_eq!(kino.probe_descriptors[0].intar_alias, "check-1");
    assert_eq!(
        kino.probe_descriptors[0].label,
        "Nginx should be running".to_string()
    );
    assert_eq!(kino.probe_descriptors[0].phase, ProbePhase::Boot);
    assert!(!kino.config_hcl.contains("Bring nginx back"));
    assert!(!kino.config_hcl.contains("systemctl status nginx"));
    assert!(!kino.config_hcl.contains("Start nginx and restore"));
}

#[test]
fn blocks_run_cli_managed_assets() {
    for path in [
        "/etc/bash.bashrc",
        "/usr/local/bin/intar",
        "/usr/share/intar/completions/intar.bash",
        "/run/intar/kino-control.sock",
        "/run/intar/run-cli-broker",
        "/etc/systemd/system/intar-build.service.d/10-intar-build-seed.conf",
        "/etc/systemd/system/intar-scenario.service.d/10-intar-runtime-disk.conf",
    ] {
        assert!(is_managed_path(path), "expected managed path {path}");
        assert!(
            text_references_managed_assets(&format!("rm -f {path}")),
            "expected managed command reference {path}"
        );
    }
}

#[test]
fn derives_kino_config_with_heredoc_command_json_path_argv() {
    #[derive(serde::Deserialize)]
    struct ReparsedKinoConfig {
        probe: std::collections::BTreeMap<String, ReparsedKinoProbe>,
    }

    #[derive(serde::Deserialize)]
    struct ReparsedKinoProbe {
        kind: String,
        #[serde(default)]
        argv: Vec<String>,
        #[serde(default)]
        json_path: String,
        expected: Option<bool>,
    }

    let script = "printf '%s\\n' '{\"sshServer\":{\"enabled\":true}}'\n";
    let hcl = supported_hcl().replace(
        r#"argv        = ["/usr/bin/env", "python3", "-c", "import json; print(json.dumps({'sshServer': {'enabled': True}}))"]"#,
        r#"argv = [
        "/bin/sh",
        "-ec",
        <<SCRIPT
printf '%s\n' '{"sshServer":{"enabled":true}}'
SCRIPT
      ]"#,
    );

    let scenario = Scenario::parse_course(&hcl).unwrap();
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();

    let kino = scenario.derive_kino_config_for_vm("webserver").unwrap();
    assert!(!kino.config_hcl.contains("TemplateExpr"));

    let reparsed: ReparsedKinoConfig = hcl::from_str(&kino.config_hcl).unwrap();
    let probe = reparsed.probe.get("ssh-server-enabled").unwrap();
    assert_eq!(probe.kind, "command_json_path");
    assert_eq!(probe.argv, vec!["/bin/sh", "-ec", script]);
    assert_eq!(probe.json_path, "$.sshServer.enabled");
    assert_eq!(probe.expected, Some(true));

    let mut definition = std::collections::HashMap::new();
    definition.insert(
        "kind".to_string(),
        serde_json::Value::String(probe.kind.clone()),
    );
    definition.insert(
        "argv".to_string(),
        serde_json::Value::Array(
            probe
                .argv
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    definition.insert(
        "json_path".to_string(),
        serde_json::Value::String(probe.json_path.clone()),
    );
    definition.insert(
        "expected".to_string(),
        serde_json::Value::Bool(probe.expected.unwrap()),
    );

    let validated = KinoProbeDefinition::from_definition(
        "ssh-server-enabled",
        &definition,
        None,
        None,
        None,
        Vec::new(),
        ProbePhase::Scenario,
    )
    .unwrap();
    validated.validate().unwrap();
}

#[test]
fn errors_on_missing_probe_description() {
    let hcl = r#"
scenario "missing-description" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind    = "service"
      service = "nginx"
      state   = "running"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["nginx-running"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::MissingProbeDescription { probe } if probe == "nginx-running"
    ));
}

#[test]
fn rejects_probe_descriptions_that_cannot_be_safe_cli_labels() {
    for description in ["x".repeat(161), "\u{202e}spoofed label".to_string()] {
        let scenario = Scenario::parse_course(
            &supported_hcl().replace("Nginx should be running", &description),
        )
        .unwrap();
        let error = scenario
            .validate_technical_for_builder_arch("amd64")
            .unwrap_err();
        assert!(matches!(
            error,
            ScenarioError::InvalidScenarioField { field, message }
                if field == "kino.probe.nginx-running.description"
                    && message.contains("visible terminal text")
        ));
    }
}

#[test]
fn parses_vm_packages_from_root_attributes() {
    let hcl = r#"
scenario "vm-packages" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"
    packages = ["nginx", "curl"]
    probes = ["nginx-running"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let vm = scenario.vm_by_name("web").unwrap();
    assert_eq!(vm.packages, vec!["nginx", "curl"]);
}

#[test]
fn errors_on_managed_paths_units_and_commands() {
    let hcl = r#"
scenario "managed-assets" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      file_write {
        path    = "/etc/kino/kino.hcl.tpl"
        content = "bind = \\\"tcp://127.0.0.1:9000\\\""
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(error, ScenarioError::ManagedPath { .. }));

    let hcl = r#"
scenario "managed-unit" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      systemctl {
        unit   = "intar-scenario.service"
        action = "restart"
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(error, ScenarioError::ManagedUnit { .. }));

    let hcl = r#"
scenario "managed-command" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image = "debian-12-minimal"

    step "blocked" {
      command {
        cmd = "systemctl restart sshd.service"
      }
    }

    probes = ["nginx-running"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(error, ScenarioError::ManagedCommand { .. }));
}

#[test]
fn errors_on_invalid_kino_timing() {
    let hcl = r#"
scenario "invalid-kino-timing" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 0
    }

    probe "port-80-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 80
      protocol    = "tcp"
      description = "HTTP port 80 should be open"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["port-80-open"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(error, ScenarioError::InvalidKinoDefaults { .. }));
}

#[test]
fn errors_on_invalid_command_json_path_probe() {
    let hcl = r#"
scenario "invalid-command-json-path" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "check-command" {
      kind        = "command_json_path"
      argv        = []
      json_path   = ""
      description = "Command should succeed"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["check-command"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::InvalidProbeConfig { probe, .. } if probe == "check-command"
    ));
}

#[test]
fn errors_on_invalid_desired_state() {
    let hcl = r#"
scenario "invalid-desired-state" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "default"
      selector      = "app=api"
      desired_state = "phase:NotARealPhase"
      kubeconfig    = "/tmp/kubeconfig"
      description   = "API pod should be ready"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["api-ready"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::InvalidProbeConfig { probe, .. } if probe == "api-ready"
    ));
}

#[test]
fn errors_on_missing_vm_probe_reference() {
    let hcl = r#"
scenario "missing-vm-probe" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running"
    }
  }

  vm "web" {
    image  = "debian-12-minimal"
    probes = ["missing-probe"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    let error = scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap_err();
    assert!(matches!(
        error,
        ScenarioError::ProbeNotFound(probe) if probe == "missing-probe"
    ));
}

#[test]
fn parses_k8s_scale_deployment_action() {
    let hcl = r#"
scenario "scale-action" {
  image "debian-12-minimal" {
    base = "trixie"
  }
  solution { body = "Scale the api deployment back to one replica." }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "checkpoint"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "checkpoint"
        replicas  = 0
      }
    }

    probes = ["api-ready"]
  }
}
"#;

    let scenario = Scenario::parse_course(hcl).unwrap();
    scenario
        .validate_technical_for_builder_arch("amd64")
        .unwrap();

    let vm = scenario.vm_by_name("control-plane").unwrap();
    assert!(matches!(
        &vm.steps[0].actions[0],
        VmAction::K8sScaleDeployment {
            name,
            namespace,
            replicas,
            kubeconfig: None,
        } if name == "api" && namespace == "checkpoint" && *replicas == 0
    ));
}

#[test]
fn errors_on_invalid_k8s_scale_deployment_action() {
    let hcl = r#"
scenario "invalid-scale-action" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "checkpoint"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "checkpoint"
      }
    }

    probes = ["api-ready"]
  }
}
"#;

    let error = Scenario::parse_course(hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("k8s_scale_deployment block missing required attribute 'replicas'"))
    );

    let hcl = r#"
scenario "invalid-scale-action-kubectl" {
  image "debian-12-minimal" {
    base = "trixie"
  }

  kino {
    probe "api-ready" {
      kind          = "k8s_pod_state"
      namespace     = "checkpoint"
      selector      = "app=api"
      desired_state = "condition:Ready"
      description   = "API pod should be ready"
    }
  }

  vm "control-plane" {
    image = "debian-12-minimal"

    step "break-workload" {
      k8s_scale_deployment {
        name      = "api"
        namespace = "checkpoint"
        replicas  = 0
        kubectl   = "scale deployment/api --replicas=0"
      }
    }

    probes = ["api-ready"]
  }
}
"#;

    let error = Scenario::parse_course(hcl).unwrap_err();
    assert!(
        matches!(error, ScenarioError::InvalidScenario(message) if message.contains("k8s_scale_deployment block does not support attribute 'kubectl'"))
    );
}
