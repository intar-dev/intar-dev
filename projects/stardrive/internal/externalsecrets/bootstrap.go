package externalsecrets

import (
	"context"
	"fmt"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	DefaultControllerNamespace = "external-secrets"
	DefaultStoreName           = "infisical"
	DefaultAuthSecretName      = "infisical-universal-auth"
	defaultBootstrapTimeout    = 5 * time.Minute
	clusterSecretStoreKind     = "ClusterSecretStore"
	readyConditionType         = "Ready"
)

var clusterSecretStoreGVK = schema.GroupVersionKind{
	Group:   "external-secrets.io",
	Version: "v1",
	Kind:    clusterSecretStoreKind,
}

type BootstrapUniversalAuthParams struct {
	Kubeconfig          string
	ControllerNamespace string
	StoreName           string
	AuthSecretName      string
	HostAPI             string
	ProjectSlug         string
	EnvironmentSlug     string
	SecretsPath         string
	ClientID            string
	ClientSecret        string
	Annotations         map[string]string
	Timeout             time.Duration
}

func BootstrapUniversalAuth(ctx context.Context, params BootstrapUniversalAuthParams) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := validateBootstrapUniversalAuthParams(&params); err != nil {
		return err
	}

	cfg, err := clientcmd.BuildConfigFromFlags("", strings.TrimSpace(params.Kubeconfig))
	if err != nil {
		return fmt.Errorf("load kubeconfig: %w", err)
	}
	timeout := params.Timeout
	if timeout <= 0 {
		timeout = defaultBootstrapTimeout
	}
	if err := waitForClusterSecretStoreCRD(ctx, cfg, timeout); err != nil {
		return err
	}
	kubeClient, err := newBootstrapClient(cfg)
	if err != nil {
		return fmt.Errorf("create kubernetes client: %w", err)
	}
	if err := waitForExternalSecretsDeployment(ctx, kubeClient, params.ControllerNamespace, timeout); err != nil {
		return err
	}
	if err := upsertAuthSecret(ctx, kubeClient, params); err != nil {
		return err
	}
	if err := upsertClusterSecretStore(ctx, kubeClient, params); err != nil {
		return err
	}
	return waitForClusterSecretStoreReady(ctx, kubeClient, params.StoreName, timeout)
}

func ReadAuthSecretAnnotations(ctx context.Context, kubeconfigPath, namespace, name string) (map[string]string, error) {
	cfg, err := clientcmd.BuildConfigFromFlags("", strings.TrimSpace(kubeconfigPath))
	if err != nil {
		return nil, fmt.Errorf("load kubeconfig: %w", err)
	}
	kubeClient, err := newBootstrapClient(cfg)
	if err != nil {
		return nil, fmt.Errorf("create kubernetes client: %w", err)
	}
	var secret corev1.Secret
	if err := kubeClient.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get auth secret %s/%s: %w", namespace, name, err)
	}
	return copyStringMap(secret.Annotations), nil
}

func validateBootstrapUniversalAuthParams(params *BootstrapUniversalAuthParams) error {
	if params == nil {
		return fmt.Errorf("bootstrap params are required")
	}
	params.Kubeconfig = strings.TrimSpace(params.Kubeconfig)
	params.ControllerNamespace = strings.TrimSpace(params.ControllerNamespace)
	params.StoreName = strings.TrimSpace(params.StoreName)
	params.AuthSecretName = strings.TrimSpace(params.AuthSecretName)
	params.HostAPI = normalizeHostAPI(params.HostAPI)
	params.ProjectSlug = strings.TrimSpace(params.ProjectSlug)
	params.EnvironmentSlug = strings.TrimSpace(params.EnvironmentSlug)
	params.SecretsPath = strings.TrimSpace(params.SecretsPath)
	params.ClientID = strings.TrimSpace(params.ClientID)
	params.ClientSecret = strings.TrimSpace(params.ClientSecret)
	if params.ControllerNamespace == "" {
		params.ControllerNamespace = DefaultControllerNamespace
	}
	if params.StoreName == "" {
		params.StoreName = DefaultStoreName
	}
	if params.AuthSecretName == "" {
		params.AuthSecretName = DefaultAuthSecretName
	}
	switch {
	case params.Kubeconfig == "":
		return fmt.Errorf("kubeconfig is required")
	case params.HostAPI == "":
		return fmt.Errorf("host API is required")
	case params.ProjectSlug == "":
		return fmt.Errorf("infisical project slug is required")
	case params.EnvironmentSlug == "":
		return fmt.Errorf("infisical environment slug is required")
	case params.SecretsPath == "":
		return fmt.Errorf("infisical secrets path is required")
	case params.ClientID == "":
		return fmt.Errorf("client ID is required")
	case params.ClientSecret == "":
		return fmt.Errorf("client secret is required")
	default:
		return nil
	}
}

