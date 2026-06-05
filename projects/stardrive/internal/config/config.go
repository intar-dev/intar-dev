package config

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/intar-dev/stardrive/internal/fs"
	"github.com/intar-dev/stardrive/internal/names"
	"gopkg.in/yaml.v3"
)

const (
	RoleControlPlane = "control-plane"

	DefaultCiliumVersion      = "v1.19.1"
	DefaultFluxVersion        = "v2.7.3"
	DefaultHetznerCCMVersion  = "v1.26.0"
	DefaultSMBDriverVersion   = "v1.20.1"
	DefaultPrivateNetworkCIDR = "10.42.0.0/24"
	DefaultStorageClassName   = "storagebox-rwx"
	DefaultStorageShareName   = "stardrive"
	DefaultRegistryNamespace  = "registry"
	DefaultRegistryName       = "stardrive-registry"
	DefaultRegistryPort       = 5000
)

type Paths struct {
	ClustersDir string
	StateDir    string
	GitOpsDir   string
}

const (
	EnvInfisicalSiteURL      = "INFISICAL_SITE_URL"
	EnvInfisicalProjectID    = "INFISICAL_PROJECT_ID"
	EnvInfisicalProjectSlug  = "INFISICAL_PROJECT_SLUG"
	EnvInfisicalEnvironment  = "INFISICAL_ENVIRONMENT"
	EnvInfisicalPathRoot     = "INFISICAL_PATH_ROOT"
	EnvInfisicalClientID     = "INFISICAL_CLIENT_ID"
	EnvInfisicalClientSecret = "INFISICAL_CLIENT_SECRET"
	EnvCloudflareZone        = "CLOUDFLARE_ZONE"
	EnvCloudflareAPIHostname = "CLOUDFLARE_API_HOSTNAME"
	EnvCloudflareNodeRecords = "CLOUDFLARE_MANAGE_NODE_RECORDS"
	EnvACMEEmail             = "ACME_EMAIL"
	EnvHCloudServerType      = "HCLOUD_SERVER_TYPE"
	EnvHCloudLocation        = "HCLOUD_LOCATION"
	EnvHCloudPrivateNetCIDR  = "HCLOUD_PRIVATE_NETWORK_CIDR"
	EnvStorageBoxPlan        = "STORAGE_BOX_PLAN"
	EnvStorageBoxLocation    = "STORAGE_BOX_LOCATION"
)

func (p Paths) WithDefaults() Paths {
	if strings.TrimSpace(p.ClustersDir) == "" {
		p.ClustersDir = "clusters"
	}
	if strings.TrimSpace(p.StateDir) == "" {
		p.StateDir = ".stardrive"
	}
	if strings.TrimSpace(p.GitOpsDir) == "" {
		p.GitOpsDir = "gitops"
	}
	return p
}

func (p Paths) ConfigPath(cluster string) string {
	p = p.WithDefaults()
	return filepath.Join(p.ClustersDir, names.Slugify(cluster)+".yaml")
}

type Config struct {
	Cluster   ClusterConfig   `yaml:"cluster"`
	Nodes     []NodeConfig    `yaml:"nodes"`
	DNS       DNSConfig       `yaml:"dns"`
	Hetzner   HetznerConfig   `yaml:"hetzner"`
	Storage   StorageConfig   `yaml:"storage"`
	Infisical InfisicalConfig `yaml:"infisical"`
}

type ClusterConfig struct {
	Name               string `yaml:"name"`
	NodeCount          int    `yaml:"nodeCount"`
	TalosVersion       string `yaml:"talosVersion"`
	KubernetesVersion  string `yaml:"kubernetesVersion"`
	TalosSchematic     string `yaml:"talosSchematic"`
	ACMEEmail          string `yaml:"acmeEmail,omitempty"`
	ControlPlaneTaints bool   `yaml:"controlPlaneTaints"`
	CiliumVersion      string `yaml:"ciliumVersion,omitempty"`
	FluxVersion        string `yaml:"fluxVersion,omitempty"`
}

