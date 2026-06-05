package infisical

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	infisicalsdk "github.com/infisical/go-sdk"
	sdkerrors "github.com/infisical/go-sdk/packages/errors"
)

type Client struct {
	sdk            infisicalsdk.InfisicalClientInterface
	siteURL        string
	httpClient     *http.Client
	getAccessToken func() string
}

func NewClient(ctx context.Context, siteURL, clientID, clientSecret string) (*Client, error) {
	siteURL = normalizeSiteURL(siteURL)
	if siteURL == "" {
		return nil, fmt.Errorf("infisical site URL is required")
	}
	if strings.TrimSpace(clientID) == "" {
		return nil, fmt.Errorf("infisical client ID is required")
	}
	if strings.TrimSpace(clientSecret) == "" {
		return nil, fmt.Errorf("infisical client secret is required")
	}

	slog.Debug("authenticating with Infisical", "site_url", siteURL)
	sdk := infisicalsdk.NewInfisicalClient(ctx, infisicalsdk.Config{
		SiteUrl:          siteURL,
		AutoTokenRefresh: true,
	})
	if _, err := sdk.Auth().UniversalAuthLogin(strings.TrimSpace(clientID), strings.TrimSpace(clientSecret)); err != nil {
		return nil, fmt.Errorf("infisical universal auth login: %w", err)
	}
	slog.Debug("authenticated with Infisical", "site_url", siteURL)

	return &Client{
		sdk:        sdk,
		siteURL:    siteURL,
		httpClient: http.DefaultClient,
		getAccessToken: func() string {
			return sdk.Auth().GetAccessToken()
		},
	}, nil
}

func (c *Client) AccessToken() string {
	if c == nil {
		return ""
	}
	if c.getAccessToken != nil {
		return strings.TrimSpace(c.getAccessToken())
	}
	if c.sdk == nil {
		return ""
	}
	return strings.TrimSpace(c.sdk.Auth().GetAccessToken())
}

func (c *Client) GetSecret(ctx context.Context, projectID, environment, path, key string) (string, error) {
	secret, err := c.sdk.Secrets().Retrieve(infisicalsdk.RetrieveSecretOptions{
		ProjectID:              strings.TrimSpace(projectID),
		Environment:            strings.TrimSpace(environment),
		SecretPath:             normalizeSecretPath(path),
		SecretKey:              strings.TrimSpace(key),
		ExpandSecretReferences: true,
	})
	if err != nil {
		return "", fmt.Errorf("retrieve infisical secret %s: %w", key, err)
	}
	return secret.SecretValue, nil
}

func (c *Client) SetSecret(ctx context.Context, projectID, environment, path, key, value string) error {
	_, err := c.sdk.Secrets().Create(infisicalsdk.CreateSecretOptions{
		ProjectID:   strings.TrimSpace(projectID),
		Environment: strings.TrimSpace(environment),
		SecretPath:  normalizeSecretPath(path),
		SecretKey:   strings.TrimSpace(key),
		SecretValue: value,
	})
	if err == nil {
		return nil
	}

	_, updateErr := c.sdk.Secrets().Update(infisicalsdk.UpdateSecretOptions{
		ProjectID:      strings.TrimSpace(projectID),
		Environment:    strings.TrimSpace(environment),
		SecretPath:     normalizeSecretPath(path),
		SecretKey:      strings.TrimSpace(key),
		NewSecretValue: value,
	})
	if updateErr != nil {
		return fmt.Errorf("set infisical secret %s (create: %w, update: %w)", key, err, updateErr)
	}
	return nil
}

