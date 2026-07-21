# Hint 1: Where do I even start with talosctl?

`talosctl` talks to the Talos API on the nodes — your talosconfig was set up by the create
script. Try `talosctl --help`, and note most commands take `-n `. Find your node
IPs with `talosctl config info` or `kubectl get nodes -o wide`. In this docker cluster the
control-plane node is typically `10.5.0.2`.
