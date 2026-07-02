package workflow

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/externalsecrets"
)

const (
	bootstrapManagedByValue = "stardrive"
)

func (a *App) BootstrapSecrets(ctx context.Context, req BootstrapSecretsRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}

	kubeconfigPath, cleanup, err := a.writeTempKubeconfigFromInfisical(ctx, cfg)
	if err != nil {
		return err
	}
	defer cleanup()

	clientID, clientSecret, err := bootstrapUniversalAuthCredentials(cfg)
	if err != nil {
		return err
	}

	params := externalsecrets.BootstrapUniversalAuthParams{
		Kubeconfig:          kubeconfigPath,
		ControllerNamespace: externalsecrets.DefaultControllerNamespace,
		StoreName:           externalsecrets.DefaultStoreName,
		AuthSecretName:      externalsecrets.DefaultAuthSecretName,
		HostAPI:             strings.TrimRight(cfg.Infisical.SiteURL, "/") + "/api",
		ProjectSlug:         cfg.Infisical.ProjectSlug,
		EnvironmentSlug:     cfg.Infisical.Environment,
		SecretsPath:         cfg.Secrets().OperatorShared,
		ClientID:            clientID,
		ClientSecret:        clientSecret,
		Annotations: map[string]string{
			"app.kubernetes.io/managed-by": bootstrapManagedByValue,
			"stardrive.dev/infisical-auth": "operator-session",
		},
	}
	if err := externalsecrets.BootstrapUniversalAuth(ctx, params); err != nil {
		return err
	}

	a.Printf("Bootstrapped External Secrets Operator with Infisical Universal Auth for %s\n", cfg.Cluster.Name)
	return nil
}

func bootstrapUniversalAuthCredentials(cfg *config.Config) (string, string, error) {
	if cfg == nil {
		return "", "", fmt.Errorf("config is required")
	}

	clientID := strings.TrimSpace(cfg.Infisical.ClientID)
	clientSecret := strings.TrimSpace(cfg.Infisical.ClientSecret)

	switch {
	case clientID == "":
		return "", "", fmt.Errorf("INFISICAL_CLIENT_ID is required for bootstrap-secrets")
	case clientSecret == "":
		return "", "", fmt.Errorf("INFISICAL_CLIENT_SECRET is required for bootstrap-secrets")
	default:
		return clientID, clientSecret, nil
	}
}

func (a *App) writeTempKubeconfigFromInfisical(ctx context.Context, cfg *config.Config) (string, func(), error) {
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return "", nil, err
	}
	secrets, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterAccess)
	if err != nil {
		return "", nil, err
	}
	kubeconfig := []byte(secrets[secretKubeconfigYAML])
	if len(kubeconfig) == 0 {
		return "", nil, fmt.Errorf("kubeconfig is missing from Infisical path %s", cfg.Secrets().ClusterAccess)
	}
	file, err := os.CreateTemp("", "stardrive-kubeconfig-*.yaml")
	if err != nil {
		return "", nil, err
	}
	if _, err := file.Write(kubeconfig); err != nil {
		file.Close()
		os.Remove(file.Name())
		return "", nil, err
	}
	if err := file.Close(); err != nil {
		os.Remove(file.Name())
		return "", nil, err
	}
	return file.Name(), func() { _ = os.Remove(file.Name()) }, nil
}
