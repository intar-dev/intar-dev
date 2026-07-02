server {
  bind = "tcp://0.0.0.0:8080"
}

defaults {
  every_seconds = 5
  timeout_seconds = 2
  kubeconfig = "/etc/kino/kubeconfig"
}

probe "hosts_file" {
  kind = "file_exists"
  path = "/etc/hosts"
}

probe "nginx_listen" {
  kind = "file_regex_capture"
  path = "/etc/nginx/nginx.conf"
  pattern = "listen\\s+80;"
}

probe "ssh_tcp" {
  kind = "port_open"
  host = "127.0.0.1"
  port = 22
  protocol = "tcp"
}

probe "api_ready" {
  kind = "k8s_pod_state"
  namespace = "default"
  selector = "app=api"
  desired_state = "condition:Ready"
}
