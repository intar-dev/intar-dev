package workflow

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"strings"
	"time"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/infisical"
)

func (a *App) ensureRegistryTLSMaterial(ctx context.Context, cfg *config.Config, infClient *infisical.Client, runtime runtimeSecrets) (runtimeSecrets, error) {
	if strings.TrimSpace(runtime.RegistryCACertPEM) != "" &&
		strings.TrimSpace(runtime.RegistryTLSCertPEM) != "" &&
		strings.TrimSpace(runtime.RegistryTLSKeyPEM) != "" {
		return runtime, nil
	}

	caPEM, tlsCertPEM, tlsKeyPEM, err := generateRegistryTLSMaterial(cfg)
	if err != nil {
		return runtimeSecrets{}, err
	}

	runtime.RegistryCACertPEM = caPEM
	runtime.RegistryTLSCertPEM = tlsCertPEM
	runtime.RegistryTLSKeyPEM = tlsKeyPEM

	if infClient != nil {
		if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime, map[string]string{
			secretRegistryCACertPEM:  runtime.RegistryCACertPEM,
			secretRegistryTLSCertPEM: runtime.RegistryTLSCertPEM,
			secretRegistryTLSKeyPEM:  runtime.RegistryTLSKeyPEM,
		}); err != nil {
			return runtimeSecrets{}, err
		}
	}

	if err := a.writeLocalStateFile(cfg.Cluster.Name, "registry-ca.crt", []byte(runtime.RegistryCACertPEM), 0o600); err != nil {
		return runtimeSecrets{}, err
	}
	return runtime, nil
}

func generateRegistryTLSMaterial(cfg *config.Config) (caPEM, tlsCertPEM, tlsKeyPEM string, err error) {
	now := time.Now().UTC()

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", "", fmt.Errorf("generate registry CA key: %w", err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(now.UnixNano()),
		Subject:               pkix.Name{CommonName: "stardrive-registry-ca"},
		NotBefore:             now.Add(-1 * time.Hour),
		NotAfter:              now.AddDate(5, 0, 0),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return "", "", "", fmt.Errorf("create registry CA certificate: %w", err)
	}

	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", "", fmt.Errorf("generate registry TLS key: %w", err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(now.UnixNano() + 1),
		Subject:      pkix.Name{CommonName: cfg.EffectiveRegistryAddress()},
		NotBefore:    now.Add(-1 * time.Hour),
		NotAfter:     now.AddDate(2, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{
			cfg.RegistryServiceName(),
			fmt.Sprintf("%s.%s", cfg.RegistryServiceName(), cfg.RegistryNamespace()),
			fmt.Sprintf("%s.%s.svc", cfg.RegistryServiceName(), cfg.RegistryNamespace()),
			fmt.Sprintf("%s.%s.svc.cluster.local", cfg.RegistryServiceName(), cfg.RegistryNamespace()),
			"localhost",
		},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, caTemplate, &serverKey.PublicKey, caKey)
	if err != nil {
		return "", "", "", fmt.Errorf("create registry TLS certificate: %w", err)
	}

	caPEM, err = encodeCertificatePEM(caDER)
	if err != nil {
		return "", "", "", err
	}
	tlsCertPEM, err = encodeCertificatePEM(serverDER)
	if err != nil {
		return "", "", "", err
	}
	tlsKeyPEM, err = encodeECPrivateKeyPEM(serverKey)
	if err != nil {
		return "", "", "", err
	}
	return caPEM, tlsCertPEM, tlsKeyPEM, nil
}

func encodeCertificatePEM(der []byte) (string, error) {
	if len(der) == 0 {
		return "", fmt.Errorf("certificate DER is empty")
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), nil
}

func encodeECPrivateKeyPEM(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", fmt.Errorf("marshal EC private key: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})), nil
}
