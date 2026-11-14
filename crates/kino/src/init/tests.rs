use super::verify::{set_peers, topo_order};
use super::*;
use intar_kino_proto::kino_v2::{
    GuestFrame, MAX_FRAME_BYTES, PeerTasks, Step, TaskIds, guest_frame,
};
use prost::Message as _;
use std::time::Duration;

fn spec(json: &str) -> MachineSpecV1 {
    let filled = format!(
        r#"{{"scenario_id":"intar/test","env":{{}},"defer":[],"ready":[],"tasks":[],{}"#,
        json.trim_start().trim_start_matches('{')
    );
    // Later keys win in serde_json's map, so `json` overrides the defaults.
    let value: serde_json::Value = serde_json::from_str(&filled).expect("valid json");
    serde_json::from_value(value).expect("valid spec")
}

fn no_env() -> BTreeMap<String, String> {
    BTreeMap::new()
}

#[test]
fn topo_order_follows_local_needs_and_ignores_peers() {
    let spec = spec(
        r#"{"machine":"cplane","tasks":[
            {"id":"b","check":"true","needs":["a","worker/x"]},
            {"id":"a","check":"true","needs":["cplane/c0"]},
            {"id":"c0","check":"true","needs":[]}]}"#,
    );
    assert_eq!(topo_order(&spec), Ok(vec![2, 1, 0]));
}

#[tokio::test]
async fn a_failing_check_reports_its_fail_line_or_not_done_yet() {
    let temp = tempfile::tempdir().expect("tempdir");
    let env = no_env();
    let run =
        |script: &'static str| exec::run(temp.path(), "t", script, &env, Duration::from_secs(5));

    let plain = run("echo noise; exit 1").await;
    assert_eq!(plain.status, Status::Fail);
    assert_eq!(plain.message, "Not done yet.");

    let fail = run("echo 'FAIL: nginx is not on :80'; echo 'FAIL: second'; exit 3").await;
    assert_eq!(fail.message, "nginx is not on :80");
    assert_eq!(fail.exit, Some(3));

    // `-u` is on.
    assert_eq!(run("echo \"$UNSET_VARIABLE\"").await.status, Status::Fail);
    assert_eq!(run("true").await.message, "");
    let slow = exec::run(
        temp.path(),
        "slow",
        "sleep 5",
        &env,
        Duration::from_millis(100),
    )
    .await;
    assert_eq!(slow.status, Status::Error);

    let env = BTreeMap::from([("KUBECONFIG".to_owned(), "/etc/k".to_owned())]);
    let with_env = exec::run(
        temp.path(),
        "e",
        "test \"$KUBECONFIG\" = /etc/k",
        &env,
        Duration::from_secs(5),
    );
    assert_eq!(with_env.await.status, Status::Pass);
}

#[tokio::test]
async fn learn_runs_tasks_only_after_ready_and_latches_them() {
    let temp = tempfile::tempdir().expect("tempdir");
    let log = temp.path().join("log");
    let spec = spec(&format!(
        r#"{{"machine":"m",
            "ready":[{{"name":"lab","script":"echo ready >> '{l}'"}}],
            "tasks":[{{"id":"t","check":"echo task >> '{l}'; grep ready '{l}' >/dev/null","needs":[]}}]}}"#,
        l = log.display()
    ));
    let (report, changes) = watch::channel(Report::default());

    run(
        &spec,
        SpecMode::Learn,
        &[],
        &temp.path().join("scripts"),
        &report,
    )
    .await;

    assert_eq!(std::fs::read_to_string(&log).expect("log"), "ready\ntask\n");
    let report = changes.borrow();
    assert_eq!(report.phase(), Phase::Ready);
    assert_eq!(report.ready[0].status(), Status::Pass);
    assert_eq!(report.tasks[0].status(), Status::Pass);
    assert!(report.tasks[0].passed_at_unix_ms > 0);
    assert!(report.verify.is_none());
}

#[tokio::test]
async fn verify_solves_in_order_treats_no_solve_as_implied_and_stops_at_a_peer() {
    let temp = tempfile::tempdir().expect("tempdir");
    let marker = temp.path().join("solved");
    let tasks = format!(
        r#"{{"id":"implied","check":"test -f '{m}'","needs":["first"]}},
           {{"id":"first","check":"test -f '{m}' || {{ echo 'FAIL: not yet'; exit 1; }}","needs":[],"solve":"touch '{m}'"}}"#,
        m = marker.display()
    );
    let local = spec(&format!(r#"{{"machine":"cplane","tasks":[{tasks}]}}"#));
    let (report, changes) = watch::channel(Report::default());
    run(
        &local,
        SpecMode::Verify,
        &[],
        &temp.path().join("scripts"),
        &report,
    )
    .await;
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(
        verify.done && verify.passed && verify.pre_done,
        "{verify:?}"
    );
    let [implied, first] = &verify.steps[..] else {
        panic!("two steps: {verify:?}");
    };
    assert_eq!(
        (first.pre(), first.solve_exit, first.post()),
        (Status::Fail, 0, Status::Pass)
    );
    assert_eq!(
        (implied.pre(), implied.post()),
        (Status::Unspecified, Status::Pass),
        "an implied task has no pre-check"
    );

    std::fs::remove_file(&marker).expect("reset");
    let with_peer = spec(&format!(
        r#"{{"machine":"cplane","tasks":[{tasks},
            {{"id":"join","check":"true","needs":["worker/joined"]}}]}}"#
    ));
    let (report, changes) = watch::channel(Report::default());
    run(
        &with_peer,
        SpecMode::Verify,
        &[],
        &temp.path().join("scripts"),
        &report,
    )
    .await;
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(verify.done && !verify.passed, "{verify:?}");
    assert_eq!(verify.steps[2].waiting_for, ["worker/joined"]);
}

