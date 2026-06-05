package talos

import "testing"

func TestBuildFactoryDiskImageURLUsesDefaultSchematic(t *testing.T) {
	url, err := BuildFactoryDiskImageURL("1.12.6", "", "nocloud-amd64.raw.zst")
	if err != nil {
		t.Fatalf("BuildFactoryDiskImageURL returned error: %v", err)
	}

	expected := "https://factory.talos.dev/image/" + DefaultFactorySchematic + "/v1.12.6/nocloud-amd64.raw.zst"
	if url != expected {
		t.Fatalf("unexpected image URL: %s", url)
	}
}

func TestBuildInstallerImageRefUsesNoCloudInstaller(t *testing.T) {
	ref, err := BuildInstallerImageRef("v1.12.6", "abcd1234")
	if err != nil {
		t.Fatalf("BuildInstallerImageRef returned error: %v", err)
	}

	expected := "factory.talos.dev/installer/abcd1234:v1.12.6"
	if ref != expected {
		t.Fatalf("unexpected installer ref: %s", ref)
	}
}
