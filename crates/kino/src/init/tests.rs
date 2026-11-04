use super::verify::topo_order;
use super::*;
use std::time::Duration;

fn boot(json: &str) -> Boot {
    serde_json::from_str(json).expect("valid boot")
}

#[test]
fn boot_has_no_check_kinds_or_observed_values() {
    let error = serde_json::from_str::<Boot>(
        r#"{"machine":"m","mode":"learn","checks":{"c":{"kind":"http"}}}"#,
    );
    assert!(error.is_err(), "`checks` is gone; tasks carry `run`");
}

#[test]
fn topo_order_follows_local_needs_and_ignores_peers() {
    let boot = boot(
        r#"{"machine":"cplane","mode":"verify","tasks":[
            {"id":"b","run":"true","needs":["a","worker/x"]},
            {"id":"a","run":"true","needs":["cplane/c0"]},
            {"id":"c0","run":"true"}]}"#,
    );
    assert_eq!(topo_order(&boot), Ok(vec![2, 1, 0]));
}

#[tokio::test]
async fn a_failing_run_reports_its_fail_line_or_not_done_yet() {
    let temp = tempfile::tempdir().expect("tempdir");
    let run = |script: &'static str| exec::run(temp.path(), "t", script, Duration::from_secs(5));

    let plain = run("echo noise; exit 1").await;
    assert_eq!(plain.status, Status::Fail);
    assert_eq!(plain.message, exec::DEFAULT_MESSAGE);
    assert_eq!(plain.message, "Not done yet.");

    let fail = run("echo 'FAIL: nginx is not on :80'; echo 'FAIL: second'; exit 3").await;
    assert_eq!(fail.message, "nginx is not on :80");
    assert_eq!(fail.exit, Some(3));

    // `-u` is on.
    assert_eq!(run("echo \"$UNSET_VARIABLE\"").await.status, Status::Fail);
    assert_eq!(run("true").await.message, "");
    let slow = exec::run(temp.path(), "slow", "sleep 5", Duration::from_millis(100)).await;
    assert_eq!(slow.status, Status::Error);
}

#[tokio::test]
async fn learn_runs_tasks_only_after_ready_and_latches_them() {
    let temp = tempfile::tempdir().expect("tempdir");
    let log = temp.path().join("log");
    let boot = boot(&format!(
        r#"{{"machine":"m","mode":"learn",
            "ready":[{{"name":"lab","run":"echo ready >> '{l}'"}}],
            "tasks":[{{"id":"t","run":"echo task >> '{l}'; grep -q ready '{l}'"}}]}}"#,
        l = log.display()
    ));
    let (report, changes) = watch::channel(Report::default());

    run(&boot, &temp.path().join("scripts"), &report).await;

    assert_eq!(std::fs::read_to_string(&log).expect("log"), "ready\ntask\n");
    let report = changes.borrow();
    assert_eq!(report.phase, Phase::Ready);
    assert_eq!(report.ready[0].status, Status::Pass);
    assert_eq!(report.tasks[0].status, Status::Pass);
    assert!(report.tasks[0].passed_at_unix_ms > 0);
}

#[tokio::test]
async fn verify_solves_in_order_treats_no_solve_as_implied_and_stops_at_a_peer() {
    let temp = tempfile::tempdir().expect("tempdir");
    let marker = temp.path().join("solved");
    let tasks = format!(
        r#"{{"id":"implied","run":"test -f '{m}'","needs":["first"]}},
           {{"id":"first","run":"test -f '{m}' || {{ echo 'FAIL: not yet'; exit 1; }}","solve":"touch '{m}'"}}"#,
        m = marker.display()
    );
    let local = boot(&format!(
        r#"{{"machine":"cplane","mode":"verify","tasks":[{tasks}]}}"#
    ));
    let (report, changes) = watch::channel(Report::default());
    run(&local, &temp.path().join("scripts"), &report).await;
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(
        verify.done && verify.passed && verify.pre_done,
        "{verify:?}"
    );
    let [implied, first] = &verify.steps[..] else {
        panic!("two steps: {verify:?}");
    };
    assert_eq!(
        (first.pre, first.solve_exit, first.post),
        (Status::Fail, Some(0), Status::Pass)
    );
    assert_eq!(
        (implied.pre, implied.solve_exit, implied.post),
        (Status::Pending, None, Status::Pass)
    );

    std::fs::remove_file(&marker).expect("reset");
    let with_peer = boot(&format!(
        r#"{{"machine":"cplane","mode":"verify","tasks":[{tasks},
            {{"id":"join","run":"true","needs":["worker/joined"]}}]}}"#
    ));
    let (report, changes) = watch::channel(Report::default());
    run(&with_peer, &temp.path().join("scripts"), &report).await;
    let verify = changes.borrow().verify.clone().expect("verify");
    assert!(verify.done && !verify.passed, "{verify:?}");
    assert_eq!(verify.steps[2].waiting_for, ["worker/joined"]);
}