#[tokio::test]
async fn verify_waits_for_the_peer_barrier_and_needs_then_stops_on_a_failed_peer() {
    let temp = tempfile::tempdir().expect("tempdir");
    let peers = ["b".to_owned()];
    let multi = spec(r#"{"machine":"a","tasks":[{"id":"t","check":"true","needs":["b/x"]}]}"#);
    let (report, changes) = watch::channel(Report::default());
    let feeder = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let verify = changes.borrow().verify.clone();
        assert!(verify.is_none_or(|verify| !verify.done), "waits on peers");
        set_peers(PeerTasks {
            pre_done: vec!["b".into()],
            passed: [(
                "b".to_owned(),
                TaskIds {
                    ids: vec!["x".to_owned()],
                },
            )]
            .into(),
            ..PeerTasks::default()
        });
    };
    let dir = temp.path().join("s");
    tokio::join!(run(&multi, SpecMode::Verify, &peers, &dir, &report), feeder);
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(verify.done && verify.passed, "{verify:?}");

    let failing =
        spec(r#"{"machine":"a","tasks":[{"id":"t","check":"true","needs":["b/never"]}]}"#);
    set_peers(PeerTasks {
        pre_done: vec!["b".into()],
        failed: vec!["b".into()],
        ..PeerTasks::default()
    });
    let (report, changes) = watch::channel(Report::default());
    run(&failing, SpecMode::Verify, &peers, &dir, &report).await;
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(verify.done && !verify.passed, "{verify:?}");
    assert_eq!(changes.borrow().failure, "peer 'b' failed verify");
}

#[tokio::test]
async fn a_failed_ready_script_fails_the_lab_and_ends_verify() {
    let temp = tempfile::tempdir().expect("tempdir");
    let spec = spec(r#"{"machine":"m","ready":[{"name":"lab","script":"exit 1"}]}"#);
    let (report, changes) = watch::channel(Report::default());
    run(
        &spec,
        SpecMode::Verify,
        &[],
        &temp.path().join("s"),
        &report,
    )
    .await;
    let report = changes.borrow();
    assert_eq!(report.phase(), Phase::Failed);
    assert_eq!(report.failure, "ready 'lab' did not pass");
    let verify = report.verify.clone().expect("verify");
    assert!(verify.done && !verify.passed);
}

/// The worst case the compiler allows: 32 tasks with full messages and step
/// tails, 16 ready tails, a full failure text.
fn worst_case(tail_bytes: usize) -> Report {
    let text = |bytes: usize| "é".repeat(bytes / 2);
    Report {
        contract: GUEST_CONTRACT,
        failure: text(1024),
        ready: (0..16)
            .map(|n| Ready {
                name: format!("r{n}"),
                status: 3,
                tail: text(2048),
            })
            .collect(),
        tasks: (0..32)
            .map(|n| Task {
                id: format!("t{n}"),
                status: 3,
                message: text(512),
                passed_at_unix_ms: 0,
            })
            .collect(),
        verify: Some(Verify {
            steps: (0..32)
                .map(|n| Step {
                    task_id: format!("t{n}"),
                    post: 3,
                    tail: text(tail_bytes),
                    ..Step::default()
                })
                .collect(),
            done: true,
            ..Verify::default()
        }),
        ..Report::default()
    }
}

fn decode(frame: &[u8]) -> Report {
    let (length, body) = frame.split_at(4);
    assert_eq!(
        u32::from_be_bytes(length.try_into().expect("4 bytes")) as usize,
        body.len()
    );
    assert!(body.len() <= MAX_FRAME_BYTES, "{} bytes", body.len());
    match GuestFrame::decode(body).expect("a guest frame").frame {
        Some(guest_frame::Frame::Report(report)) => report,
        None => panic!("no report"),
    }
}

#[test]
fn the_worst_allowed_report_fits_a_frame_unchanged() {
    let report = worst_case(4096);
    assert_eq!(decode(&wire::encode(report.clone())), report);
}

#[test]
fn an_oversized_report_loses_admin_text_but_no_task_or_status() {
    let report = worst_case(64 * 1024);
    let sent = decode(&wire::encode(report.clone()));
    assert_eq!(sent.tasks, report.tasks);
    let steps = |report: &Report| -> Vec<(String, i32)> {
        let verify = report.verify.clone().unwrap_or_default();
        verify
            .steps
            .into_iter()
            .map(|step| (step.task_id, step.post))
            .collect()
    };
    assert_eq!(steps(&sent), steps(&report));
    assert!(sent.verify.is_some_and(|verify| verify.done));
}

#[tokio::test]
async fn an_oversized_host_frame_ends_the_stream() {
    // An empty frame: the peers are process-wide and other tests set them.
    let frame = intar_kino_proto::kino_v2::HostFrame { frame: None }.encode_to_vec();
    let mut stream = u32::try_from(frame.len())
        .expect("small")
        .to_be_bytes()
        .to_vec();
    stream.extend(frame);
    stream.extend(u32::MAX.to_be_bytes());
    // Returns at the oversized length instead of allocating 4 GiB.
    wire::read_host_frames(stream.as_slice()).await;
}