type NodeConfig struct {
	Name        string            `yaml:"name"`
	ServerID    int64             `yaml:"serverId,omitempty"`
	InstanceID  int64             `yaml:"instanceId,omitempty"`
	Role        string            `yaml:"role"`
	PublicIPv4  string            `yaml:"publicIPv4,omitempty"`
	PrivateIPv4 string            `yaml:"privateIPv4,omitempty"`
	PublicIPv6  string            `yaml:"publicIPv6,omitempty"`
	InstallDisk string            `yaml:"installDisk,omitempty"`
	Labels      map[string]string `yaml:"labels,omitempty"`
}

type DNSConfig struct {
	Provider             string `yaml:"provider"`
	Zone                 string `yaml:"zone"`
	APIHostname          string `yaml:"apiHostname"`
	ManageNodeRecords    bool   `yaml:"manageNodeRecords,omitempty"`
	ManageNodeRecordsSet bool   `yaml:"-"`
}

type HetznerConfig struct {
	ServerType         string `yaml:"serverType"`
	Location           string `yaml:"location"`
	NetworkZone        string `yaml:"networkZone,omitempty"`
	PrivateNetworkCIDR string `yaml:"privateNetworkCIDR"`
	PublicIPv6         bool   `yaml:"publicIPv6,omitempty"`
}

type StorageConfig struct {
	StorageBoxPlan     string `yaml:"storageBoxPlan"`
	StorageBoxLocation string `yaml:"storageBoxLocation"`
	StorageClassName   string `yaml:"storageClassName,omitempty"`
	ShareName          string `yaml:"shareName,omitempty"`
	BootstrapPVCSize   string `yaml:"bootstrapPVCSize,omitempty"`
	SMBDriverVersion   string `yaml:"smbDriverVersion,omitempty"`
	RegistryNamespace  string `yaml:"registryNamespace,omitempty"`
	RegistryName       string `yaml:"registryName,omitempty"`
	RegistryPort       int    `yaml:"registryPort,omitempty"`
	BootstrapPVEnabled bool   `yaml:"bootstrapPVEnabled,omitempty"`
}

type InfisicalConfig struct {
	SiteURL      string `yaml:"siteUrl"`
	ProjectID    string `yaml:"projectId"`
	ProjectSlug  string `yaml:"projectSlug"`
	Environment  string `yaml:"environment"`
	PathRoot     string `yaml:"pathRoot"`
	ClientID     string `yaml:"clientId,omitempty"`
	ClientSecret string `yaml:"clientSecret,omitempty"`
}

type SecretPaths struct {
	OperatorShared   string
	ClusterBootstrap string
	ClusterAccess    string
	ClusterRuntime   string
}

