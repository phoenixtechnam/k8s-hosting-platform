terraform {
  required_version = ">= 1.5.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

# Look up the SSH key already registered in Hetzner Cloud
data "hcloud_ssh_key" "deploy" {
  name = var.ssh_key_name
}

resource "hcloud_server" "k3s" {
  name        = "${var.server_name}-${var.environment}"
  server_type = var.server_type
  image       = "debian-13"
  location    = var.location
  ssh_keys    = [data.hcloud_ssh_key.deploy.id]

  labels = {
    role        = "k3s-control"
    project     = "hosting-platform"
    phase       = "1"
    environment = var.environment
  }

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  # Prevent accidental destruction of the production server
  lifecycle {
    prevent_destroy = false # Set to true once in production
  }
}
