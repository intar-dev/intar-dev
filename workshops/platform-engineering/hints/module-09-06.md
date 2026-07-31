# Full solution

```bash
WORKSHOP="$(git rev-parse --show-toplevel)"
cd ~/cloudbox-platform   # your Gitea clone

cp gitops/catalog/knative-eventing.yaml gitops/apps/
cp gitops/catalog/picture-pipeline.yaml gitops/apps/
git add . && git commit -m "module 09: eventing + picture pipeline" && git push

kubectl -n pipeline get broker,trigger,ksvc          # wait for Ready True across the board

kubectl -n pipeline get pods -w &                    # the watcher
# In Intar: Workspace applications → Cloudbox Console → Gallery; upload a photo and watch 0 → 1 → 0 twice
kill %1

export AWS_ACCESS_KEY_ID=cloudbox AWS_SECRET_ACCESS_KEY=cloudbox123 AWS_REGION=us-east-1
aws --endpoint-url http://localhost:30900 s3 ls s3://images/ --recursive   # originals/ thumbs/ meta/

kubectl -n pipeline logs -l serving.knative.dev/service=resizer -c user-container --tail=20   # ce-* headers

cd "$WORKSHOP/lab/09-capstone" && ./verify.sh
```

(No browser? `solve.sh` uploads a test PNG with plain `curl` through the portal — the
gallery form is just a multipart POST.)