func (c *Client) SetSecrets(ctx context.Context, projectID, environment, path string, values map[string]string) error {
	if len(values) == 0 {
		return nil
	}
	slog.Debug("setting Infisical secrets", "project_id", strings.TrimSpace(projectID), "environment", strings.TrimSpace(environment), "path", normalizeSecretPath(path), "count", len(values))
	if err := c.EnsureSecretPath(ctx, projectID, environment, path); err != nil {
		return err
	}
	for key, value := range values {
		if err := c.SetSecret(ctx, projectID, environment, path, key, value); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) GetSecrets(ctx context.Context, projectID, environment, path string) (map[string]string, error) {
	slog.Debug("listing Infisical secrets", "project_id", strings.TrimSpace(projectID), "environment", strings.TrimSpace(environment), "path", normalizeSecretPath(path))
	list, err := c.sdk.Secrets().List(infisicalsdk.ListSecretsOptions{
		ProjectID:              strings.TrimSpace(projectID),
		Environment:            strings.TrimSpace(environment),
		SecretPath:             normalizeSecretPath(path),
		ExpandSecretReferences: true,
	})
	if err != nil {
		return nil, fmt.Errorf("list infisical secrets in %s: %w", path, err)
	}

	out := make(map[string]string, len(list))
	for _, secret := range list {
		out[secret.SecretKey] = secret.SecretValue
	}
	return out, nil
}

func (c *Client) DeleteSecret(ctx context.Context, projectID, environment, path, key string) error {
	_, err := c.sdk.Secrets().Delete(infisicalsdk.DeleteSecretOptions{
		ProjectID:   strings.TrimSpace(projectID),
		Environment: strings.TrimSpace(environment),
		SecretPath:  normalizeSecretPath(path),
		SecretKey:   strings.TrimSpace(key),
	})
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("delete infisical secret %s: %w", key, err)
	}
	return nil
}

func (c *Client) DeleteSecrets(ctx context.Context, projectID, environment, path string) error {
	values, err := c.GetSecrets(ctx, projectID, environment, path)
	if err != nil {
		if IsNotFound(err) {
			return nil
		}
		return err
	}
	for key := range values {
		if err := c.DeleteSecret(ctx, projectID, environment, path, key); err != nil {
			return err
		}
	}
	return nil
}

func (c *Client) EnsureSecretPath(ctx context.Context, projectID, environment, path string) error {
	path = normalizeSecretPath(path)
	if path == "" || path == "/" {
		return nil
	}
	slog.Debug("ensuring Infisical secret path", "project_id", strings.TrimSpace(projectID), "environment", strings.TrimSpace(environment), "path", path)

	current := "/"
	for _, segment := range strings.Split(strings.Trim(path, "/"), "/") {
		_, err := c.sdk.Folders().Create(infisicalsdk.CreateFolderOptions{
			ProjectID:   strings.TrimSpace(projectID),
			Environment: strings.TrimSpace(environment),
			Name:        strings.TrimSpace(segment),
			Path:        current,
		})
		if err != nil && !isFolderAlreadyExistsError(err) {
			return fmt.Errorf("ensure infisical folder %s in %s: %w", segment, current, err)
		}
		if current == "/" {
			current = "/" + segment
		} else {
			current = current + "/" + segment
		}
	}
	return nil
}

func IsNotFound(err error) bool {
	if err == nil {
		return false
	}

	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
		return true
	}

	var sdkErr *sdkerrors.APIError
	return errors.As(err, &sdkErr) && sdkErr.StatusCode == http.StatusNotFound
}

func isFolderAlreadyExistsError(err error) bool {
	var apiErr *sdkerrors.APIError
	if !errors.As(err, &apiErr) {
		return false
	}
	return apiErr.StatusCode == http.StatusConflict ||
		(apiErr.StatusCode == http.StatusBadRequest && strings.Contains(strings.ToLower(apiErr.ErrorMessage), "already exists"))
}

func normalizeSiteURL(siteURL string) string {
	siteURL = strings.TrimSpace(siteURL)
	siteURL = strings.TrimSuffix(siteURL, "/api")
	return strings.TrimRight(siteURL, "/")
}

func normalizeSecretPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return strings.TrimRight(path, "/")
}
