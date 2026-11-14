use super::*;

#[test]
fn the_startup_sweep_removes_only_directories_of_an_older_layout() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let root = temp.path().join("images");
    for kept in ["oci", "launch", ".capabilities"] {
        std::fs::create_dir_all(root.join(kept))?;
        std::fs::write(root.join(kept).join("entry"), b"kept")?;
    }
    for old in ["manifests", "chunks", "artifacts", "tools", "launch-v3"] {
        std::fs::create_dir_all(root.join(old).join("nested"))?;
        std::fs::write(root.join(old).join("nested").join("blob"), b"old")?;
    }
    std::fs::write(root.join("stray-file"), b"left alone")?;
    // A link out of the cache is removed as a name, never followed.
    let outside = temp.path().join("outside");
    std::fs::create_dir_all(&outside)?;
    std::fs::write(outside.join("keep"), b"outside")?;
    std::os::unix::fs::symlink(&outside, root.join("link"))?;

    let mut removed = sweep_cache_layout(&root)?;
    removed.sort();
    let expected =
        ["artifacts", "chunks", "launch-v3", "manifests", "tools"].map(|name| root.join(name));
    assert_eq!(removed, expected);
    for kept in ["oci", "launch", ".capabilities"] {
        assert!(root.join(kept).join("entry").is_file(), "{kept}");
    }
    assert!(root.join("stray-file").is_file());
    assert!(outside.join("keep").is_file());

    // A second sweep finds nothing, and a missing root is not an error.
    assert!(sweep_cache_layout(&root)?.is_empty());
    assert!(sweep_cache_layout(&temp.path().join("absent"))?.is_empty());
    Ok(())
}

#[test]
fn a_machine_config_of_another_contract_or_format_is_refused() {
    let config = |guest_contract: u32, image_format: &str| {
        serde_json::from_value::<intar_contracts::oci::MachineConfigV1>(serde_json::json!({
            "guest_contract": guest_contract,
            "image_format": image_format,
            "build_key": format!("sha256:{}", "d".repeat(64)),
            "boot": {"cmdline": "console=ttyS0"},
            "disk": {"size_bytes": 1, "chunk_size": 1, "chunks": []},
        }))
    };
    let current = intar_contracts::guest::GUEST_CONTRACT;
    let format = intar_contracts::oci::IMAGE_FORMAT;
    let Ok(good) = config(current, format) else {
        panic!("machine config fixture");
    };
    assert!(check_machine_config(&good).is_ok());
    let Ok(old_contract) = config(current - 1, format) else {
        panic!("machine config fixture");
    };
    let error = check_machine_config(&old_contract)
        .err()
        .map(|e| e.to_string());
    assert!(error.is_some_and(|e| e.starts_with("guest_contract_mismatch")));
    let Ok(other_format) = config(current, "intar-image-2") else {
        panic!("machine config fixture");
    };
    let error = check_machine_config(&other_format)
        .err()
        .map(|e| e.to_string());
    assert!(error.is_some_and(|e| e.starts_with("unsupported_artifact")));
}