func normalizeHostAPI(hostAPI string) string {
	hostAPI = strings.TrimRight(strings.TrimSpace(hostAPI), "/")
	if hostAPI == "" {
		return ""
	}
	return strings.TrimSuffix(hostAPI, "/api")
}

func waitForClusterSecretStoreCRD(ctx context.Context, cfg *rest.Config, timeout time.Duration) error {
	discoveryCfg := rest.CopyConfig(cfg)
	discoveryCfg.Timeout = 10 * time.Second
	discoveryClient, err := discovery.NewDiscoveryClientForConfig(discoveryCfg)
	if err != nil {
		return fmt.Errorf("create kubernetes discovery client: %w", err)
	}
	return wait.PollUntilContextTimeout(ctx, 2*time.Second, timeout, true, func(ctx context.Context) (bool, error) {
		resourceList, err := discoveryClient.ServerResourcesForGroupVersion(clusterSecretStoreGVK.GroupVersion().String())
		if err != nil {
			if apierrors.IsNotFound(err) || discovery.IsGroupDiscoveryFailedError(err) || strings.Contains(strings.ToLower(err.Error()), "not found") {
				return false, nil
			}
			return false, err
		}
		for _, resource := range resourceList.APIResources {
			if resource.Name == "clustersecretstores" {
				return true, nil
			}
		}
		return false, nil
	})
}

func newBootstrapClient(cfg *rest.Config) (ctrlclient.Client, error) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = appsv1.AddToScheme(scheme)
	return ctrlclient.New(cfg, ctrlclient.Options{Scheme: scheme})
}

func waitForExternalSecretsDeployment(ctx context.Context, kubeClient ctrlclient.Client, namespace string, timeout time.Duration) error {
	key := ctrlclient.ObjectKey{Name: "external-secrets", Namespace: namespace}
	return wait.PollUntilContextTimeout(ctx, 2*time.Second, timeout, true, func(ctx context.Context) (bool, error) {
		var deployment appsv1.Deployment
		if err := kubeClient.Get(ctx, key, &deployment); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		if deployment.Spec.Replicas == nil {
			return false, nil
		}
		desired := *deployment.Spec.Replicas
		if desired == 0 {
			return true, nil
		}
		return deployment.Status.UpdatedReplicas >= desired &&
			deployment.Status.AvailableReplicas >= desired &&
			deployment.Status.ObservedGeneration >= deployment.Generation, nil
	})
}

func upsertAuthSecret(ctx context.Context, kubeClient ctrlclient.Client, params BootstrapUniversalAuthParams) error {
	key := types.NamespacedName{Name: params.AuthSecretName, Namespace: params.ControllerNamespace}
	var existing corev1.Secret
	err := kubeClient.Get(ctx, key, &existing)
	if apierrors.IsNotFound(err) {
		secret := &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{
				Name:        params.AuthSecretName,
				Namespace:   params.ControllerNamespace,
				Annotations: copyStringMap(params.Annotations),
			},
			Type: corev1.SecretTypeOpaque,
			Data: map[string][]byte{
				"clientId":     []byte(params.ClientID),
				"clientSecret": []byte(params.ClientSecret),
			},
		}
		return kubeClient.Create(ctx, secret)
	}
	if err != nil {
		return err
	}
	existing.Data = map[string][]byte{
		"clientId":     []byte(params.ClientID),
		"clientSecret": []byte(params.ClientSecret),
	}
	existing.Annotations = copyStringMap(params.Annotations)
	return kubeClient.Update(ctx, &existing)
}