func Load(path string) (*Config, error) {
	cfg, err := load(path)
	if err != nil {
		return nil, err
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func LoadPartial(path string) (*Config, error) {
	return load(path)
}

func load(path string) (*Config, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("config path is required")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	var raw struct {
		DNS struct {
			ManageNodeRecords *bool `yaml:"manageNodeRecords"`
		} `yaml:"dns"`
	}
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse config metadata %s: %w", path, err)
	}
	cfg.DNS.ManageNodeRecordsSet = raw.DNS.ManageNodeRecords != nil

	cfg.ApplyDefaults()
	return &cfg, nil
}

func Save(path string, cfg *Config) error {
	if cfg == nil {
		return fmt.Errorf("config is required")
	}

	cfgCopy := *cfg
	cfgCopy.ApplyDefaults()
	if err := cfgCopy.Validate(); err != nil {
		return err
	}

	data, err := yaml.Marshal(&cfgCopy)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	return fs.WriteFileAtomic(path, data, 0o644)
}

func (c *Config) ApplyDefaults() {
	if c == nil {
		return
	}

	c.Cluster.Name = strings.TrimSpace(c.Cluster.Name)
	c.Cluster.TalosVersion = strings.TrimSpace(c.Cluster.TalosVersion)
	c.Cluster.KubernetesVersion = strings.TrimSpace(c.Cluster.KubernetesVersion)
	c.Cluster.TalosSchematic = strings.TrimSpace(c.Cluster.TalosSchematic)
	c.Cluster.ACMEEmail = defaultString(strings.TrimSpace(c.Cluster.ACMEEmail), os.Getenv(EnvACMEEmail))
	c.Cluster.CiliumVersion = strings.TrimSpace(c.Cluster.CiliumVersion)
	c.Cluster.FluxVersion = strings.TrimSpace(c.Cluster.FluxVersion)
	if c.Cluster.NodeCount == 0 {
		if len(c.Nodes) > 0 {
			c.Cluster.NodeCount = len(c.Nodes)
		} else {
			c.Cluster.NodeCount = 3
		}
	}

	c.DNS.Provider = defaultString(c.DNS.Provider, "cloudflare")
	c.DNS.Zone = defaultString(c.DNS.Zone, os.Getenv(EnvCloudflareZone))
	c.DNS.APIHostname = defaultString(c.DNS.APIHostname, os.Getenv(EnvCloudflareAPIHostname))
	if !c.DNS.ManageNodeRecordsSet {
		if value, ok := lookupEnvBool(EnvCloudflareNodeRecords); ok {
			c.DNS.ManageNodeRecords = value
			c.DNS.ManageNodeRecordsSet = true
		}
	}

	c.Hetzner.ServerType = defaultString(strings.TrimSpace(c.Hetzner.ServerType), os.Getenv(EnvHCloudServerType))
	c.Hetzner.Location = defaultString(strings.TrimSpace(c.Hetzner.Location), os.Getenv(EnvHCloudLocation))
	c.Hetzner.NetworkZone = strings.TrimSpace(c.Hetzner.NetworkZone)
	c.Hetzner.PrivateNetworkCIDR = defaultString(
		defaultString(strings.TrimSpace(c.Hetzner.PrivateNetworkCIDR), os.Getenv(EnvHCloudPrivateNetCIDR)),
		DefaultPrivateNetworkCIDR,
	)

	c.Storage.StorageBoxPlan = defaultString(strings.TrimSpace(c.Storage.StorageBoxPlan), os.Getenv(EnvStorageBoxPlan))
	c.Storage.StorageBoxLocation = defaultString(strings.TrimSpace(c.Storage.StorageBoxLocation), os.Getenv(EnvStorageBoxLocation))
	c.Storage.StorageClassName = defaultString(c.Storage.StorageClassName, DefaultStorageClassName)
	c.Storage.ShareName = defaultString(c.Storage.ShareName, DefaultStorageShareName)
	c.Storage.BootstrapPVCSize = defaultString(c.Storage.BootstrapPVCSize, "100Gi")
	c.Storage.SMBDriverVersion = defaultString(c.Storage.SMBDriverVersion, DefaultSMBDriverVersion)
	c.Storage.RegistryNamespace = defaultString(c.Storage.RegistryNamespace, DefaultRegistryNamespace)
	c.Storage.RegistryName = defaultString(c.Storage.RegistryName, DefaultRegistryName)
	if c.Storage.RegistryPort == 0 {
		c.Storage.RegistryPort = DefaultRegistryPort
	}

	c.Infisical.SiteURL = strings.TrimRight(defaultString(c.Infisical.SiteURL, os.Getenv(EnvInfisicalSiteURL)), "/")
	c.Infisical.ProjectID = defaultString(c.Infisical.ProjectID, os.Getenv(EnvInfisicalProjectID))
	c.Infisical.ProjectSlug = defaultString(c.Infisical.ProjectSlug, os.Getenv(EnvInfisicalProjectSlug))
	c.Infisical.Environment = defaultString(c.Infisical.Environment, os.Getenv(EnvInfisicalEnvironment))
	c.Infisical.PathRoot = normalizeSecretPath(defaultString(c.Infisical.PathRoot, defaultString(os.Getenv(EnvInfisicalPathRoot), "/stardrive")))
	c.Infisical.ClientID = defaultString(c.Infisical.ClientID, os.Getenv(EnvInfisicalClientID))
	c.Infisical.ClientSecret = defaultString(c.Infisical.ClientSecret, os.Getenv(EnvInfisicalClientSecret))

	for i := range c.Nodes {
		c.Nodes[i].Name = strings.TrimSpace(c.Nodes[i].Name)
		c.Nodes[i].Role = normalizeRole(c.Nodes[i].Role)
		c.Nodes[i].PublicIPv4 = strings.TrimSpace(c.Nodes[i].PublicIPv4)
		c.Nodes[i].PrivateIPv4 = strings.TrimSpace(c.Nodes[i].PrivateIPv4)
		c.Nodes[i].PublicIPv6 = strings.TrimSpace(c.Nodes[i].PublicIPv6)
		c.Nodes[i].InstallDisk = strings.TrimSpace(c.Nodes[i].InstallDisk)
		if c.Nodes[i].ServerID == 0 && c.Nodes[i].InstanceID > 0 {
			c.Nodes[i].ServerID = c.Nodes[i].InstanceID
		}
		if c.Nodes[i].InstanceID == 0 && c.Nodes[i].ServerID > 0 {
			c.Nodes[i].InstanceID = c.Nodes[i].ServerID
		}
		if len(c.Nodes[i].Labels) == 0 {
			c.Nodes[i].Labels = nil
		}
	}
}

func (c *Config) Validate() error {
	if c == nil {
		return fmt.Errorf("config is required")
	}

	switch {
	case c.Cluster.Name == "":
		return fmt.Errorf("cluster.name is required")
	case c.Cluster.NodeCount < 3:
		return fmt.Errorf("cluster.nodeCount must be at least 3")
	case c.Cluster.NodeCount%2 == 0:
		return fmt.Errorf("cluster.nodeCount must be odd")
	case c.Cluster.TalosVersion == "":
		return fmt.Errorf("cluster.talosVersion is required")
	case c.Cluster.KubernetesVersion == "":
		return fmt.Errorf("cluster.kubernetesVersion is required")
	case c.Cluster.ACMEEmail == "":
		return fmt.Errorf("cluster.acmeEmail is required")
	case c.DNS.Provider != "cloudflare":
		return fmt.Errorf("dns.provider must be cloudflare")
	case c.DNS.Zone == "":
		return fmt.Errorf("dns.zone is required")
	case c.DNS.APIHostname == "":
		return fmt.Errorf("dns.apiHostname is required")
	case c.Hetzner.ServerType == "":
		return fmt.Errorf("hetzner.serverType is required")
	case c.Hetzner.Location == "":
		return fmt.Errorf("hetzner.location is required")
	case c.Hetzner.PrivateNetworkCIDR == "":
		return fmt.Errorf("hetzner.privateNetworkCIDR is required")
	case c.Storage.StorageBoxPlan == "":
		return fmt.Errorf("storage.storageBoxPlan is required")
	case c.Storage.StorageBoxLocation == "":
		return fmt.Errorf("storage.storageBoxLocation is required")
	case c.Infisical.SiteURL == "":
		return fmt.Errorf("infisical.siteUrl is required")
	case c.Infisical.ProjectID == "":
		return fmt.Errorf("infisical.projectId is required")
	case c.Infisical.ProjectSlug == "":
		return fmt.Errorf("infisical.projectSlug is required")
	case c.Infisical.Environment == "":
		return fmt.Errorf("infisical.environment is required")
	case c.Infisical.PathRoot == "":
		return fmt.Errorf("infisical.pathRoot is required")
	}

	if len(c.Nodes) == 0 {
		return fmt.Errorf("nodes are required")
	}
	if len(c.Nodes) != c.Cluster.NodeCount {
		return fmt.Errorf("nodes count %d must match cluster.nodeCount %d", len(c.Nodes), c.Cluster.NodeCount)
	}

	seenNames := map[string]struct{}{}
	seenServerIDs := map[int64]struct{}{}
	seenPrivateIPs := map[string]struct{}{}

	for i, node := range c.Nodes {
		switch {
		case node.Name == "":
			return fmt.Errorf("nodes[%d].name is required", i)
		case node.Role != RoleControlPlane:
			return fmt.Errorf("nodes[%d].role must be %s", i, RoleControlPlane)
		case node.PrivateIPv4 == "":
			return fmt.Errorf("nodes[%d].privateIPv4 is required", i)
		}

		if _, ok := seenNames[node.Name]; ok {
			return fmt.Errorf("duplicate node name %q", node.Name)
		}
		seenNames[node.Name] = struct{}{}

		if node.ProviderID() > 0 {
			if _, ok := seenServerIDs[node.ProviderID()]; ok {
				return fmt.Errorf("duplicate serverId %d", node.ProviderID())
			}
			seenServerIDs[node.ProviderID()] = struct{}{}
		}

		if _, ok := seenPrivateIPs[node.PrivateIPv4]; ok {
			return fmt.Errorf("duplicate privateIPv4 %q", node.PrivateIPv4)
		}
		seenPrivateIPs[node.PrivateIPv4] = struct{}{}
	}

	return nil
}

func (c *Config) ControlPlaneNodes() []NodeConfig {
	if c == nil {
		return nil
	}

	nodes := make([]NodeConfig, 0, len(c.Nodes))
	for _, node := range c.Nodes {
		if node.Role == RoleControlPlane {
			nodes = append(nodes, node)
		}
	}
	return nodes
}

func (c *Config) NodeNames() []string {
	names := make([]string, 0, len(c.Nodes))
	for _, node := range c.Nodes {
		names = append(names, node.Name)
	}
	slices.Sort(names)
	return names
}

func (c *Config) EffectiveCiliumVersion() string {
	if strings.TrimSpace(c.Cluster.CiliumVersion) != "" {
		return c.Cluster.CiliumVersion
	}
	return DefaultCiliumVersion
}

func (c *Config) EffectiveFluxVersion() string {
	version := strings.TrimSpace(c.Cluster.FluxVersion)
	if version == "" || strings.EqualFold(version, "latest") {
		return DefaultFluxVersion
	}
	return version
}

func (c *Config) EffectiveRegistryAddress() string {
	namespace := names.Slugify(c.Storage.RegistryNamespace)
	if namespace == "" {
		namespace = DefaultRegistryNamespace
	}
	name := names.Slugify(c.Storage.RegistryName)
	if name == "" {
		name = DefaultRegistryName
	}
	return fmt.Sprintf("%s.%s.svc.cluster.local:%d", name, namespace, c.Storage.RegistryPort)
}

func (c *Config) RegistryServiceName() string {
	name := names.Slugify(c.Storage.RegistryName)
	if name == "" {
		return DefaultRegistryName
	}
	return name
}

func (c *Config) RegistryNamespace() string {
	namespace := names.Slugify(c.Storage.RegistryNamespace)
	if namespace == "" {
		return DefaultRegistryNamespace
	}
	return namespace
}

func (c *Config) AppBaseDomain() string {
	if c == nil {
		return ""
	}

	zone := strings.TrimSpace(c.DNS.Zone)
	if zone != "" && !looksLikeCloudflareZoneID(zone) {
		return strings.TrimPrefix(zone, "*.")
	}

	apiHostname := strings.TrimSpace(c.DNS.APIHostname)
	if parts := strings.SplitN(apiHostname, ".", 2); len(parts) == 2 {
		return strings.TrimSpace(parts[1])
	}
	return ""
}

func (c *Config) AppWildcardHostname() string {
	base := strings.TrimSpace(c.AppBaseDomain())
	if base == "" {
		return ""
	}
	return "*." + base
}

func (c *Config) Secrets() SecretPaths {
	root := normalizeSecretPath(c.Infisical.PathRoot)
	cluster := names.Slugify(c.Cluster.Name)

	return SecretPaths{
		OperatorShared:   normalizeSecretPath(filepath.ToSlash(filepath.Join(root, "operator", "shared"))),
		ClusterBootstrap: normalizeSecretPath(filepath.ToSlash(filepath.Join(root, "clusters", cluster, "bootstrap"))),
		ClusterAccess:    normalizeSecretPath(filepath.ToSlash(filepath.Join(root, "clusters", cluster, "access"))),
		ClusterRuntime:   normalizeSecretPath(filepath.ToSlash(filepath.Join(root, "clusters", cluster, "runtime"))),
	}
}

func normalizeRole(role string) string {
	role = names.Slugify(role)
	if role == "" {
		return RoleControlPlane
	}
	return RoleControlPlane
}

func normalizeSecretPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	path = strings.ReplaceAll(path, "\\", "/")
	return strings.TrimRight(path, "/")
}

func trimStringSlice(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	trimmed := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			trimmed = append(trimmed, value)
		}
	}
	if len(trimmed) == 0 {
		return nil
	}
	return trimmed
}

func defaultString(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value != "" {
		return value
	}
	return strings.TrimSpace(fallback)
}

func lookupEnvBool(key string) (bool, bool) {
	value, ok := os.LookupEnv(key)
	if !ok {
		return false, false
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		return false, false
	}
	return parsed, true
}

func looksLikeCloudflareZoneID(value string) bool {
	if len(strings.TrimSpace(value)) != 32 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

func (n NodeConfig) ProviderID() int64 {
	if n.ServerID > 0 {
		return n.ServerID
	}
	return n.InstanceID
}
