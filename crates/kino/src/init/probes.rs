//! The probes of a task's checks: questions to the machine's Kubernetes API,
//! asked in-process with the kubeconfig the machine's env names. They run
//! before the task's script; the first that fails is the outcome.

use super::exec::{self, MESSAGE_BYTES, Outcome};
use super::{Status, head};
use intar_contracts::scenario::{ProbeCheckV1, ProbeV1, SpecTaskV1};
use jsonpath_rust::JsonPath;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SubjectAccessReview, SubjectAccessReviewSpec,
};
use kube::api::{DynamicObject, PostParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::discovery::{Discovery, Scope};
use kube::{Api, Client, Config};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

/// A task's checks: its probes in order, then its script unless that is
/// blank, all within `timeout`. A probe that fails, or cannot ask, fails the
/// task with its message, or its author's `fail`; one that outlives the
/// timeout is an error, like a script.
pub(crate) async fn task(
    dir: &Path,
    name: &str,
    task: &SpecTaskV1,
    env: &BTreeMap<String, String>,
    timeout: Duration,
) -> Outcome {
    let started = Instant::now();
    if !task.probes.is_empty() {
        match tokio::time::timeout(timeout, probes(&task.probes, env)).await {
            Ok(Ok(())) => {}
            Ok(Err((check, failure))) => {
                let (message, tail) = match failure {
                    Failure::Unmet(message) => (message, String::new()),
                    Failure::Error(message) => (message.clone(), message),
                };
                let message = check.fail.clone().unwrap_or(message);
                return Outcome {
                    status: Status::Fail,
                    exit: None,
                    message: head(&message, MESSAGE_BYTES).to_owned(),
                    tail,
                };
            }
            Err(_) => {
                return Outcome {
                    status: Status::Error,
                    exit: None,
                    message: String::new(),
                    tail: format!("probes timed out after {}s", timeout.as_secs()),
                };
            }
        }
    }
    if task.check.trim().is_empty() {
        return Outcome {
            status: Status::Pass,
            exit: None,
            message: String::new(),
            tail: String::new(),
        };
    }
    let left = timeout.saturating_sub(started.elapsed());
    exec::run(dir, name, &task.check, env, left).await
}

async fn probes<'a>(
    checks: &'a [ProbeCheckV1],
    env: &BTreeMap<String, String>,
) -> Result<(), (&'a ProbeCheckV1, Failure)> {
    let Some(first) = checks.first() else {
        return Ok(());
    };
    let client = client(env.get("KUBECONFIG"))
        .await
        .map_err(|failure| (first, failure))?;
    for check in checks {
        probe(&client, &check.probe)
            .await
            .map_err(|failure| (check, failure))?;
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    /// The cluster answered, and not as asked: the learner's message.
    Unmet(String),
    /// The question could not be asked.
    Error(String),
}

async fn probe(client: &Client, probe: &ProbeV1) -> Result<(), Failure> {
    match probe {
        ProbeV1::K8s {
            target,
            namespace,
            path,
            equals,
        } => {
            let (resource, name) = split_target(target)?;
            let object = get_object(client, resource, name, namespace.as_deref()).await?;
            match path {
                None => Ok(()),
                Some(path) => field_matches(&object, target, path, equals.as_deref()),
            }
        }
        ProbeV1::Rollout {
            target,
            namespace,
            replicas,
        } => {
            let (resource, name) = split_target(target)?;
            if !matches!(resource, "deployment" | "deployments" | "deployments.apps") {
                return Err(Failure::Error(format!(
                    "rollout takes deployment/<name>, not {target}"
                )));
            }
            let api: Api<Deployment> = match namespace {
                Some(namespace) => Api::namespaced(client.clone(), namespace),
                None => Api::default_namespaced(client.clone()),
            };
            let deployment = api.get_opt(name).await.map_err(api_error)?;
            let deployment = deployment
                .ok_or_else(|| Failure::Unmet(format!("Deployment {name} does not exist.")))?;
            rolled_out(&deployment, name, *replicas)
        }
        ProbeV1::CanI {
            verbs,
            resource,
            namespace,
            user,
            groups,
            allowed: wanted,
        } => {
            let api: Api<SubjectAccessReview> = Api::all(client.clone());
            let scope = namespace
                .as_ref()
                .map_or_else(String::new, |namespace| format!(" in {namespace}"));
            // Every verb must have the one answer asked for.
            for verb in verbs {
                let review = access_review(verb, resource, namespace.clone(), user, groups.clone());
                let answer = api
                    .create(&PostParams::default(), &review)
                    .await
                    .map_err(api_error)?;
                let allowed = answer.status.is_some_and(|status| status.allowed);
                match (allowed, *wanted) {
                    (true, true) | (false, false) => {}
                    (false, true) => {
                        return Err(Failure::Unmet(format!(
                            "{user} may not {verb} {resource}{scope}."
                        )));
                    }
                    (true, false) => {
                        return Err(Failure::Unmet(format!(
                            "{user} may still {verb} {resource}{scope}."
                        )));
                    }
                }
            }
            Ok(())
        }
    }
}

/// The kubeconfig at `path`, else what kubectl would find as root.
async fn client(path: Option<&String>) -> Result<Client, Failure> {
    let no_config = |error: String| Failure::Error(format!("No usable kubeconfig: {error}"));
    let mut config = match path {
        Some(path) => {
            let kubeconfig =
                Kubeconfig::read_from(path).map_err(|error| no_config(error.to_string()))?;
            Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
                .await
                .map_err(|error| no_config(error.to_string()))?
        }
        None => Config::infer()
            .await
            .map_err(|error| no_config(error.to_string()))?,
    };
    config.connect_timeout = Some(Duration::from_secs(2));
    config.read_timeout = Some(Duration::from_secs(4));
    Client::try_from(config)
        .map_err(|error| Failure::Error(format!("No Kubernetes client: {error}")))
}

fn api_error(error: kube::Error) -> Failure {
    Failure::Error(format!("The Kubernetes API refused the request: {error}"))
}

fn split_target(target: &str) -> Result<(&str, &str), Failure> {
    match target.split_once('/') {
        Some((resource, name)) if !resource.is_empty() && !name.is_empty() => Ok((resource, name)),
        _ => Err(Failure::Error(format!("{target} is not <resource>/<name>"))),
    }
}

/// `deployment`, `deployments` or `Deployment`, optionally `.apps`, as
/// kubectl resolves them.
fn names_resource(wanted: &str, plural: &str, kind: &str, group: &str) -> bool {
    let (name, wanted_group) = match wanted.split_once('.') {
        Some((name, group)) => (name, Some(group)),
        None => (wanted, None),
    };
    wanted_group.is_none_or(|wanted_group| wanted_group == group)
        && (name.eq_ignore_ascii_case(plural) || name.eq_ignore_ascii_case(kind))
}

async fn get_object(
    client: &Client,
    resource: &str,
    name: &str,
    namespace: Option<&str>,
) -> Result<JsonValue, Failure> {
    let discovery = Discovery::new(client.clone())
        .run_aggregated()
        .await
        .map_err(api_error)?;
    // The core group is listed first, so `pods` is never another group's.
    let found = discovery.groups().find_map(|group| {
        group
            .recommended_resources()
            .into_iter()
            .find(|(api, _)| names_resource(resource, &api.plural, &api.kind, &api.group))
    });
    let (api_resource, capabilities) = found
        .ok_or_else(|| Failure::Error(format!("The cluster has no resource type {resource}.")))?;
    let namespaced = matches!(capabilities.scope, Scope::Namespaced);
    let api: Api<DynamicObject> = match (namespaced, namespace) {
        (false, _) => Api::all_with(client.clone(), &api_resource),
        (true, Some(namespace)) => Api::namespaced_with(client.clone(), namespace, &api_resource),
        (true, None) => Api::default_namespaced_with(client.clone(), &api_resource),
    };
    let object = api.get_opt(name).await.map_err(api_error)?;
    let object = object.ok_or_else(|| {
        let scope = match (namespaced, namespace) {
            (true, Some(namespace)) => format!(" in {namespace}"),
            _ => String::new(),
        };
        Failure::Unmet(format!(
            "{} {name}{scope} does not exist.",
            api_resource.kind
        ))
    })?;
    serde_json::to_value(object)
        .map_err(|error| Failure::Error(format!("The object is not JSON: {error}")))
}

fn field_matches(
    object: &JsonValue,
    target: &str,
    path: &str,
    equals: Option<&str>,
) -> Result<(), Failure> {
    let found = object
        .query(path)
        .map_err(|error| Failure::Error(format!("{path} is not a JSONPath: {error}")))?;
    let Some(expected) = equals else {
        return if found.is_empty() {
            Err(Failure::Unmet(format!("{target} has no {path}.")))
        } else {
            Ok(())
        };
    };
    match found.as_slice() {
        [value] if text(value) == expected => Ok(()),
        [] => Err(Failure::Unmet(format!(
            "{target} has no {path}; it should be {expected}."
        ))),
        [value] => Err(Failure::Unmet(format!(
            "{target} has {path} {}, not {expected}.",
            text(value)
        ))),
        _ => Err(Failure::Unmet(format!(
            "{path} matches more than one value in {target}."
        ))),
    }
}

/// A string as it is, anything else as compact JSON.
fn text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn rolled_out(deployment: &Deployment, name: &str, replicas: Option<u32>) -> Result<(), Failure> {
    let wanted = deployment
        .spec
        .as_ref()
        .and_then(|spec| spec.replicas)
        .unwrap_or(1);
    if let Some(replicas) = replicas
        && i64::from(replicas) != i64::from(wanted)
    {
        return Err(Failure::Unmet(format!(
            "Deployment {name} wants {wanted} replicas, not {replicas}."
        )));
    }
    let generation = deployment.metadata.generation.unwrap_or(0);
    let status = deployment.status.clone().unwrap_or_default();
    if status.observed_generation.unwrap_or(0) < generation {
        return Err(Failure::Unmet(format!(
            "The Deployment controller has not caught up with the latest change to {name} yet."
        )));
    }
    let counts = [
        status.replicas.unwrap_or(0),
        status.updated_replicas.unwrap_or(0),
        status.ready_replicas.unwrap_or(0),
        status.available_replicas.unwrap_or(0),
    ];
    if counts.iter().any(|count| *count != wanted) {
        return Err(Failure::Unmet(format!(
            "Deployment {name} does not have {wanted} updated, Ready and available replicas yet."
        )));
    }
    Ok(())
}

fn access_review(
    verb: &str,
    resource: &str,
    namespace: Option<String>,
    user: &str,
    groups: Vec<String>,
) -> SubjectAccessReview {
    let (resource, subresource) = match resource.split_once('/') {
        Some((resource, subresource)) => (resource, Some(subresource.to_owned())),
        None => (resource, None),
    };
    let (resource, group) = match resource.split_once('.') {
        Some((resource, group)) => (resource, group),
        None => (resource, ""),
    };
    SubjectAccessReview {
        spec: SubjectAccessReviewSpec {
            user: Some(user.to_owned()),
            groups: (!groups.is_empty()).then_some(groups),
            resource_attributes: Some(ResourceAttributes {
                namespace,
                verb: Some(verb.to_owned()),
                group: Some(group.to_owned()),
                resource: Some(resource.to_owned()),
                subresource,
                ..ResourceAttributes::default()
            }),
            ..SubjectAccessReviewSpec::default()
        },
        ..SubjectAccessReview::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{DeploymentSpec, DeploymentStatus};
    use kube::api::ObjectMeta;
    use serde_json::json;

    #[tokio::test]
    async fn probes_fail_the_task_before_its_script_runs() {
        let temp = tempfile::tempdir().expect("tempdir");
        let marker = temp.path().join("ran");
        let mut spec = SpecTaskV1 {
            id: "t".to_owned(),
            check: String::new(),
            probes: Vec::new(),
            needs: Vec::new(),
            solve: None,
        };
        let env = BTreeMap::from([(
            "KUBECONFIG".to_owned(),
            temp.path().join("missing").display().to_string(),
        )]);
        let timeout = Duration::from_secs(5);
        // Neither probes nor a script: nothing to fail.
        let outcome = task(temp.path(), "t", &spec, &env, timeout).await;
        assert_eq!(outcome.status, Status::Pass);

        spec.check = format!("touch {}", marker.display());
        spec.probes = vec![ProbeCheckV1 {
            probe: ProbeV1::K8s {
                target: "node/n".to_owned(),
                namespace: None,
                path: None,
                equals: None,
            },
            fail: Some("Start the node.".to_owned()),
        }];
        let outcome = task(temp.path(), "t", &spec, &env, timeout).await;
        assert_eq!(outcome.status, Status::Fail);
        assert_eq!(outcome.message, "Start the node.");
        assert!(outcome.tail.contains("kubeconfig"), "{}", outcome.tail);
        assert!(!marker.exists());
    }

    #[test]
    fn resources_resolve_like_kubectl() {
        assert!(names_resource(
            "deployment",
            "deployments",
            "Deployment",
            "apps"
        ));
        assert!(names_resource(
            "deployments.apps",
            "deployments",
            "Deployment",
            "apps"
        ));
        assert!(names_resource(
            "Deployment",
            "deployments",
            "Deployment",
            "apps"
        ));
        assert!(!names_resource(
            "deployments.batch",
            "deployments",
            "Deployment",
            "apps"
        ));
        assert!(!names_resource("pod", "deployments", "Deployment", "apps"));
    }

    #[test]
    fn fields_compare_strings_raw_and_the_rest_as_json() {
        let object = json!({"spec": {"replicas": 1, "selector": {"app": "web"}, "name": "web"}});
        assert_eq!(
            field_matches(&object, "d/web", "$.spec.replicas", Some("1")),
            Ok(())
        );
        assert_eq!(
            field_matches(
                &object,
                "d/web",
                "$.spec.selector",
                Some(r#"{"app":"web"}"#)
            ),
            Ok(())
        );
        assert_eq!(
            field_matches(&object, "d/web", "$.spec.name", Some("web")),
            Ok(())
        );
        assert_eq!(field_matches(&object, "d/web", "$.spec.name", None), Ok(()));
        assert_eq!(
            field_matches(&object, "d/web", "$.spec.replicas", Some("2")),
            Err(Failure::Unmet(
                "d/web has $.spec.replicas 1, not 2.".to_owned()
            ))
        );
        assert!(matches!(
            field_matches(&object, "d/web", "$.spec.missing", None),
            Err(Failure::Unmet(_))
        ));
    }

    fn deployment(wanted: i32, generation: i64, observed: i64, counts: [i32; 4]) -> Deployment {
        Deployment {
            metadata: ObjectMeta {
                generation: Some(generation),
                ..ObjectMeta::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(wanted),
                ..DeploymentSpec::default()
            }),
            status: Some(DeploymentStatus {
                observed_generation: Some(observed),
                replicas: Some(counts[0]),
                updated_replicas: Some(counts[1]),
                ready_replicas: Some(counts[2]),
                available_replicas: Some(counts[3]),
                ..DeploymentStatus::default()
            }),
        }
    }

    #[test]
    fn rollouts_need_the_current_generation_fully_available() {
        assert_eq!(
            rolled_out(&deployment(2, 3, 3, [2, 2, 2, 2]), "web", None),
            Ok(())
        );
        assert_eq!(
            rolled_out(&deployment(2, 3, 3, [2, 2, 2, 2]), "web", Some(2)),
            Ok(())
        );
        assert!(rolled_out(&deployment(2, 3, 3, [2, 2, 2, 2]), "web", Some(1)).is_err());
        assert!(rolled_out(&deployment(2, 3, 2, [2, 2, 2, 2]), "web", None).is_err());
        // An old pod still terminating, or a new one not yet Ready.
        assert!(rolled_out(&deployment(2, 3, 3, [3, 2, 2, 2]), "web", None).is_err());
        assert!(rolled_out(&deployment(2, 3, 3, [2, 2, 1, 1]), "web", None).is_err());
    }

    #[test]
    fn access_reviews_split_group_and_subresource() {
        let review = access_review("get", "pods/log", Some("dev".to_owned()), "jane", vec![]);
        let attributes = review.spec.resource_attributes.unwrap_or_default();
        assert_eq!(attributes.resource.as_deref(), Some("pods"));
        assert_eq!(attributes.subresource.as_deref(), Some("log"));
        assert_eq!(attributes.group.as_deref(), Some(""));
        assert!(review.spec.groups.is_none());

        let review = access_review(
            "create",
            "deployments.apps",
            None,
            "system:serviceaccount:apps:deployer",
            vec!["system:serviceaccounts".to_owned()],
        );
        let attributes = review.spec.resource_attributes.unwrap_or_default();
        assert_eq!(attributes.resource.as_deref(), Some("deployments"));
        assert_eq!(attributes.group.as_deref(), Some("apps"));
        assert_eq!(attributes.namespace, None);
    }
}