func upsertClusterSecretStore(ctx context.Context, kubeClient ctrlclient.Client, params BootstrapUniversalAuthParams) error {
	desired := desiredClusterSecretStore(params)
	key := types.NamespacedName{Name: params.StoreName}
	var existing unstructured.Unstructured
	existing.SetGroupVersionKind(clusterSecretStoreGVK)
	err := kubeClient.Get(ctx, key, &existing)
	if apierrors.IsNotFound(err) {
		return kubeClient.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	existing.Object["spec"] = desired.Object["spec"]
	existing.SetAnnotations(copyStringMap(params.Annotations))
	return kubeClient.Update(ctx, &existing)
}

func desiredClusterSecretStore(params BootstrapUniversalAuthParams) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]any{
			"apiVersion": clusterSecretStoreGVK.GroupVersion().String(),
			"kind":       clusterSecretStoreKind,
			"metadata": map[string]any{
				"name":        params.StoreName,
				"annotations": stringMap(params.Annotations),
			},
			"spec": map[string]any{
				"provider": map[string]any{
					"infisical": map[string]any{
						"hostAPI": params.HostAPI,
						"secretsScope": map[string]any{
							"projectSlug":     params.ProjectSlug,
							"environmentSlug": params.EnvironmentSlug,
							"secretsPath":     params.SecretsPath,
						},
						"auth": map[string]any{
							"universalAuthCredentials": map[string]any{
								"clientId": map[string]any{
									"name":      params.AuthSecretName,
									"namespace": params.ControllerNamespace,
									"key":       "clientId",
								},
								"clientSecret": map[string]any{
									"name":      params.AuthSecretName,
									"namespace": params.ControllerNamespace,
									"key":       "clientSecret",
								},
							},
						},
					},
				},
			},
		},
	}
}

func waitForClusterSecretStoreReady(ctx context.Context, kubeClient ctrlclient.Client, name string, timeout time.Duration) error {
	key := types.NamespacedName{Name: name}
	lastMessage := ""
	err := wait.PollUntilContextTimeout(ctx, 2*time.Second, timeout, true, func(ctx context.Context) (bool, error) {
		var store unstructured.Unstructured
		store.SetGroupVersionKind(clusterSecretStoreGVK)
		if err := kubeClient.Get(ctx, key, &store); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		conditions, found, err := unstructured.NestedSlice(store.Object, "status", "conditions")
		if err != nil || !found {
			return false, err
		}
		converted := make([]metav1.Condition, 0, len(conditions))
		for _, item := range conditions {
			data, _ := item.(map[string]any)
			condition := metav1.Condition{}
			condition.Type, _, _ = unstructured.NestedString(data, "type")
			statusValue, _, _ := unstructured.NestedString(data, "status")
			condition.Status = metav1.ConditionStatus(statusValue)
			condition.Message, _, _ = unstructured.NestedString(data, "message")
			converted = append(converted, condition)
		}
		ready := apimeta.FindStatusCondition(converted, readyConditionType)
		if ready == nil {
			return false, nil
		}
		if ready.Status == metav1.ConditionTrue {
			return true, nil
		}
		if ready.Status == metav1.ConditionFalse {
			lastMessage = ready.Message
			return false, nil
		}
		return false, nil
	})
	if err != nil {
		if lastMessage != "" {
			return fmt.Errorf("ClusterSecretStore %s not ready: %s", name, lastMessage)
		}
		return err
	}
	return nil
}

func stringMap(values map[string]string) map[string]any {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]any, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}

func copyStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for key, value := range values {
		out[key] = value
	}
	return out
}
