# Fault 02 — spoiler

**Symptom:** CNPG cluster `orders-db` in `faultlab-02` stuck initializing forever; its
first pod (or init job) `Pending`.

**Root cause:** `storageClass: localpath` — the class is called `local-path`. The PVC
references a StorageClass that doesn't exist, so no volume is ever provisioned, so the
pod can never schedule.

**Diagnosis path this teaches:**

1. `kubectl -n faultlab-02 get cluster orders-db` → not healthy, setting up.
2. `kubectl -n faultlab-02 get pods` → something `Pending`. Pending ≠ crashed: it means
   *the scheduler can't place it*. Different failure family than fault 01.
3. `kubectl -n faultlab-02 describe pod <pending>` → "pod has unbound immediate
   PersistentVolumeClaims".
4. Follow the chain: `kubectl -n faultlab-02 get pvc` → Pending →
   `kubectl -n faultlab-02 describe pvc <name>` → `storageclass.storage.k8s.io "localpath" not found`.
5. Cross-check reality: `kubectl get storageclass` → the real name is `local-path`.

**The twist (why there's a fix.sh):** editing the Cluster's `storageClass` in place does
NOT fix it — the PVC already exists and a PVC's storage class is immutable. You must
delete the cluster (and PVC) and recreate with the right class. `fix.sh` does exactly
that. This "the obvious edit doesn't propagate" pattern is everywhere in storage.

**Lesson:** walk the ownership chain downward (cluster → pod → pvc → storageclass) and
compare *referenced* names against *existing* names on the live cluster.

**Verify the fix:** `kubectl -n faultlab-02 wait --for=condition=Ready cluster/orders-db --timeout=300s`
