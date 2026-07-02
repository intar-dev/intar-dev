package workflow

type BootstrapRequest struct {
	ClusterName string
	ConfigPath  string
	Edit        bool
}

type StatusRequest struct {
	ConfigPath string
}

type AccessRequest struct {
	ConfigPath string
	OutputDir  string
}

type ExecRequest struct {
	ConfigPath string
	Shell      string
}

type BootstrapSecretsRequest struct {
	ConfigPath string
}

type DestroyRequest struct {
	ConfigPath string
	Force      bool
}

type GitOpsPublishRequest struct {
	ConfigPath string
}

type ScaleRequest struct {
	ConfigPath string
	Count      int
}

type UpgradeTalosRequest struct {
	ConfigPath string
	Version    string
}

type UpgradeKubernetesRequest struct {
	ConfigPath string
	Version    string
}

type EtcdSnapshotRequest struct {
	ConfigPath string
	OutputPath string
}

type EtcdRestoreRequest struct {
	ConfigPath   string
	SnapshotPath string
}
