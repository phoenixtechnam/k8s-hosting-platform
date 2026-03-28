output "server_ip" {
  description = "Public IPv4 address of the k3s server"
  value       = hcloud_server.k3s.ipv4_address
}

output "server_ipv6" {
  description = "Public IPv6 address of the k3s server"
  value       = hcloud_server.k3s.ipv6_address
}

output "server_id" {
  description = "Hetzner Cloud server ID"
  value       = hcloud_server.k3s.id
}

output "server_name" {
  description = "Server name"
  value       = hcloud_server.k3s.name
}

output "server_status" {
  description = "Current server status"
  value       = hcloud_server.k3s.status
}

output "environment" {
  description = "Deployment environment"
  value       = var.environment
}
