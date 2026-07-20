The new concept is Knative Eventing: a Broker and Triggers — the open-source shape of the S3-events → SQS → Lambda pattern everyone knows from AWS.

Walk the flow left to right: the Gallery page posts the photo to the uploader (a Knative service that itself cold-starts to receive it). The uploader writes the original to the images bucket in RustFS, then emits a CloudEvent — type dev.cloudbox.image.uploaded — to the Broker. The Broker consults its Triggers; one filters on exactly that type and subscribes the resizer. The resizer — which is NOT RUNNING — wakes from zero, fetches the original, writes a thumbnail and a metadata JSON (dimensions, dominant color), and goes back to sleep.

The architectural point on the slide: the uploader doesn't know the resizer exists. It emits a fact; the Broker routes it to whoever subscribed. Adding a second consumer (a virus scanner, an ML tagger) would be one more Trigger — no uploader change. That decoupling is the whole point of event-driven architecture, and today it runs inside one Intar workspace, readable end to end.

Demystifier worth saying: a CloudEvent is just an HTTP POST with five ce-* headers — the lab has them read those headers in the resizer's logs.
